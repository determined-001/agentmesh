import { CirclePendingError, JOB_STATUS, type PayeePolicy, paidFetch, SpendBudget } from "@agentmesh/sdk";
import { explorerTxUrl, formatUsd, usd } from "@agentmesh/shared";
import { createMcpHandler } from "mcp-handler";
import { type Address, isAddress } from "viem";
import { z } from "zod";
import {
  circleBlockchain,
  circleSdk,
  FAUCET_URL,
  meshForWallet,
  network,
  readOnlyMesh,
  walletSetId,
} from "../../../lib/mesh";

/** AgentMesh as a remote MCP server.
 *
 *  Same tools as apps/mcp-server, but reachable over HTTPS so a non-technical user
 *  can add one URL as a claude.ai custom connector instead of installing anything.
 *  Everything here is public, so this tier holds no key and can only read chain
 *  state; the wallet-bearing tools live behind a Circle wallet the caller mints. */
export const runtime = "nodejs";
export const maxDuration = 60;

const json = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
    },
  ],
});

const JOB_ID_RE = /^\d{1,18}$/;
const WALLET_ID_RE = /^[0-9a-f-]{16,64}$/i;

/** Chain timestamps are unix seconds. Handed to a model as a bare integer they get
 *  misread — a reviewer was told a registration four days old happened next month —
 *  so every timestamp leaves here already resolved. */
const iso = (unixSeconds: bigint | number): string | undefined => {
  const n = Number(unixSeconds);
  return n > 0 ? new Date(n * 1000).toISOString() : undefined;
};

async function toAddress(nameOrAddress: string): Promise<Address> {
  if (isAddress(nameOrAddress)) return nameOrAddress;
  const { wallet } = await readOnlyMesh().resolveAgent(nameOrAddress);
  return wallet;
}

/** Resolve a caller-supplied walletId to a live Circle wallet. The id is a bearer
 *  capability — whoever holds it can spend that wallet through this connector — so
 *  the address is always read back from Circle rather than taken from the model. */
async function meshFor(walletId: string) {
  if (!WALLET_ID_RE.test(walletId)) throw new Error(`Not a Circle wallet id: ${walletId}`);
  const sdk = await circleSdk();
  const wallet = (await sdk.getWallet({ id: walletId })).data?.wallet;
  if (!wallet) throw new Error(`No Circle wallet with id ${walletId}`);
  return { mesh: meshForWallet(walletId, wallet.address), address: wallet.address };
}

/** A tool that spends must never leave the caller thinking a pending transaction
 *  failed: Circle may still land it after the invocation's poll budget runs out. */
function pendingNote(err: unknown) {
  if (err instanceof CirclePendingError) {
    return json({
      status: "pending",
      circleTxId: err.circleTxId,
      note: "Circle accepted the transaction but it had not landed yet. Poll it with tx_status — do not resubmit.",
    });
  }
  throw err;
}

/** Per-call and lifetime x402 ceilings. In serverless these reset per instance, so
 *  the wallet's own balance is the real cap — say so rather than imply otherwise. */
const budget = SpendBudget.fromEnv();

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "list_agents",
      "List every agent registered in the AgentMesh naming registry on Arc, with wallet, endpoint and registration time.",
      {},
      async () => {
        const agents = await readOnlyMesh().listAgents();
        return json(
          agents.map((a) => ({
            ...a,
            displayName: `${a.name}.agent.arc`,
            registeredAtIso: iso(a.registeredAt),
          })),
        );
      },
    );

    server.tool(
      "resolve_agent",
      "Resolve an agent name (e.g. 'databot') to its wallet address and agent card.",
      { name: z.string() },
      async ({ name }) => {
        const { wallet, card } = await readOnlyMesh().resolveAgent(name);
        return json({
          name: `${name}.agent.arc`,
          wallet,
          card: { ...card, registeredAtIso: iso(card.registeredAt) },
        });
      },
    );

    server.tool(
      "get_balance",
      "USDC balance of an agent name or 0x address on Arc.",
      { addressOrName: z.string() },
      async ({ addressOrName }) => {
        const target = await toAddress(addressOrName);
        const balance = await readOnlyMesh().usdcBalance(target);
        return json({ address: target, balance: balance.toString(), formatted: formatUsd(balance) });
      },
    );

    server.tool(
      "get_job",
      "State of an escrow job: parties, amount, status, deadline, deliverable hash.",
      { jobId: z.string() },
      async ({ jobId }) => {
        if (!JOB_ID_RE.test(jobId)) throw new Error(`jobId must be a decimal string: ${jobId}`);
        const job = await readOnlyMesh().getJob(BigInt(jobId));
        return json({
          jobId,
          ...job,
          amountFormatted: formatUsd(job.amount),
          statusName: JOB_STATUS[job.status],
          deadlineIso: iso(job.deadline),
          deliveredAtIso: iso(job.deliveredAt),
          nowIso: new Date().toISOString(),
        });
      },
    );

    server.tool(
      "compliance_status",
      "Compliance screening verdict for an address or agent name. 'allowed' means a screener cleared it and the verdict is still fresh; 'blocked' means a screener affirmatively denied it. Neither being true means simply unscreened — which is not a sanction.",
      { addressOrName: z.string() },
      async ({ addressOrName }) => {
        const mesh = readOnlyMesh();
        const target = await toAddress(addressOrName);
        const allowed = await mesh.isAllowed(target);
        // The gate currently deployed on Arc Testnet predates isBlocked, so the call
        // reverts there. Report that as "not distinguishable" rather than failing the
        // tool — and never let a missing verdict read as a sanction.
        const blocked = await mesh.isBlocked(target).catch(() => null);
        return json({
          address: target,
          allowed,
          blocked,
          verdict: blocked ? "blocked" : allowed ? "allowed" : "unscreened",
          meaning: blocked
            ? "A screener denied this address; escrow can never release funds to it."
            : allowed
              ? "Screened and cleared — escrow may release funds to it."
              : "No fresh screening verdict on file. Escrow will not release until one exists.",
          note:
            blocked === null
              ? "This gate deployment predates isBlocked(), so an affirmative deny cannot be distinguished from an unscreened address here."
              : undefined,
        });
      },
    );

    server.tool(
      "network_info",
      "Which chain and contract addresses this connector is pointed at.",
      {},
      async () => {
        const mesh = readOnlyMesh();
        return json({
          network,
          chainId: mesh.chain.id,
          contracts: mesh.deployment,
          explorerExample: explorerTxUrl(network, `0x${"0".repeat(64)}`),
        });
      },
    );

    // ---- wallet tools: a Circle developer-controlled wallet per caller ----

    server.tool(
      "create_agent_wallet",
      "Mint a new Circle developer-controlled wallet on Arc for this user, so they can act as an agent without ever handling a private key. Returns a walletId the user must keep and pass to the other wallet tools. Fund it from the Circle faucet before spending.",
      { label: z.string().default("agentmesh-connector").describe("a name to recognise it by") },
      async ({ label }) => {
        const sdk = await circleSdk();
        const res = await sdk.createWallets({
          walletSetId: walletSetId(),
          accountType: "SCA",
          blockchains: [circleBlockchain],
          count: 1,
          metadata: [{ name: label.slice(0, 50) }],
        });
        const wallet = res.data?.wallets?.[0];
        if (!wallet) throw new Error("Circle did not return a wallet");
        return json({
          walletId: wallet.id,
          address: wallet.address,
          network,
          fundAt: FAUCET_URL,
          keepThis:
            "Save this walletId. Anyone who has it can spend this wallet through this connector, and losing it means losing access to the funds.",
        });
      },
    );

    server.tool(
      "wallet_status",
      "Address, USDC balance and registered name (if any) for a walletId this connector minted.",
      { walletId: z.string() },
      async ({ walletId }) => {
        const { mesh, address } = await meshFor(walletId);
        const balance = await mesh.usdcBalance(address);
        return json({
          walletId,
          address,
          balance: balance.toString(),
          formatted: formatUsd(balance),
          fundAt: balance === 0n ? FAUCET_URL : undefined,
        });
      },
    );

    server.tool(
      "tx_status",
      "Check a Circle transaction that was still pending when a spending tool returned.",
      { circleTxId: z.string() },
      async ({ circleTxId }) => {
        const sdk = await circleSdk();
        const tx = (await sdk.getTransaction({ id: circleTxId })).data?.transaction;
        if (!tx) throw new Error(`No Circle transaction with id ${circleTxId}`);
        return json({
          state: tx.state,
          txHash: tx.txHash,
          explorer: tx.txHash ? explorerTxUrl(network, tx.txHash) : undefined,
          errorReason: tx.errorReason,
        });
      },
    );

    server.tool(
      "register_agent",
      "Claim a human-readable name for a wallet in the AgentMesh registry (rendered <name>.agent.arc). Lowercase a-z, 0-9 and '-' only. Costs gas from the wallet.",
      {
        walletId: z.string(),
        name: z.string(),
        endpoint: z.string().default("").describe("https URL where this agent serves requests"),
        cardURI: z.string().default(""),
      },
      async ({ walletId, name, endpoint, cardURI }) => {
        const { mesh, address } = await meshFor(walletId);
        try {
          const tx = await mesh.registerAgent(name, endpoint, cardURI);
          return json({
            registered: `${name}.agent.arc`,
            wallet: address,
            txHash: tx,
            explorer: explorerTxUrl(network, tx),
          });
        } catch (err) {
          return pendingNote(err);
        }
      },
    );

    // ---- money tools ----

    server.tool(
      "create_escrow_job",
      "Lock USDC in escrow for a job with an agent. Funds only release after delivery and compliance screening; the buyer can dispute inside the dispute window, and a timeout refunds a job nobody settles.",
      {
        walletId: z.string(),
        seller: z.string().describe("agent name (e.g. 'databot') or 0x address"),
        amountUsd: z.string().describe("e.g. '0.25'"),
        deadlineMinutes: z.number().default(60),
        spec: z.string().describe("what the seller is being asked to produce"),
      },
      async ({ walletId, seller, amountUsd, deadlineMinutes, spec }) => {
        const { mesh } = await meshFor(walletId);
        const sellerAddr = await toAddress(seller);
        try {
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
        } catch (err) {
          return pendingNote(err);
        }
      },
    );

    server.tool(
      "release_escrow",
      "Release an escrowed job's funds to the seller. The buyer may release any time after delivery; anyone else only once the dispute window closes. Reverts if the seller is not compliance-cleared.",
      { walletId: z.string(), jobId: z.string() },
      async ({ walletId, jobId }) => {
        if (!JOB_ID_RE.test(jobId)) throw new Error(`jobId must be a decimal string: ${jobId}`);
        const { mesh } = await meshFor(walletId);
        try {
          const tx = await mesh.releaseEscrow(BigInt(jobId));
          return json({ jobId, txHash: tx, explorer: explorerTxUrl(network, tx) });
        } catch (err) {
          return pendingNote(err);
        }
      },
    );

    server.tool(
      "dispute_job",
      "Dispute a delivered job inside its dispute window (buyer only). An arbiter then resolves it to release or refund.",
      { walletId: z.string(), jobId: z.string() },
      async ({ walletId, jobId }) => {
        if (!JOB_ID_RE.test(jobId)) throw new Error(`jobId must be a decimal string: ${jobId}`);
        const { mesh } = await meshFor(walletId);
        try {
          const tx = await mesh.disputeJob(BigInt(jobId));
          return json({ jobId, txHash: tx, explorer: explorerTxUrl(network, tx) });
        } catch (err) {
          return pendingNote(err);
        }
      },
    );

    server.tool(
      "pay_x402",
      "Fetch an x402-priced HTTP resource, settling the required USDC micropayment on Arc automatically (402 → pay → retry). Funds only ever go to a wallet registered in the AgentMesh registry; pass sellerName to pin the payee exactly.",
      {
        walletId: z.string(),
        url: z.string(),
        maxAmountUsd: z.string().default("0.01"),
        sellerName: z.string().optional(),
      },
      async ({ walletId, url, maxAmountUsd, sellerName }) => {
        const { mesh } = await meshFor(walletId);
        // maxAmountUsd is chosen by the model, and the fetched page is exactly the
        // channel used to influence that choice — so the server budget binds.
        const requested = usd(maxAmountUsd);
        const maxAmount = requested < budget.perCall ? requested : budget.perCall;
        const payeePolicy: PayeePolicy = sellerName
          ? { expect: (await mesh.resolveAgent(sellerName)).wallet }
          : { registeredAgent: true };
        const { response, paid } = await paidFetch(mesh, url, { maxAmount, payeePolicy, budget });
        const body = await response.text();
        return json({
          status: response.status,
          body: body.length > 4000 ? `${body.slice(0, 4000)}…` : body,
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
  },
  { serverInfo: { name: "agentmesh", version: "0.1.0" } },
  {
    // Stateless streamable HTTP only. SSE would need Redis for session state, and
    // this route has to stay dependency-free to run on the dashboard's own host.
    basePath: "/api",
    disableSse: true,
    maxDuration,
  },
);

export { handler as GET, handler as POST, handler as DELETE };
