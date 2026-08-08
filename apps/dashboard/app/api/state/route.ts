import { readDeployment } from "@agentmesh/sdk";
import {
  agentEscrowAbi,
  agentRegistryAbi,
  chainFor,
  complianceGateAbi,
  type NetworkName,
  usdcAbi,
} from "@agentmesh/shared";
import { NextResponse } from "next/server";
import { type Address, createPublicClient, http } from "viem";

export const dynamic = "force-dynamic";

const network = (process.env.AGENTMESH_NETWORK ?? "local") as NetworkName;
const SELLER_URL = process.env.SELLER_URL ?? "http://localhost:4021";

const big = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

/** Every call fans out to ~30 contract reads, and the page polls every 2s per
 *  open tab — without a shared cache, N viewers multiply straight into N×
 *  RPC load on an endpoint we don't own. */
const CACHE_MS = Number(process.env.STATE_CACHE_MS ?? 5000);
/** How long a last-known-good snapshot may still be served after upstream
 *  starts failing. Public RPCs rate-limit in bursts; without this the page
 *  flapped between live data and "chain state unavailable" every few seconds. */
const STALE_MS = Number(process.env.STATE_STALE_MS ?? 120_000);
let cache: { at: number; body: unknown } | undefined;
let inflight: Promise<unknown> | undefined;

export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_MS) return NextResponse.json(cache.body);
  // Collapse concurrent misses into one upstream fan-out.
  if (!inflight) {
    inflight = buildState().finally(() => {
      inflight = undefined;
    });
  }
  try {
    const body = await inflight;
    cache = { at: Date.now(), body };
    return NextResponse.json(body);
  } catch (err) {
    // A rate-limited refresh is not a reason to blank a working dashboard:
    // serve the last good snapshot, flagged, until it is genuinely old.
    if (cache && Date.now() - cache.at < STALE_MS) {
      return NextResponse.json({
        ...(cache.body as Record<string, unknown>),
        stale: true,
        staleForMs: Date.now() - cache.at,
      });
    }
    return NextResponse.json({ error: (err as Error).message, network }, { status: 500 });
  }
}

async function buildState() {
  {
    const deployment = readDeployment(network);
    // Explicit timeout/retry: a hanging RPC otherwise pins the route open.
    // `batch` collapses the ~30 concurrent eth_calls below into a handful of
    // JSON-RPC batch requests — one request per agent field and per job was
    // enough to trip the public Arc RPC's rate limiter on every other poll.
    const client = createPublicClient({
      chain: chainFor(network),
      transport: http(undefined, {
        batch: { wait: 20 },
        retryCount: 2,
        retryDelay: 300,
        timeout: 10_000,
      }),
    });

    const agentsRaw = (await client.readContract({
      address: deployment.agentRegistry,
      abi: agentRegistryAbi,
      functionName: "listAgents",
      args: [0n, 100n],
    })) as readonly { name: string; wallet: Address; endpoint: string; registeredAt: bigint }[];

    const agents = await Promise.all(
      agentsRaw.map(async (a) => {
        const [owner] = (await client.readContract({
          address: deployment.agentRegistry,
          abi: agentRegistryAbi,
          functionName: "resolve",
          args: [a.name],
        })) as [Address, unknown];
        const [balance, allowed] = await Promise.all([
          client.readContract({
            address: deployment.usdc,
            abi: usdcAbi,
            functionName: "balanceOf",
            args: [owner],
          }) as Promise<bigint>,
          client.readContract({
            address: deployment.complianceGate,
            abi: complianceGateAbi,
            functionName: "isAllowed",
            args: [owner],
          }) as Promise<boolean>,
        ]);
        return { ...a, wallet: owner, balance, allowed };
      }),
    );

    const nextJobId = (await client.readContract({
      address: deployment.agentEscrow,
      abi: agentEscrowAbi,
      functionName: "nextJobId",
    })) as bigint;
    const jobIds: bigint[] = [];
    for (let i = nextJobId - 1n; i >= 1n && jobIds.length < 25; i--) jobIds.push(i);
    const jobs = await Promise.all(
      jobIds.map(async (id) => {
        const job = (await client.readContract({
          address: deployment.agentEscrow,
          abi: agentEscrowAbi,
          functionName: "getJob",
          args: [id],
        })) as Record<string, unknown>;
        return { jobId: id.toString(), ...job };
      }),
    );

    let payments: unknown = { count: 0, payments: [] };
    try {
      // /payments is operator-only now; the token stays server-side and never
      // reaches the browser.
      const adminToken = process.env.SELLER_ADMIN_TOKEN;
      const res = await fetch(`${SELLER_URL}/payments`, {
        signal: AbortSignal.timeout(1500),
        headers: adminToken ? { authorization: `Bearer ${adminToken}` } : {},
      });
      if (res.ok) payments = await res.json();
    } catch {
      // seller agent offline — dashboard still renders chain state
    }

    return JSON.parse(JSON.stringify({ network, deployment, agents, jobs, payments, ts: Date.now() }, big));
  }
}
