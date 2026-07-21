import { NextResponse } from "next/server";
import { createPublicClient, http, type Address } from "viem";
import {
  agentRegistryAbi,
  agentEscrowAbi,
  complianceGateAbi,
  usdcAbi,
  chainFor,
  type NetworkName,
} from "@agentmesh/shared";
import { readDeployment } from "@agentmesh/sdk";

export const dynamic = "force-dynamic";

const network = (process.env.AGENTMESH_NETWORK ?? "local") as NetworkName;
const SELLER_URL = process.env.SELLER_URL ?? "http://localhost:4021";

const big = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export async function GET() {
  try {
    const deployment = readDeployment(network);
    const client = createPublicClient({ chain: chainFor(network), transport: http() });

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
      })
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
      })
    );

    let payments: unknown = { count: 0, payments: [] };
    try {
      const res = await fetch(`${SELLER_URL}/payments`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) payments = await res.json();
    } catch {
      // seller agent offline — dashboard still renders chain state
    }

    const body = JSON.parse(
      JSON.stringify({ network, deployment, agents, jobs, payments, ts: Date.now() }, big)
    );
    return NextResponse.json(body);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message, network }, { status: 500 });
  }
}
