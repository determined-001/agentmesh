import type { AgentMeshClient } from "@agentmesh/sdk";
import {
  decodePaymentHeader,
  type NetworkName,
  type PaymentRequirements,
  usdcAbi,
  X_PAYMENT_HEADER,
  X_PAYMENT_RESPONSE_HEADER,
} from "@agentmesh/shared";
import type { Context, Next } from "hono";
import { type Address, parseEventLogs } from "viem";

export interface PaymentRecord {
  ts: number;
  from: Address;
  amount: string; // base units
  txHash: `0x${string}`;
  resource: string;
}

export interface X402Options {
  mesh: AgentMeshClient;
  network: NetworkName;
  payTo: Address;
  payments: PaymentRecord[]; // shared log, surfaced at /payments for the dashboard
}

const usedTxHashes = new Set<string>();

/** Hono middleware implementing the x402 handshake with on-chain USDC settlement
 *  verification (agentmesh-direct scheme). `price` is USDC base units (6 dp). */
export function priced(price: bigint, description: string, opts: X402Options) {
  return async (c: Context, next: Next) => {
    const header = c.req.header(X_PAYMENT_HEADER);
    const resource = new URL(c.req.url).pathname;

    if (!header) {
      const requirements: PaymentRequirements = {
        x402Version: 1,
        scheme: "agentmesh-direct",
        network: opts.network,
        payTo: opts.payTo,
        asset: opts.mesh.deployment.usdc,
        maxAmountRequired: price.toString(),
        resource,
        description,
      };
      return c.json(requirements, 402);
    }

    let payload;
    try {
      payload = decodePaymentHeader(header);
    } catch {
      return c.json({ error: "malformed X-PAYMENT header" }, 400);
    }

    const { txHash, from, to, amount } = payload.payload;
    if (payload.network !== opts.network) return c.json({ error: "wrong network" }, 402);
    if (to.toLowerCase() !== opts.payTo.toLowerCase()) return c.json({ error: "wrong payee" }, 402);
    if (BigInt(amount) < price) return c.json({ error: "insufficient payment" }, 402);
    if (usedTxHashes.has(txHash.toLowerCase())) return c.json({ error: "payment already used" }, 402);

    // Verify the USDC transfer actually settled on Arc.
    let receipt;
    try {
      receipt = await opts.mesh.publicClient.getTransactionReceipt({ hash: txHash });
    } catch {
      return c.json({ error: "payment tx not found" }, 402);
    }
    if (receipt.status !== "success") return c.json({ error: "payment tx reverted" }, 402);
    const transfers = parseEventLogs({ abi: usdcAbi, logs: receipt.logs, eventName: "Transfer" });
    const match = transfers.find(
      (t) =>
        t.address.toLowerCase() === opts.mesh.deployment.usdc.toLowerCase() &&
        (t.args.from as string).toLowerCase() === from.toLowerCase() &&
        (t.args.to as string).toLowerCase() === opts.payTo.toLowerCase() &&
        (t.args.value as bigint) >= price,
    );
    if (!match) return c.json({ error: "no matching USDC transfer in tx" }, 402);

    usedTxHashes.add(txHash.toLowerCase());
    opts.payments.push({ ts: Date.now(), from, amount, txHash, resource });
    c.header(
      X_PAYMENT_RESPONSE_HEADER,
      Buffer.from(JSON.stringify({ settled: true, txHash, network: opts.network })).toString("base64"),
    );
    await next();
  };
}
