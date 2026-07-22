import { timingSafeEqual } from "node:crypto";
import { meshFromEnv } from "@agentmesh/sdk";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const ACTIONS = new Set(["release", "dispute"]);
const JOB_ID_RE = /^\d{1,18}$/;

/** Bearer-token gate. This route signs with DASHBOARD_PRIVATE_KEY (the buyer's
 *  key in the demo), so it must never be an open endpoint: any page a user
 *  visits could otherwise POST release/dispute. Token is required except on the
 *  local demo network with no token configured. */
function authorized(req: Request): boolean {
  const token = process.env.DASHBOARD_ACTION_TOKEN ?? "";
  if (!token) return (process.env.AGENTMESH_NETWORK ?? "local") === "local";
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Human-oversight actions proxied for the browser extension (which holds no
 *  keys). Requires DASHBOARD_PRIVATE_KEY — in the demo, the buyer's key, so
 *  "approve" = buyer-release and "dispute" = buyer-dispute. */
export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { action, jobId } = (body ?? {}) as { action?: unknown; jobId?: unknown };
  if (typeof action !== "string" || !ACTIONS.has(action)) {
    return NextResponse.json({ error: "action must be release|dispute" }, { status: 400 });
  }
  if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) {
    return NextResponse.json({ error: "jobId must be a decimal string" }, { status: 400 });
  }
  if (!process.env.DASHBOARD_PRIVATE_KEY && !process.env.PRIVATE_KEY) {
    return NextResponse.json({ error: "DASHBOARD_PRIVATE_KEY not configured" }, { status: 400 });
  }
  try {
    const { client } = meshFromEnv("DASHBOARD_PRIVATE_KEY");
    const txHash =
      action === "release" ? await client.releaseEscrow(BigInt(jobId)) : await client.disputeJob(BigInt(jobId));
    return NextResponse.json({ ok: true, action, jobId, txHash });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
