import { JOB_STATUS, meshFromEnv } from "@agentmesh/sdk";
import { formatUsd, usd } from "@agentmesh/shared";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { type Address, parseAbiItem } from "viem";
import { type PaymentRecord, priced } from "./x402Middleware.js";

/** DataAgent — the seller side of the AgentMesh demo.
 *  Serves sub-cent x402-priced data endpoints and works escrowed jobs:
 *  it watches AgentEscrow for JobCreated events naming it as seller, produces
 *  the report, and submits `deliver()` on-chain so the watcher can auto-release. */

const PORT = Number(process.env.PORT ?? 4021);
const AGENT_NAME = process.env.AGENT_NAME ?? "databot";
const ENDPOINT = process.env.PUBLIC_ENDPOINT ?? `http://localhost:${PORT}`;

const { client: mesh, network } = meshFromEnv("SELLER_PRIVATE_KEY");
const me = await mesh.wallet.getAddress();

// Register the agent name on first boot (idempotent).
if (!(await mesh.isRegistered(AGENT_NAME))) {
  const tx = await mesh.registerAgent(AGENT_NAME, ENDPOINT, "");
  console.log(`[seller] registered ${AGENT_NAME}.agent.arc → ${me} (tx ${tx})`);
} else {
  console.log(`[seller] ${AGENT_NAME}.agent.arc already registered`);
}

const payments: PaymentRecord[] = [];
const jobsWorked = new Map<
  string,
  { jobId: string; buyer: Address; amount: string; report?: string; deliveredTx?: string; status: string }
>();

const app = new Hono();
const paymentOpts = { mesh, network, payTo: me, payments };
app.use("*", cors());

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
app.get("/payments", (c) => c.json({ count: payments.length, payments: payments.slice(-500) }));
app.get("/jobs", (c) => c.json([...jobsWorked.values()]));
app.get("/jobs/:id/deliverable", (c) => {
  const job = jobsWorked.get(c.req.param("id"));
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

let lastBlock = 0n;
async function workEscrowJobs() {
  try {
    const latest = await mesh.publicClient.getBlockNumber();
    if (lastBlock === 0n) lastBlock = latest > 50n ? latest - 50n : 0n;
    if (latest < lastBlock) return;
    const logs = await mesh.publicClient.getLogs({
      address: mesh.deployment.agentEscrow,
      event: jobCreatedEvent,
      args: { seller: me },
      fromBlock: lastBlock,
      toBlock: latest,
    });
    lastBlock = latest + 1n;

    for (const log of logs) {
      const jobId = log.args.jobId!;
      const key = jobId.toString();
      if (jobsWorked.has(key)) continue;
      const onchain = await mesh.getJob(jobId);
      if (JOB_STATUS[onchain.status] !== "Funded") continue;

      console.log(`[seller] job #${key} funded (${formatUsd(onchain.amount)}) — working...`);
      jobsWorked.set(key, {
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
      const entry = jobsWorked.get(key)!;
      entry.report = report;
      entry.deliveredTx = tx;
      entry.status = "delivered";
      console.log(`[seller] job #${key} delivered (tx ${tx})`);
    }
  } catch (err) {
    console.error("[seller] escrow worker error:", (err as Error).message);
  }
}
setInterval(workEscrowJobs, Number(process.env.POLL_MS ?? 2000));

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[seller] ${AGENT_NAME}.agent.arc listening on :${PORT} (wallet ${me}, network ${network})`);
});
