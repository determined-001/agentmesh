import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentMeshClient, fetchDeliverable, JOB_STATUS, paidFetch, ViemEoaWallet } from "@agentmesh/sdk";
import { type Deployment, formatUsd, localAnvil, usd } from "@agentmesh/shared";
import type { Hex } from "viem";

/** End-to-end AgentMesh demo on a local anvil chain.
 *  Boots anvil, deploys the stack, starts the DataAgent (seller) and the
 *  watcher, then drives BuyerBot through the full lifecycle:
 *  naming → x402 micropayments (50+) → screened escrow → delivery →
 *  watcher auto-release → dispute/refund branch. */

const ROOT = join(import.meta.dirname, "../..");
const RPC = "http://127.0.0.1:8545";
const DISPUTE_WINDOW = 15; // seconds — short for the demo
const SELLER_PORT = 4021;

// anvil's default funded accounts
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex, // arbiter + watcher + screener
  buyer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex,
  seller: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex,
};

const children: ChildProcess[] = [];
function cleanup() {
  for (const c of children) {
    if (c.pid === undefined) continue;
    try {
      // Services are spawned detached in their own process group so pnpm's
      // grandchildren (tsx) die with the wrapper.
      process.kill(-c.pid, "SIGTERM");
    } catch {
      c.kill("SIGTERM");
    }
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch {
      // keep waiting
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function banner(msg: string) {
  console.log(`\n━━━ ${msg} ━━━`);
}

// ---------- 1. chain + deploy ----------
banner("1/7 boot anvil + deploy AgentMesh contracts");
// --block-time 1: mine every second so block.timestamp advances even without
// new transactions (the dispute-window check reads on-chain time).
const anvil = spawn("anvil", ["--silent", "--block-time", "1"], { stdio: "ignore" });
children.push(anvil);
await waitFor("anvil rpc", async () => {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  return res.ok ? true : undefined;
});

const deploy = spawnSync(
  "forge",
  ["script", "script/Deploy.s.sol", "--rpc-url", RPC, "--broadcast", "--private-key", KEYS.deployer],
  {
    cwd: join(ROOT, "contracts"),
    env: { ...process.env, DISPUTE_WINDOW: String(DISPUTE_WINDOW) },
    encoding: "utf8",
  },
);
if (deploy.status !== 0) {
  console.error(deploy.stdout, deploy.stderr);
  throw new Error("deploy failed");
}
// Deploy.s.sol writes the machine-readable artifact via vm.writeJson — no
// stdout scraping.
const deployment = JSON.parse(readFileSync(join(ROOT, "deployments", "local.json"), "utf8")) as Deployment;
if (deployment.disputeWindow !== DISPUTE_WINDOW) {
  throw new Error(`artifact disputeWindow ${deployment.disputeWindow} != expected ${DISPUTE_WINDOW}`);
}
console.log(deployment);

const mk = (key: Hex) => new AgentMeshClient(localAnvil, deployment, new ViemEoaWallet(key, localAnvil));
const deployerMesh = mk(KEYS.deployer);
const buyerMesh = mk(KEYS.buyer);
const buyerAddr = await buyerMesh.wallet.getAddress();
const sellerWallet = new ViemEoaWallet(KEYS.seller, localAnvil);
const sellerAddr = await sellerWallet.getAddress();

// Fund BuyerBot with mock USDC (on Arc Testnet this comes from the Circle faucet).
await deployerMesh.wallet.writeContract({
  address: deployment.usdc,
  abi: [
    {
      type: "function",
      name: "mint",
      inputs: [{ type: "address" }, { type: "uint256" }],
      outputs: [],
      stateMutability: "nonpayable",
    },
  ],
  functionName: "mint",
  args: [buyerAddr, usd("1000")],
});
console.log(`funded BuyerBot ${buyerAddr} with $1000 USDC`);

// ---------- 2. start services ----------
banner("2/7 start DataAgent (seller) + watcher");
const svcEnv = {
  ...process.env,
  AGENTMESH_NETWORK: "local",
  DISPUTE_WINDOW: String(DISPUTE_WINDOW),
  POLL_MS: "1000",
};
const seller = spawn("pnpm", ["--filter", "@agentmesh/seller-agent", "start"], {
  cwd: ROOT,
  env: { ...svcEnv, SELLER_PRIVATE_KEY: KEYS.seller, PORT: String(SELLER_PORT) },
  stdio: "inherit",
  detached: true,
});
const watcher = spawn("pnpm", ["--filter", "@agentmesh/watcher", "start"], {
  cwd: ROOT,
  env: { ...svcEnv, WATCHER_PRIVATE_KEY: KEYS.deployer },
  stdio: "inherit",
  detached: true,
});
children.push(seller, watcher);

await waitFor("databot registration", async () =>
  (await buyerMesh.isRegistered("databot")) ? true : undefined,
);

// ---------- 3. naming ----------
banner("3/7 register BuyerBot name");
await buyerMesh.registerAgent("buyerbot", "", "");
const resolved = await buyerMesh.resolveAgent("databot");
console.log(`buyerbot.agent.arc → ${buyerAddr}`);
console.log(`databot.agent.arc  → ${resolved.wallet} (endpoint ${resolved.card.endpoint})`);
if (resolved.wallet.toLowerCase() !== sellerAddr.toLowerCase()) throw new Error("resolution mismatch");

// ---------- 4. x402 micropayments ----------
banner("4/7 stream 50 x402 micropayments (sub-cent, per-call)");
const sellerStart = await buyerMesh.usdcBalance(sellerAddr);
let microTotal = 0n;
let microCount = 0;
for (let i = 0; i < 50; i++) {
  const url = `http://localhost:${SELLER_PORT}/api/${i % 2 === 0 ? "headline" : "datapoint"}`;
  // The payee is whatever the registry says databot settles to — never what
  // the 402 response asks for.
  const { response, paid } = await paidFetch(buyerMesh, url, {
    maxAmount: usd("0.01"),
    payeePolicy: { expect: sellerAddr },
  });
  if (response.status !== 200 || !paid) throw new Error(`x402 call ${i} failed: HTTP ${response.status}`);
  microTotal += paid.amount;
  microCount++;
  if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/50 paid calls, total spent ${formatUsd(microTotal)}`);
}
const sellerAfterMicro = await buyerMesh.usdcBalance(sellerAddr);
if (sellerAfterMicro - sellerStart !== microTotal) throw new Error("micropayment accounting mismatch");
console.log(`✓ ${microCount} paid API calls settled on-chain for ${formatUsd(microTotal)} total`);

// ---------- 5. escrow happy path ----------
banner("5/7 escrow: $5 job → screening → delivery → watcher auto-release");
const { jobId } = await buyerMesh.createEscrowJob({
  seller: sellerAddr,
  amount: usd("5"),
  deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  spec: "Market report: Arc settlement volume, 3 headlines, 1 datapoint summary",
});
console.log(`job #${jobId} funded with $5`);

await waitFor(`job #${jobId} delivery`, async () => {
  const j = await buyerMesh.getJob(jobId);
  return JOB_STATUS[j.status] === "Delivered" ? true : undefined;
});
console.log(`job #${jobId} delivered by databot — dispute window ${DISPUTE_WINDOW}s`);
const allowed = await buyerMesh.isAllowed(sellerAddr);
console.log(`compliance screen for databot: ${allowed ? "ALLOWED ✓" : "BLOCKED ✗"}`);

await waitFor(`job #${jobId} auto-release`, async () => {
  const j = await buyerMesh.getJob(jobId);
  return JOB_STATUS[j.status] === "Released" ? true : undefined;
});
const sellerAfterEscrow = await buyerMesh.usdcBalance(sellerAddr);
if (sellerAfterEscrow - sellerAfterMicro !== usd("5")) throw new Error("escrow payout mismatch");
console.log(`✓ watcher auto-released $5 to databot after dispute window`);

// deliverable is fetchable by the buyer, who signs to prove it owns the job
const deliverable = await fetchDeliverable(buyerMesh, `http://localhost:${SELLER_PORT}`, jobId);
console.log(`✓ deliverable retrieved: ${deliverable.report.slice(0, 80)}…`);

// ...and by nobody else: an unauthenticated read is refused.
const anon = await fetch(`http://localhost:${SELLER_PORT}/jobs/${jobId}/deliverable`);
if (anon.status !== 401) throw new Error(`deliverable served without auth (HTTP ${anon.status})`);
console.log(`✓ unauthenticated deliverable read refused (HTTP ${anon.status})`);

// ---------- 6. dispute branch ----------
banner("6/7 dispute branch: buyer disputes → arbiter refunds");
const buyerBeforeDispute = await buyerMesh.usdcBalance(buyerAddr);
const { jobId: jobId2 } = await buyerMesh.createEscrowJob({
  seller: sellerAddr,
  amount: usd("2"),
  deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  spec: "Second report (will be disputed)",
});
await waitFor(`job #${jobId2} delivery`, async () => {
  const j = await buyerMesh.getJob(jobId2);
  return JOB_STATUS[j.status] === "Delivered" ? true : undefined;
});
await buyerMesh.disputeJob(jobId2);
console.log(`job #${jobId2} disputed by BuyerBot inside the window`);
await deployerMesh.resolveDispute(jobId2, false);
const buyerAfterRefund = await buyerMesh.usdcBalance(buyerAddr);
if (buyerBeforeDispute !== buyerAfterRefund) throw new Error("refund accounting mismatch");
console.log(`✓ arbiter refunded $2 to BuyerBot (net dispute cost: $0)`);

// ---------- 7. summary ----------
banner("7/7 summary");
const buyerFinal = await buyerMesh.usdcBalance(buyerAddr);
const sellerFinal = await buyerMesh.usdcBalance(sellerAddr);
console.log(`BuyerBot:  started $1000 → ${formatUsd(buyerFinal)}`);
console.log(`DataAgent: started $0    → ${formatUsd(sellerFinal)} (${microCount} micropayments + $5 escrow)`);
console.log(`On-chain settlement events: ${microCount + 8}+ transactions, all in USDC on Arc-style rails`);
console.log("\nAgentMesh e2e demo PASSED ✓");
process.exit(0);
