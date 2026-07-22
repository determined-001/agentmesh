import { JOB_STATUS, meshFromEnv, paidFetch } from "@agentmesh/sdk";
import { explorerTxUrl, formatUsd, usd } from "@agentmesh/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type Address, isAddress } from "viem";
import { z } from "zod";

/** AgentMesh MCP server — the "agent brain" port.
 *  Connect any MCP-capable model (Claude, etc.) and it becomes a first-class
 *  AgentMesh participant: it can register a named wallet, discover other
 *  agents, stream x402 micropayments, and run the escrow lifecycle.
 *
 *  Env: AGENTMESH_NETWORK (local | arc-testnet), PRIVATE_KEY (or
 *  WALLET_PROVIDER=circle + CIRCLE_* vars). */

const { client: mesh, network } = meshFromEnv("BUYER_PRIVATE_KEY");
const myAddress = await mesh.wallet.getAddress();

const server = new McpServer({ name: "agentmesh", version: "0.1.0" });

const json = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2),
    },
  ],
});

async function toSellerAddress(sellerNameOrAddress: string): Promise<Address> {
  if (isAddress(sellerNameOrAddress)) return sellerNameOrAddress;
  const { wallet } = await mesh.resolveAgent(sellerNameOrAddress);
  return wallet;
}

server.tool(
  "register_agent",
  "Register a human-readable name for this agent's wallet in the AgentMesh registry on Arc (rendered as <name>.agent.arc). Name must be lowercase a-z, 0-9, or '-'.",
  { name: z.string(), endpoint: z.string().default(""), cardURI: z.string().default("") },
  async ({ name, endpoint, cardURI }) => {
    const tx = await mesh.registerAgent(name, endpoint, cardURI);
    return json({
      registered: `${name}.agent.arc`,
      wallet: myAddress,
      txHash: tx,
      explorer: explorerTxUrl(network, tx),
    });
  },
);

server.tool(
  "resolve_agent",
  "Resolve an agent name to its wallet address and agent card (endpoint, pricing card URI).",
  { name: z.string() },
  async ({ name }) => {
    const { wallet, card } = await mesh.resolveAgent(name);
    return json({ name: `${name}.agent.arc`, wallet, card });
  },
);

server.tool("list_agents", "List all agents registered in the AgentMesh registry.", {}, async () => {
  const agents = await mesh.listAgents();
  return json(agents.map((a) => ({ ...a, displayName: `${a.name}.agent.arc` })));
});

server.tool(
  "get_balance",
  "Get the USDC balance of this agent's wallet (or another address / agent name).",
  { addressOrName: z.string().optional() },
  async ({ addressOrName }) => {
    const target = addressOrName ? await toSellerAddress(addressOrName) : myAddress;
    const balance = await mesh.usdcBalance(target);
    return json({ address: target, balance: balance.toString(), formatted: formatUsd(balance) });
  },
);

server.tool(
  "pay_x402",
  "Fetch an x402-priced HTTP resource, automatically settling the required USDC micropayment on Arc (402 → pay → retry). maxAmountUsd caps spend per call.",
  { url: z.string(), maxAmountUsd: z.string().default("0.01") },
  async ({ url, maxAmountUsd }) => {
    const { response, paid } = await paidFetch(mesh, url, { maxAmount: usd(maxAmountUsd) });
    const body = await response.text();
    return json({
      status: response.status,
      body: body.length > 4000 ? body.slice(0, 4000) + "…" : body,
      paid: paid
        ? {
            amount: formatUsd(paid.amount),
            txHash: paid.txHash,
            explorer: explorerTxUrl(network, paid.txHash),
          }
        : "free (no payment was required)",
    });
  },
);

server.tool(
  "create_escrow_job",
  "Lock USDC in escrow for a job with a named agent (or address). Funds release on delivery after compliance screening — the watcher auto-releases when the dispute window closes.",
  {
    seller: z.string().describe("agent name (e.g. 'databot') or 0x address"),
    amountUsd: z.string().describe("e.g. '5' for $5"),
    deadlineMinutes: z.number().default(60),
    spec: z.string().describe("the job specification / intent"),
  },
  async ({ seller, amountUsd, deadlineMinutes, spec }) => {
    const sellerAddr = await toSellerAddress(seller);
    const { jobId, txHash } = await mesh.createEscrowJob({
      seller: sellerAddr,
      amount: usd(amountUsd),
      deadline: BigInt(Math.floor(Date.now() / 1000) + deadlineMinutes * 60),
      spec,
    });
    return json({
      jobId: jobId.toString(),
      seller: sellerAddr,
      amount: `$${amountUsd}`,
      txHash,
      explorer: explorerTxUrl(network, txHash),
    });
  },
);

server.tool(
  "get_job",
  "Get the current state of an escrow job (status, parties, amount, deadlines, deliverable hash).",
  { jobId: z.string() },
  async ({ jobId }) => {
    const job = await mesh.getJob(BigInt(jobId));
    return json({
      jobId,
      ...job,
      amountFormatted: formatUsd(job.amount),
      statusName: JOB_STATUS[job.status],
    });
  },
);

server.tool(
  "release_escrow",
  "Release an escrowed job's funds to the seller (buyer may release any time after delivery; others only after the dispute window). Blocked if the seller fails compliance screening.",
  { jobId: z.string() },
  async ({ jobId }) => {
    const tx = await mesh.releaseEscrow(BigInt(jobId));
    return json({ released: jobId, txHash: tx, explorer: explorerTxUrl(network, tx) });
  },
);

server.tool(
  "dispute_job",
  "Dispute a delivered job within the dispute window (buyer only). An arbiter then resolves it to release or refund.",
  { jobId: z.string() },
  async ({ jobId }) => {
    const tx = await mesh.disputeJob(BigInt(jobId));
    return json({ disputed: jobId, txHash: tx, explorer: explorerTxUrl(network, tx) });
  },
);

server.tool(
  "screen_address",
  "Push a compliance screening verdict for an address to the on-chain ComplianceGate (requires SCREENER_ROLE on the connected wallet).",
  { address: z.string(), allowed: z.boolean(), reason: z.string().default("manual") },
  async ({ address, allowed, reason }) => {
    if (!isAddress(address)) throw new Error(`not an address: ${address}`);
    const tx = await mesh.setAllowed(address, allowed, reason);
    return json({ screened: address, allowed, txHash: tx });
  },
);

server.tool(
  "fetch_deliverable",
  "Fetch the deliverable for a completed escrow job from the seller agent's endpoint.",
  { sellerName: z.string(), jobId: z.string() },
  async ({ sellerName, jobId }) => {
    const { card } = await mesh.resolveAgent(sellerName);
    const res = await fetch(`${card.endpoint}/jobs/${jobId}/deliverable`);
    return json(await res.json());
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[agentmesh-mcp] ready — wallet ${myAddress} on ${network}`);
