import { JOB_STATUS, meshFromEnv } from "@agentmesh/sdk";
import { explorerTxUrl, formatUsd, usd } from "@agentmesh/shared";

/** Exercises the blocked-seller → refundBlocked path on Arc Testnet: watcher
 *  blocks the seller mid-flight (simulating a compliance hit after prior
 *  screening), seller (already running) still delivers — deliver() has no
 *  gate check — then refundBlocked() returns funds to the buyer since
 *  release() would revert ComplianceBlocked. Unblocks the seller again
 *  afterward so it doesn't stay blocked for later runs/soak.
 *
 *  Env: AGENTMESH_NETWORK=arc-testnet plus buyer + watcher wallets (either
 *  BUYER_PRIVATE_KEY/WATCHER_PRIVATE_KEY, or WALLET_PROVIDER=circle with the
 *  per-role CIRCLE_*_WALLET_ID/ADDRESS vars). Optional: SELLER_URL,
 *  ESCROW_USD, DELIVER_WAIT_MS. */

const ESCROW_USD = process.env.ESCROW_USD ?? "0.05";
const DELIVER_WAIT_MS = Number(process.env.DELIVER_WAIT_MS ?? 5 * 60_000);

const { client: buyerMesh } = meshFromEnv("BUYER_PRIVATE_KEY");
const { client: watcherMesh } = meshFromEnv("WATCHER_PRIVATE_KEY");
const link = (tx: string) => explorerTxUrl("arc-testnet", tx);

const { wallet: sellerAddr } = await buyerMesh.resolveAgent("databot");
console.log(`databot.agent.arc → ${sellerAddr}`);

console.log("\nblocking seller (simulated compliance hit)…");
const blockTx = await watcherMesh.setAllowed(sellerAddr, false, "testnet-blocked-smoke");
console.log(`blocked → ${link(blockTx)}`);

let ok = false;
try {
  console.log(`\ncreating ${formatUsd(usd(ESCROW_USD))} escrow job…`);
  const { jobId, txHash } = await buyerMesh.createEscrowJob({
    seller: sellerAddr,
    amount: usd(ESCROW_USD),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
    spec: "Blocked-seller refundBlocked smoke test",
  });
  console.log(`job #${jobId} funded → ${link(txHash)}`);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const startedAt = Date.now();
  let pollMs = 4_000;
  for (;;) {
    if (Date.now() - startedAt > DELIVER_WAIT_MS) {
      throw new Error(
        `job #${jobId} not delivered after ${DELIVER_WAIT_MS}ms — is the seller-agent running?`,
      );
    }
    const job = await buyerMesh.getJob(jobId);
    const status = JOB_STATUS[job.status];
    console.log(`  job #${jobId}: ${status}`);
    if (status === "Delivered") break;
    await sleep(pollMs);
    pollMs = Math.min(pollMs + 2_000, 15_000);
  }

  console.log("\nclaiming refundBlocked (permissionless — anyone may call this)…");
  const refundTx = await buyerMesh.refundBlocked(jobId);
  console.log(`refunded → ${link(refundTx)}`);

  const final = await buyerMesh.getJob(jobId);
  console.log(`\n✓ job #${jobId} final status: ${JOB_STATUS[final.status]}`);
  console.log(`buyer balance ${formatUsd(await buyerMesh.usdcBalance())}`);
  ok = true;
} finally {
  console.log("\nunblocking seller (restoring prior verdict)…");
  const unblockTx = await watcherMesh.setAllowed(sellerAddr, true, "testnet-blocked-smoke:restore");
  console.log(`unblocked → ${link(unblockTx)}`);
}

if (!ok) process.exit(1);
