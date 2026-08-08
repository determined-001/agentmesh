import { randomUUID } from "node:crypto";
import {
  DELIVERABLE_AUTH_HEADER,
  deliverableAuthMessage,
  encodeDeliverableAuth,
  safeFetch,
} from "@agentmesh/shared";
import type { AgentMeshClient } from "./client.js";

export interface Deliverable {
  jobId: string;
  report: string;
  deliveredTx?: string;
}

/** Fetch the deliverable for an escrow job from the seller's endpoint,
 *  authenticating as the job's buyer.
 *
 *  The seller checks the signature against `job.buyer` on-chain, so this only
 *  works from the wallet that actually funded the job. Shared by the MCP tool
 *  and the demo runners so there is one signing implementation. */
export async function fetchDeliverable(
  mesh: AgentMeshClient,
  endpoint: string,
  jobId: bigint | string,
  opts: { ttlMs?: number } = {},
): Promise<Deliverable> {
  const id = jobId.toString();
  const nonce = randomUUID();
  const expiry = Date.now() + (opts.ttlMs ?? 60_000);
  const signature = await mesh.wallet.signMessage(deliverableAuthMessage(id, nonce, expiry));
  const address = await mesh.wallet.getAddress();

  const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
  const url = new URL(`./jobs/${id}/deliverable`, base).toString();

  const res = await safeFetch(url, {
    allowPrivate: mesh.deployment.network === "local",
    init: {
      headers: { [DELIVERABLE_AUTH_HEADER]: encodeDeliverableAuth({ address, nonce, expiry, signature }) },
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`deliverable fetch failed for job ${id}: HTTP ${res.status} ${body}`);
  }
  return (await res.json()) as Deliverable;
}
