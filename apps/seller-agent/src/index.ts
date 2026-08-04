import { JOB_STATUS, meshFromEnv } from "@agentmesh/sdk";
import { formatUsd, usd } from "@agentmesh/shared";
import { createLogger } from "@agentmesh/shared/logger";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { parseAbiItem } from "viem";
import { SellerStore } from "./store.js";
import { priced } from "./x402Middleware.js";

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
app.use("*", cors());

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
app.get("/payments", (c) => c.json({ count: store.paymentCount(), payments: store.recentPayments(500) }));
app.get("/jobs", (c) => c.json(store.listJobs()));
app.get("/jobs/:id/deliverable", (c) => {
  const job = store.getJob(c.req.param("id"));
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
async function workEscrowJobs() {
  try {
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
    lastBlock = toBlock + 1n;
    store.setCursor(lastBlock);

    for (const logEntry of logs) {
      const jobId = logEntry.args.jobId;
      if (jobId === undefined) continue;
      const key = jobId.toString();
      const existing = store.getJob(key);
      if (existing && existing.status !== "working") continue;
      const onchain = await mesh.getJob(jobId);
      if (JOB_STATUS[onchain.status] !== "Funded") continue;

      log.info({ jobId: key, amount: formatUsd(onchain.amount) }, "job funded — working");
      store.upsertJob({
        jobId: key,
        buyer: onchain.buyer,
        amount: onchain.amount.toString(),
        status: "working",
      });

      // "Work": compose the report the buyer paid for.
      const report = JSON.stringify({
        title: "Market Report",
        producedBy: `${AGENT_NAME}.agent.arc`,
        jobId: key,
        summary: HEADLINES.slice(0, 3),
        settlementVolumeUsd: Math.round(5_000_000 + Math.random() * 5_000_000),
        generatedAt: new Date().toISOString(),
      });

      const tx = await mesh.deliverJob(jobId, report);
      store.upsertJob({
        jobId: key,
        buyer: onchain.buyer,
        amount: onchain.amount.toString(),
        report,
        deliveredTx: tx,
        status: "delivered",
      });
      log.info({ jobId: key, tx }, "job delivered");
    }
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
