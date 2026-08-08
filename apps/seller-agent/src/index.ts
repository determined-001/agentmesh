import { timingSafeEqual } from "node:crypto";
import { JOB_STATUS, meshFromEnv } from "@agentmesh/sdk";
import {
  DELIVERABLE_AUTH_HEADER,
  DELIVERABLE_AUTH_MAX_TTL_MS,
  type DeliverableAuth,
  decodeDeliverableAuth,
  deliverableAuthMessage,
  formatUsd,
  usd,
} from "@agentmesh/shared";
import { createLogger } from "@agentmesh/shared/logger";
import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { parseAbiItem } from "viem";
import { createRateLimiter } from "./rateLimit.js";
import { SellerStore } from "./store.js";
import { priced } from "./x402Middleware.js";

const JOB_ID_RE = /^\d{1,18}$/;

/** DataAgent — the seller side of the AgentMesh demo.
 *  Serves sub-cent x402-priced data endpoints and works escrowed jobs:
 *  it watches AgentEscrow for JobCreated events naming it as seller, produces
 *  the report, and submits `deliver()` on-chain so the watcher can auto-release. */

const log = createLogger("seller");

const PORT = Number(process.env.PORT ?? 4021);
const POLL_MS = Number(process.env.POLL_MS ?? 2000);
// Caps eth_getLogs range per tick so a run of RPC failures can't snowball the
// unprocessed range past whatever limit the RPC enforces — each tick makes
// bounded progress instead of retrying an ever-growing range forever.
const MAX_BLOCK_RANGE = BigInt(process.env.MAX_BLOCK_RANGE ?? 500);
const AGENT_NAME = process.env.AGENT_NAME ?? "databot";
const ENDPOINT = process.env.PUBLIC_ENDPOINT ?? `http://localhost:${PORT}`;

const { client: mesh, network } = meshFromEnv("SELLER_PRIVATE_KEY");
const me = await mesh.wallet.getAddress();

// Durable state: replay/quote bookkeeping, payments, jobs, block cursor.
// Scoped to escrow address + genesis hash so a chain reset with deterministic
// addresses (fresh anvil) can't resurrect stale jobs/payments.
const genesis = (await mesh.publicClient.getBlock({ blockNumber: 0n })).hash;
const store = new SellerStore(
  process.env.SELLER_DB ?? "data/seller.sqlite",
  `${mesh.deployment.agentEscrow}|${genesis}`,
);

// Register the agent name on first boot (idempotent).
if (!(await mesh.isRegistered(AGENT_NAME))) {
  const tx = await mesh.registerAgent(AGENT_NAME, ENDPOINT, "");
  log.info({ agent: AGENT_NAME, wallet: me, tx }, "registered agent name");
} else {
  log.info({ agent: AGENT_NAME }, "agent name already registered");
}

const app = new Hono();
const paymentOpts = {
  mesh,
  network,
  payTo: me,
  state: store,
  recordPayment: (p: Parameters<typeof store.addPayment>[0]) => store.addPayment(p),
};
// Ahead of everything except health: unauthenticated traffic to a priced route
// mints a quote row per request, so flooding is a write-amplification attack.
app.use("/api/*", createRateLimiter());
app.use("/jobs/*", createRateLimiter());
app.use("/card", createRateLimiter());

// Priced API routes are meant to be called cross-origin by agents; the operator
// and deliverable routes are not. A blanket `cors()` reflected `*` onto all of
// them (and exposed the CORS middleware's ReDoS surface to every path).
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use("/api/*", cors({ origin: CORS_ORIGINS.length ? CORS_ORIGINS : "*" }));
app.use("/card", cors({ origin: CORS_ORIGINS.length ? CORS_ORIGINS : "*" }));

/** Operator-only surfaces (payment ledger, job list). These are ops data, not
 *  customer data: they expose every payer address, amount and tx hash. */
const ADMIN_TOKEN = process.env.SELLER_ADMIN_TOKEN ?? "";
function adminAuthorized(c: Context): boolean {
  if (!ADMIN_TOKEN) {
    // Fail closed anywhere but an explicitly-local demo.
    return process.env.AGENTMESH_NETWORK === "local";
  }
  const header = c.req.header("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- health ----
let lastTickAt = 0;
app.get("/healthz", (c) => c.json({ ok: true }));
app.get("/readyz", async (c) => {
  try {
    await mesh.publicClient.getBlockNumber();
  } catch {
    return c.json({ ok: false, reason: "rpc unreachable" }, 503);
  }
  const stale = lastTickAt !== 0 && Date.now() - lastTickAt > 5 * POLL_MS;
  if (stale) return c.json({ ok: false, reason: "escrow poller stalled" }, 503);
  return c.json({ ok: true });
});

// ---- free endpoints ----
app.get("/card", (c) =>
  c.json({
    name: AGENT_NAME,
    displayName: `${AGENT_NAME}.agent.arc`,
    wallet: me,
    endpoint: ENDPOINT,
    services: [
      { path: "/api/headline", priceUsd: "0.001", description: "One market headline" },
      { path: "/api/datapoint", priceUsd: "0.002", description: "One market datapoint" },
    ],
    escrow: { accepts: true, reportPriceUsd: "5.00" },
    network,
  }),
);
app.get("/payments", (c) => {
  if (!adminAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  return c.json({ count: store.paymentCount(), payments: store.recentPayments(500) });
});
app.get("/jobs", (c) => {
  if (!adminAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  return c.json(store.listJobs());
});

/** The buyer's paid artifact. Requires a signature from the address the escrow
 *  records as this job's buyer — see deliverableAuthMessage. */
app.get("/jobs/:id/deliverable", async (c) => {
  const jobId = c.req.param("id");
  if (!JOB_ID_RE.test(jobId)) return c.json({ error: "jobId must be a decimal string" }, 400);

  const header = c.req.header(DELIVERABLE_AUTH_HEADER);
  if (!header) return c.json({ error: "authentication required" }, 401);

  let auth: DeliverableAuth;
  try {
    auth = decodeDeliverableAuth(header);
  } catch {
    return c.json({ error: "malformed authorization header" }, 400);
  }

  const now = Date.now();
  if (auth.expiry <= now) return c.json({ error: "authorization expired" }, 401);
  if (auth.expiry - now > DELIVERABLE_AUTH_MAX_TTL_MS) {
    return c.json({ error: "authorization dated too far ahead" }, 400);
  }

  let sigOk = false;
  try {
    // Via the public client, so smart-contract wallets verify through ERC-1271.
    sigOk = await mesh.publicClient.verifyMessage({
      address: auth.address,
      message: deliverableAuthMessage(jobId, auth.nonce, auth.expiry),
      signature: auth.signature,
    });
  } catch {
    sigOk = false;
  }
  if (!sigOk) return c.json({ error: "invalid signature" }, 401);
  if (!store.useNonce(auth.nonce, auth.expiry)) return c.json({ error: "authorization replayed" }, 401);

  // The chain is the authority on who bought this job.
  let onchainBuyer: string;
  try {
    onchainBuyer = (await mesh.getJob(BigInt(jobId))).buyer;
  } catch {
    return c.json({ error: "job lookup failed" }, 503);
  }
  if (onchainBuyer.toLowerCase() !== auth.address.toLowerCase()) {
    return c.json({ error: "not the buyer of this job" }, 403);
  }

  const job = store.getJob(jobId);
  if (!job?.report) return c.json({ error: "not delivered" }, 404);
  return c.json({ jobId: job.jobId, report: job.report, deliveredTx: job.deliveredTx });
});

// ---- x402-priced endpoints (sub-cent, per-call) ----
const HEADLINES = [
  "USDC settlement volume on Arc up 14% week over week",
  "Stablecoin FX corridors expand as EURC liquidity deepens",
  "Agentic commerce pilots triple among API-first merchants",
  "Sub-second finality drives machine-speed settlement adoption",
  "x402 adoption accelerates across payment networks",
];
app.get("/api/headline", priced(usd("0.001"), "One market headline", paymentOpts), (c) =>
  c.json({ headline: HEADLINES[Math.floor(Math.random() * HEADLINES.length)], ts: Date.now() }),
);
app.get("/api/datapoint", priced(usd("0.002"), "One market datapoint", paymentOpts), (c) =>
  c.json({
    metric: "arc_usdc_settlement_volume_usd",
    value: Math.round(1_000_000 + Math.random() * 9_000_000),
    ts: Date.now(),
  }),
);

// ---- escrow job worker ----
const jobCreatedEvent = parseAbiItem(
  "event JobCreated(uint256 indexed jobId, address indexed buyer, address indexed seller, uint256 amount, uint64 deadline, bytes32 specHash)",
);

let lastBlock = store.getCursor() ?? 0n;

/** Record every job in the scanned range, THEN advance the cursor.
 *
 *  The cursor used to move before the jobs were worked, inside a try/catch that
 *  swallowed errors — so a crash or a single failed `deliver()` permanently
 *  skipped those jobs. They were never re-fetched, the buyer's funds sat until
 *  the deadline, and the seller silently lost paid work. Discovery is now
 *  durable before the cursor moves; delivery is a separate, retryable pass. */
async function discoverEscrowJobs() {
  const latest = await mesh.publicClient.getBlockNumber();
  if (lastBlock === 0n) lastBlock = latest > 50n ? latest - 50n : 0n;
  if (latest < lastBlock) return;
  const toBlock = latest - lastBlock > MAX_BLOCK_RANGE ? lastBlock + MAX_BLOCK_RANGE : latest;
  const logs = await mesh.publicClient.getLogs({
    address: mesh.deployment.agentEscrow,
    event: jobCreatedEvent,
    args: { seller: me },
    fromBlock: lastBlock,
    toBlock,
  });

  for (const logEntry of logs) {
    const jobId = logEntry.args.jobId;
    if (jobId === undefined) continue;
    const key = jobId.toString();
    if (store.getJob(key)) continue; // already known — never downgrade its status
    store.upsertJob({
      jobId: key,
      buyer: logEntry.args.buyer ?? "0x",
      amount: (logEntry.args.amount ?? 0n).toString(),
      status: "pending",
    });
    log.info({ jobId: key, amount: formatUsd(logEntry.args.amount ?? 0n) }, "job discovered");
  }

  // Only now is it safe to say these blocks are handled.
  lastBlock = toBlock + 1n;
  store.setCursor(lastBlock);
}

/** Work the queue. Each job is isolated: one failure retries next tick instead
 *  of aborting the batch. */
async function workPendingJobs() {
  for (const job of store.pendingJobs()) {
    const key = job.jobId;
    try {
      const onchain = await mesh.getJob(BigInt(key));
      const status = JOB_STATUS[onchain.status];
      if (status !== "Funded") {
        // Already delivered, refunded or cancelled elsewhere — stop retrying.
        store.setJobStatus(key, `skipped:${status}`);
        continue;
      }

      log.info({ jobId: key, amount: formatUsd(onchain.amount) }, "job funded — working");

      // "Work": compose the report the buyer paid for.
      const report = JSON.stringify({
        title: "Market Report",
        producedBy: `${AGENT_NAME}.agent.arc`,
        jobId: key,
        summary: HEADLINES.slice(0, 3),
        settlementVolumeUsd: Math.round(5_000_000 + Math.random() * 5_000_000),
        generatedAt: new Date().toISOString(),
      });

      const tx = await mesh.deliverJob(BigInt(key), report);
      store.upsertJob({
        jobId: key,
        buyer: onchain.buyer,
        amount: onchain.amount.toString(),
        report,
        deliveredTx: tx,
        status: "delivered",
      });
      log.info({ jobId: key, tx }, "job delivered");
    } catch (err) {
      // Stays pending: the next tick tries again.
      log.error({ jobId: key, err: (err as Error).message }, "job delivery failed — will retry");
    }
  }
}

async function workEscrowJobs() {
  try {
    await discoverEscrowJobs();
  } catch (err) {
    log.error({ err: (err as Error).message }, "escrow discovery error");
  }
  try {
    await workPendingJobs();
  } catch (err) {
    log.error({ err: (err as Error).message }, "escrow worker error");
  }
}

// Self-scheduling loop: a slow tick can never overlap the next one.
let stopping = false;
let timer: NodeJS.Timeout | undefined;
async function loop() {
  if (stopping) return;
  await workEscrowJobs();
  lastTickAt = Date.now();
  if (!stopping) timer = setTimeout(loop, POLL_MS);
}
void loop();

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  log.info({ agent: AGENT_NAME, port: PORT, wallet: me, network }, "seller listening");
});

function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  stopping = true;
  if (timer) clearTimeout(timer);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  // Failsafe if the HTTP server hangs on open connections.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
