import { JOB_STATUS, meshFromEnv, paidFetch } from "@agentmesh/sdk";
import { explorerTxUrl, formatUsd, usd } from "@agentmesh/shared";

/** AgentMesh demo against Arc Testnet (chain id 5042002).
 *
 *  Prerequisites:
 *   1. Contracts deployed — Deploy.s.sol writes deployments/arc-testnet.json:
 *        cd contracts && AGENTMESH_NETWORK=arc-testnet \
 *          USDC_ADDRESS=0x3600000000000000000000000000000000000000 \
 *          DISPUTE_WINDOW=3600 forge script script/Deploy.s.sol \
 *          --rpc-url $ARC_TESTNET_RPC_URL --broadcast --private-key $DEPLOYER_PRIVATE_KEY
 *   2. Buyer + seller wallets funded with testnet USDC from faucet.circle.com
 *      (USDC is also the gas token on Arc — one asset funds everything;
 *      faucet dispenses ~1 USDC/day, hence the small default amounts here).
 *   3. Seller + watcher running:
 *        AGENTMESH_NETWORK=arc-testnet pnpm dev:seller
 *        AGENTMESH_NETWORK=arc-testnet pnpm dev:watcher
 *
 *  Env for this script: AGENTMESH_NETWORK=arc-testnet plus a buyer wallet —
 *  either BUYER_PRIVATE_KEY (EOA) or WALLET_PROVIDER=circle with
 *  CIRCLE_BUYER_WALLET_ID/CIRCLE_BUYER_WALLET_ADDRESS (see walletFromEnv).
 *  Optional: SELLER_URL, MICRO_CALLS, ESCROW_USD, ESCROW_WAIT_MS. */

const MICRO_CALLS = Number(process.env.MICRO_CALLS ?? 5);
const ESCROW_USD = process.env.ESCROW_USD ?? "0.25";
// Must exceed the deployed DISPUTE_WINDOW (3600s per DEPLOYMENT.md) plus
// margin for watcher poll latency, or this always times out before the
// watcher is even allowed to auto-release.
const ESCROW_WAIT_MS = Number(process.env.ESCROW_WAIT_MS ?? 70 * 60_000);
const SELLER_URL = process.env.SELLER_URL ?? "http://localhost:4021";

const { client: mesh } = meshFromEnv("BUYER_PRIVATE_KEY");
const me = await mesh.wallet.getAddress();
const link = (tx: string) => explorerTxUrl("arc-testnet", tx);

console.log(`BuyerBot ${me} on Arc Testnet — balance ${formatUsd(await mesh.usdcBalance())}`);

if (!(await mesh.isRegistered("buyerbot"))) {
  const tx = await mesh.registerAgent("buyerbot", "", "");
  console.log(`registered buyerbot.agent.arc → ${link(tx)}`);
}
const { wallet: sellerAddr, card } = await mesh.resolveAgent("databot");
console.log(`databot.agent.arc → ${sellerAddr} (${card.endpoint})`);

console.log(`\nstreaming ${MICRO_CALLS} x402 micropayments…`);
let total = 0n;
for (let i = 0; i < MICRO_CALLS; i++) {
  const { response, paid } = await paidFetch(
    mesh,
    `${SELLER_URL}/api/${i % 2 === 0 ? "headline" : "datapoint"}`,
    { maxAmount: usd("0.01") },
  );
  if (response.status !== 200 || !paid) throw new Error(`x402 call ${i} failed (HTTP ${response.status})`);
  total += paid.amount;
  console.log(`  ${i + 1}/${MICRO_CALLS} paid ${formatUsd(paid.amount)} → ${link(paid.txHash)}`);
}
console.log(`✓ ${MICRO_CALLS} micropayments, total ${formatUsd(total)}`);

console.log(`\ncreating ${formatUsd(usd(ESCROW_USD))} escrow job…`);
const { jobId, txHash } = await mesh.createEscrowJob({
  seller: sellerAddr,
  amount: usd(ESCROW_USD),
  deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
  spec: "Market report on Arc Testnet",
});
console.log(`job #${jobId} funded → ${link(txHash)}`);

// Bounded wait with linear backoff — dispute window on testnet is real
// (3600s default), so cap the wait instead of polling forever.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const startedAt = Date.now();
let pollMs = 4_000;
for (;;) {
  if (Date.now() - startedAt > ESCROW_WAIT_MS) {
    throw new Error(
      `escrow #${jobId} still open after ${ESCROW_WAIT_MS}ms — check the watcher and dispute window`,
    );
  }
  const job = await mesh.getJob(jobId);
  const status = JOB_STATUS[job.status];
  console.log(`  job #${jobId}: ${status}`);
  if (status === "Released") {
    console.log("✓ escrow released to databot — compliance-screened, watcher-automated");
    break;
  }
  if (status === "Refunded" || status === "Disputed") break;
  await sleep(pollMs);
  pollMs = Math.min(pollMs + 2_000, 30_000);
}
console.log(
  `\nfinal balances — buyer ${formatUsd(await mesh.usdcBalance())}, seller ${formatUsd(await mesh.usdcBalance(sellerAddr))}`,
);
