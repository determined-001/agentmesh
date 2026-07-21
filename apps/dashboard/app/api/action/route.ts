import { NextResponse } from "next/server";
import { meshFromEnv } from "@agentmesh/sdk";

export const dynamic = "force-dynamic";

/** Human-oversight actions proxied for the browser extension (which holds no
 *  keys). Requires DASHBOARD_PRIVATE_KEY — in the demo, the buyer's key, so
 *  "approve" = buyer-release and "dispute" = buyer-dispute. */
export async function POST(req: Request) {
  const { action, jobId } = (await req.json()) as { action: string; jobId: string };
  if (!process.env.DASHBOARD_PRIVATE_KEY && !process.env.PRIVATE_KEY) {
    return NextResponse.json({ error: "DASHBOARD_PRIVATE_KEY not configured" }, { status: 400 });
  }
  try {
    const { client } = meshFromEnv("DASHBOARD_PRIVATE_KEY");
    let txHash: string;
    if (action === "release") txHash = await client.releaseEscrow(BigInt(jobId));
    else if (action === "dispute") txHash = await client.disputeJob(BigInt(jobId));
    else return NextResponse.json({ error: `unknown action ${action}` }, { status: 400 });
    return NextResponse.json({ ok: true, action, jobId, txHash });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
