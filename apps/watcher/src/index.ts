import { createServer } from "node:http";
import { JOB_STATUS, meshFromEnv } from "@agentmesh/sdk";
import { formatUsd } from "@agentmesh/shared";
import { createLogger } from "@agentmesh/shared/logger";
import { type Address, parseAbiItem } from "viem";
import { WatcherStore } from "./store.js";

/** AgentMesh watcher — the automation layer.
 *  1. Screens sellers on JobCreated and pushes verdicts to the ComplianceGate
 *     (Circle Compliance Engine when configured; local denylist fallback,
 *     clearly labeled).
 *  2. Auto-releases escrow once the dispute window closes after delivery.
 *  3. Refunds buyers when a deadline passes without delivery.
 *  Runs with the screener/arbiter key (WATCHER_PRIVATE_KEY). */

const log = createLogger("watcher");

const POLL_MS = Number(process.env.POLL_MS ?? 2000);
const HEALTH_PORT = Number(process.env.WATCHER_HEALTH_PORT ?? 4031);
// Caps eth_getLogs range per tick so a run of RPC failures can't snowball the
// unprocessed range past whatever limit the RPC enforces — each tick makes
// bounded progress instead of retrying an ever-growing range forever.
const MAX_BLOCK_RANGE = BigInt(process.env.MAX_BLOCK_RANGE ?? 500);
const DENYLIST = new Set(
  (process.env.DENYLIST ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean),
);

const { client: mesh } = meshFromEnv("WATCHER_PRIVATE_KEY");
const me = await mesh.wallet.getAddress();
const disputeWindow = BigInt(mesh.deployment.disputeWindow);
// Scoped to escrow address + genesis hash so a chain reset with deterministic
// addresses (fresh anvil) can't resurrect stale tracking state.
const genesis = (await mesh.publicClient.getBlock({ blockNumber: 0n })).hash;
const store = new WatcherStore(
  process.env.WATCHER_DB ?? "data/watcher.sqlite",
  `${mesh.deployment.agentEscrow}|${genesis}`,
);

log.info({ wallet: me, disputeWindow: Number(disputeWindow) }, "watcher starting");
log.info(
  process.env.CIRCLE_COMPLIANCE_API_KEY
    ? { mode: "circle-compliance-engine" }
    : { mode: "local-denylist-fallback" },
  "screening mode",
);

/** Screen an address. Uses Circle Compliance Engine when configured; local
 *  denylist otherwise. Returns null on screening-provider failure — FAIL
 *  CLOSED: no verdict is pushed, the seller stays unscreened (default-deny on
 *  the gate), and we retry with backoff. An outage must never allow releases. */
async function screen(address: Address): Promise<{ allowed: boolean; reason: string } | null> {
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
      if (!res.ok) {
        log.error({ address, status: res.status }, "compliance engine HTTP error — failing closed");
        return null;
      }
      const data = (await res.json()) as { data?: { result?: string } };
      const approved = data.data?.result === "APPROVED";
      return { allowed: approved, reason: `circle-compliance-engine:${data.data?.result}` };
    } catch (err) {
      log.error({ address, err: (err as Error).message }, "compliance engine unreachable — failing closed");
      return null;
    }
  }
  const denied = DENYLIST.has(address.toLowerCase());
  return { allowed: !denied, reason: denied ? "local-denylist:hit" : "local-allowlist:clean" };
}

// Screening retry backoff (in-memory; retry timing need not survive restarts).
const screenAttempts = new Map<string, { attempts: number; nextTryAt: number }>();

async function screenSeller(seller: Address): Promise<void> {
  const key = seller.toLowerCase();
  if (store.isScreened(key)) return;
  const backoff = screenAttempts.get(key);
  if (backoff && Date.now() < backoff.nextTryAt) return;

  const verdict = await screen(seller);
  if (verdict === null) {
    const attempts = (backoff?.attempts ?? 0) + 1;
    const delay = Math.min(POLL_MS * 2 ** attempts, 300_000);
    screenAttempts.set(key, { attempts, nextTryAt: Date.now() + delay });
    log.warn({ seller, attempts, retryInMs: delay }, "screening failed, will retry");
    return;
  }
  const tx = await mesh.setAllowed(seller, verdict.allowed, verdict.reason);
  store.markScreened(key, verdict.allowed);
  screenAttempts.delete(key);
  log.info({ seller, allowed: verdict.allowed, reason: verdict.reason, tx }, "seller screened");
}

const jobCreatedEvent = parseAbiItem(
  "event JobCreated(uint256 indexed jobId, address indexed buyer, address indexed seller, uint256 amount, uint64 deadline, bytes32 specHash)",
);
const jobDeliveredEvent = parseAbiItem("event JobDelivered(uint256 indexed jobId, bytes32 deliverableHash)");

let lastBlock = store.getCursor() ?? 0n;
let lastTickAt = 0;

async function tick() {
  try {
    const latest = await mesh.publicClient.getBlockNumber();
    if (lastBlock === 0n) lastBlock = latest > 100n ? latest - 100n : 0n;

    if (latest >= lastBlock) {
      const toBlock = latest - lastBlock > MAX_BLOCK_RANGE ? lastBlock + MAX_BLOCK_RANGE : latest;
      const [created, delivered] = await Promise.all([
        mesh.publicClient.getLogs({
          address: mesh.deployment.agentEscrow,
          event: jobCreatedEvent,
          fromBlock: lastBlock,
          toBlock,
        }),
        mesh.publicClient.getLogs({
          address: mesh.deployment.agentEscrow,
          event: jobDeliveredEvent,
          fromBlock: lastBlock,
          toBlock,
        }),
      ]);
      lastBlock = toBlock + 1n;
      store.setCursor(lastBlock);

      for (const logEntry of created) {
        const jobId = logEntry.args.jobId?.toString();
        const seller = logEntry.args.seller;
        if (!jobId || !seller) continue;
        store.track(jobId);
        log.info({ jobId, amount: formatUsd(logEntry.args.amount ?? 0n), seller }, "job created");
      }
      for (const logEntry of delivered) {
        const jobId = logEntry.args.jobId?.toString();
        if (!jobId) continue;
        store.track(jobId);
        log.info({ jobId }, "job delivered — dispute window open");
      }
    }

    // Act on tracked jobs (persisted — restarts resume exactly here).
    const now = BigInt(Math.floor(Date.now() / 1000));
    for (const id of store.trackedJobs()) {
      const jobId = BigInt(id);
      const job = await mesh.getJob(jobId);
      const status = JOB_STATUS[job.status];
      if (status === "Released" || status === "Refunded" || status === "None") {
        store.untrack(id);
        continue;
      }
      if (status === "Funded" || status === "Delivered" || status === "Disputed") {
        await screenSeller(job.seller);
      }
      if (status === "Delivered" && now >= job.deliveredAt + disputeWindow) {
        try {
          const tx = await mesh.releaseEscrow(jobId);
          log.info({ jobId: id, amount: formatUsd(job.amount), seller: job.seller, tx }, "auto-released");
          store.untrack(id);
        } catch (err) {
          log.error({ jobId: id, err: (err as Error).message }, "release failed");
        }
      } else if (status === "Funded" && now > job.deadline) {
        try {
          const tx = await mesh.refundJob(jobId);
          log.info({ jobId: id, amount: formatUsd(job.amount), buyer: job.buyer, tx }, "refunded");
          store.untrack(id);
        } catch (err) {
          log.error({ jobId: id, err: (err as Error).message }, "refund failed");
        }
      }
    }
  } catch (err) {
    log.error({ err: (err as Error).message }, "tick error");
  }
}

// Self-scheduling loop — a slow tick can never overlap the next one.
let stopping = false;
let timer: NodeJS.Timeout | undefined;
async function loop() {
  if (stopping) return;
  await tick();
  lastTickAt = Date.now();
  if (!stopping) timer = setTimeout(loop, POLL_MS);
}
void loop();
log.info({ pollMs: POLL_MS }, "polling");

// Minimal health listener for uptime checks and container orchestration.
const health = createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/readyz") {
    try {
      await mesh.publicClient.getBlockNumber();
    } catch {
      res
        .writeHead(503, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: false, reason: "rpc unreachable" }));
      return;
    }
    const stale = lastTickAt !== 0 && Date.now() - lastTickAt > 5 * POLL_MS;
    res
      .writeHead(stale ? 503 : 200, { "content-type": "application/json" })
      .end(JSON.stringify(stale ? { ok: false, reason: "tick stalled" } : { ok: true }));
    return;
  }
  res.writeHead(404).end();
});
health.listen(HEALTH_PORT, () => log.info({ port: HEALTH_PORT }, "health listener up"));

function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  stopping = true;
  if (timer) clearTimeout(timer);
  health.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
