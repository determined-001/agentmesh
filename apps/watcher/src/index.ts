import { JOB_STATUS, meshFromEnv } from "@agentmesh/sdk";
import { formatUsd } from "@agentmesh/shared";
import { type Address, parseAbiItem } from "viem";

/** AgentMesh watcher — the automation layer.
 *  1. Screens sellers on JobCreated and pushes verdicts to the ComplianceGate
 *     (Circle Compliance Engine when configured; local denylist fallback,
 *     clearly labeled).
 *  2. Auto-releases escrow once the dispute window closes after delivery.
 *  3. Refunds buyers when a deadline passes without delivery.
 *  Runs with the screener/arbiter key (WATCHER_PRIVATE_KEY). */

const POLL_MS = Number(process.env.POLL_MS ?? 2000);
const DENYLIST = new Set(
  (process.env.DENYLIST ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean),
);

const { client: mesh } = meshFromEnv("WATCHER_PRIVATE_KEY");
const me = await mesh.wallet.getAddress();
const disputeWindow = BigInt(mesh.deployment.disputeWindow);
console.log(`[watcher] running as ${me}, dispute window ${disputeWindow}s`);
if (process.env.CIRCLE_COMPLIANCE_API_KEY) {
  console.log("[watcher] screening mode: Circle Compliance Engine");
} else {
  console.log("[watcher] screening mode: LOCAL ALLOWLIST FALLBACK (Circle Compliance Engine key not set)");
}

/** Screen an address. Uses Circle Compliance Engine's address screening API when
 *  CIRCLE_COMPLIANCE_API_KEY is set; otherwise a local denylist (labeled fallback). */
async function screen(address: Address): Promise<{ allowed: boolean; reason: string }> {
  const apiKey = process.env.CIRCLE_COMPLIANCE_API_KEY;
  if (apiKey) {
    try {
      const res = await fetch("https://api.circle.com/v1/w3s/compliance/screening/addresses", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          address,
          chain: process.env.CIRCLE_COMPLIANCE_CHAIN ?? "ETH",
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { data?: { result?: string } };
        const approved = data.data?.result === "APPROVED";
        return { allowed: approved, reason: `circle-compliance-engine:${data.data?.result}` };
      }
      console.error(`[watcher] Compliance Engine HTTP ${res.status}; falling back to local list`);
    } catch (err) {
      console.error("[watcher] Compliance Engine error; falling back:", (err as Error).message);
    }
  }
  const denied = DENYLIST.has(address.toLowerCase());
  return { allowed: !denied, reason: denied ? "local-denylist:hit" : "local-allowlist:clean" };
}

const jobCreatedEvent = parseAbiItem(
  "event JobCreated(uint256 indexed jobId, address indexed buyer, address indexed seller, uint256 amount, uint64 deadline, bytes32 specHash)",
);
const jobDeliveredEvent = parseAbiItem("event JobDelivered(uint256 indexed jobId, bytes32 deliverableHash)");

const screened = new Set<string>();
const tracked = new Set<string>(); // job ids we may still need to act on
let lastBlock = 0n;

async function tick() {
  try {
    const latest = await mesh.publicClient.getBlockNumber();
    if (lastBlock === 0n) lastBlock = latest > 100n ? latest - 100n : 0n;

    if (latest >= lastBlock) {
      const [created, delivered] = await Promise.all([
        mesh.publicClient.getLogs({
          address: mesh.deployment.agentEscrow,
          event: jobCreatedEvent,
          fromBlock: lastBlock,
          toBlock: latest,
        }),
        mesh.publicClient.getLogs({
          address: mesh.deployment.agentEscrow,
          event: jobDeliveredEvent,
          fromBlock: lastBlock,
          toBlock: latest,
        }),
      ]);
      lastBlock = latest + 1n;

      for (const log of created) {
        const jobId = log.args.jobId!.toString();
        const seller = log.args.seller!;
        tracked.add(jobId);
        console.log(`[watcher] job #${jobId} created: ${formatUsd(log.args.amount!)} for ${seller}`);
        if (!screened.has(seller.toLowerCase())) {
          screened.add(seller.toLowerCase());
          const verdict = await screen(seller);
          const tx = await mesh.setAllowed(seller, verdict.allowed, verdict.reason);
          console.log(
            `[watcher] screened ${seller}: ${verdict.allowed ? "ALLOWED" : "BLOCKED"} (${verdict.reason}) tx ${tx}`,
          );
        }
      }
      for (const log of delivered) {
        tracked.add(log.args.jobId!.toString());
        console.log(`[watcher] job #${log.args.jobId} delivered — dispute window open`);
      }
    }

    // Act on tracked jobs.
    const now = BigInt(Math.floor(Date.now() / 1000));
    for (const id of [...tracked]) {
      const jobId = BigInt(id);
      const job = await mesh.getJob(jobId);
      const status = JOB_STATUS[job.status];
      if (status === "Released" || status === "Refunded" || status === "None") {
        tracked.delete(id);
        continue;
      }
      if (status === "Delivered" && now >= job.deliveredAt + disputeWindow) {
        try {
          const tx = await mesh.releaseEscrow(jobId);
          console.log(
            `[watcher] job #${id} AUTO-RELEASED ${formatUsd(job.amount)} → ${job.seller} (tx ${tx})`,
          );
          tracked.delete(id);
        } catch (err) {
          console.error(`[watcher] release #${id} failed:`, (err as Error).message);
        }
      } else if (status === "Funded" && now > job.deadline) {
        try {
          const tx = await mesh.refundJob(jobId);
          console.log(`[watcher] job #${id} REFUNDED ${formatUsd(job.amount)} → ${job.buyer} (tx ${tx})`);
          tracked.delete(id);
        } catch (err) {
          console.error(`[watcher] refund #${id} failed:`, (err as Error).message);
        }
      }
    }
  } catch (err) {
    console.error("[watcher] tick error:", (err as Error).message);
  }
}

setInterval(tick, POLL_MS);
console.log(`[watcher] polling every ${POLL_MS}ms`);
