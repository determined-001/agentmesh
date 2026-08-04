import { JOB_STATUS, meshFromEnv } from "@agentmesh/sdk";
import { explorerTxUrl, formatUsd, usd } from "@agentmesh/shared";

/** Exercises the dispute → arbiter path on Arc Testnet: buyer funds a job,
 *  seller (already running) auto-delivers, buyer disputes within the window,
 *  watcher (arbiter) resolves in the seller's favor.
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

console.log(`\ncreating ${formatUsd(usd(ESCROW_USD))} escrow job…`);
const { jobId, txHash } = await buyerMesh.createEscrowJob({
  seller: sellerAddr,
  amount: usd(ESCROW_USD),
  deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
  spec: "Dispute-path smoke test",
});
console.log(`job #${jobId} funded → ${link(txHash)}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const startedAt = Date.now();
let pollMs = 4_000;
for (;;) {
  if (Date.now() - startedAt > DELIVER_WAIT_MS) {
    throw new Error(`job #${jobId} not delivered after ${DELIVER_WAIT_MS}ms — is the seller-agent running?`);
  }
  const job = await buyerMesh.getJob(jobId);
  const status = JOB_STATUS[job.status];
  console.log(`  job #${jobId}: ${status}`);
  if (status === "Delivered") break;
  await sleep(pollMs);
  pollMs = Math.min(pollMs + 2_000, 15_000);
}

console.log("\nbuyer disputing delivery…");
const disputeTx = await buyerMesh.disputeJob(jobId);
console.log(`disputed → ${link(disputeTx)}`);

const job = await buyerMesh.getJob(jobId);
console.log(`  job #${jobId}: ${JOB_STATUS[job.status]}`);

console.log("\nwatcher (arbiter) resolving in the seller's favor…");
const resolveTx = await watcherMesh.resolveDispute(jobId, true);
console.log(`resolved → ${link(resolveTx)}`);

const final = await buyerMesh.getJob(jobId);
console.log(`\n✓ job #${jobId} final status: ${JOB_STATUS[final.status]}`);
console.log(`seller balance ${formatUsd(await buyerMesh.usdcBalance(sellerAddr))}`);
