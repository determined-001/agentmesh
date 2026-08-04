import {
  agentEscrowAbi,
  agentRegistryAbi,
  complianceGateAbi,
  type Deployment,
  usdcAbi,
} from "@agentmesh/shared";
import {
  type Address,
  type Chain,
  createPublicClient,
  type Hex,
  http,
  keccak256,
  type PublicClient,
  toHex,
} from "viem";
import type { AgentWallet } from "./wallet/index.js";

export interface AgentCard {
  name: string;
  wallet: Address;
  endpoint: string;
  cardURI: string;
  registeredAt: bigint;
}

export interface EscrowJob {
  buyer: Address;
  seller: Address;
  amount: bigint;
  deadline: bigint;
  deliveredAt: bigint;
  specHash: Hex;
  deliverableHash: Hex;
  status: number; // 0 None 1 Funded 2 Delivered 3 Disputed 4 Released 5 Refunded
}

export const JOB_STATUS = ["None", "Funded", "Delivered", "Disputed", "Released", "Refunded"] as const;

/** High-level client over the AgentMesh contracts: naming registry, escrow,
 *  compliance gate, and USDC. Works with any AgentWallet (EOA or Circle). */
export class AgentMeshClient {
  readonly publicClient: PublicClient;

  constructor(
    readonly chain: Chain,
    readonly deployment: Deployment,
    readonly wallet: AgentWallet,
  ) {
    this.publicClient = createPublicClient({ chain, transport: http(), pollingInterval: 500 });
  }

  // ---------- registry ----------

  async registerAgent(name: string, endpoint: string, cardURI = ""): Promise<Hex> {
    const tx = await this.wallet.writeContract({
      address: this.deployment.agentRegistry,
      abi: agentRegistryAbi,
      functionName: "register",
      args: [name, endpoint, cardURI],
    });
    await this.wallet.waitForReceipt(tx);
    return tx;
  }

  async resolveAgent(name: string): Promise<{ wallet: Address; card: AgentCard }> {
    const [wallet, card] = (await this.publicClient.readContract({
      address: this.deployment.agentRegistry,
      abi: agentRegistryAbi,
      functionName: "resolve",
      args: [name],
    })) as [Address, AgentCard];
    return { wallet, card };
  }

  async isRegistered(name: string): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.deployment.agentRegistry,
      abi: agentRegistryAbi,
      functionName: "isRegistered",
      args: [name],
    })) as boolean;
  }

  async listAgents(offset = 0n, limit = 100n): Promise<AgentCard[]> {
    return (await this.publicClient.readContract({
      address: this.deployment.agentRegistry,
      abi: agentRegistryAbi,
      functionName: "listAgents",
      args: [offset, limit],
    })) as AgentCard[];
  }

  // ---------- USDC ----------

  async usdcBalance(account?: Address): Promise<bigint> {
    const addr = account ?? (await this.wallet.getAddress());
    return (await this.publicClient.readContract({
      address: this.deployment.usdc,
      abi: usdcAbi,
      functionName: "balanceOf",
      args: [addr],
    })) as bigint;
  }

  async transferUsdc(to: Address, amount: bigint): Promise<Hex> {
    const tx = await this.wallet.writeContract({
      address: this.deployment.usdc,
      abi: usdcAbi,
      functionName: "transfer",
      args: [to, amount],
    });
    await this.wallet.waitForReceipt(tx);
    return tx;
  }

  async approveUsdc(spender: Address, amount: bigint): Promise<Hex> {
    const tx = await this.wallet.writeContract({
      address: this.deployment.usdc,
      abi: usdcAbi,
      functionName: "approve",
      args: [spender, amount],
    });
    await this.wallet.waitForReceipt(tx);
    return tx;
  }

  // ---------- escrow ----------

  /** Approve + createJob. Returns the new job id (from the JobCreated event). */
  async createEscrowJob(params: {
    seller: Address;
    amount: bigint;
    deadline: bigint; // unix seconds
    spec: string;
  }): Promise<{ jobId: bigint; txHash: Hex }> {
    await this.approveUsdc(this.deployment.agentEscrow, params.amount);
    const txHash = await this.wallet.writeContract({
      address: this.deployment.agentEscrow,
      abi: agentEscrowAbi,
      functionName: "createJob",
      args: [params.seller, params.amount, params.deadline, keccak256(toHex(params.spec))],
    });
    const receipt = await this.wallet.waitForReceipt(txHash);
    // JobCreated(uint256 indexed jobId, ...) — jobId is topic 1 of the escrow's log
    const log = receipt.logs.find(
      (l) => l.address.toLowerCase() === this.deployment.agentEscrow.toLowerCase(),
    );
    const jobId = log ? BigInt(log.topics[1]!) : 0n;
    return { jobId, txHash };
  }

  async deliverJob(jobId: bigint, deliverable: string): Promise<Hex> {
    const tx = await this.wallet.writeContract({
      address: this.deployment.agentEscrow,
      abi: agentEscrowAbi,
      functionName: "deliver",
      args: [jobId, keccak256(toHex(deliverable))],
    });
    await this.wallet.waitForReceipt(tx);
    return tx;
  }

  async releaseEscrow(jobId: bigint): Promise<Hex> {
    const tx = await this.wallet.writeContract({
      address: this.deployment.agentEscrow,
      abi: agentEscrowAbi,
      functionName: "release",
      args: [jobId],
    });
    await this.wallet.waitForReceipt(tx);
    return tx;
  }

  async disputeJob(jobId: bigint): Promise<Hex> {
    const tx = await this.wallet.writeContract({
      address: this.deployment.agentEscrow,
      abi: agentEscrowAbi,
      functionName: "dispute",
      args: [jobId],
    });
    await this.wallet.waitForReceipt(tx);
    return tx;
  }

  async resolveDispute(jobId: bigint, releaseToSeller: boolean): Promise<Hex> {
    const tx = await this.wallet.writeContract({
      address: this.deployment.agentEscrow,
      abi: agentEscrowAbi,
      functionName: "resolveDispute",
      args: [jobId, releaseToSeller],
    });
    await this.wallet.waitForReceipt(tx);
    return tx;
  }

  async refundJob(jobId: bigint): Promise<Hex> {
    const tx = await this.wallet.writeContract({
      address: this.deployment.agentEscrow,
      abi: agentEscrowAbi,
      functionName: "refund",
      args: [jobId],
    });
    await this.wallet.waitForReceipt(tx);
    return tx;
  }

  /** Compliance escape hatch: refunds the buyer of a Delivered/Disputed job
   *  whose seller has since failed screening. Callable by anyone. */
  async refundBlocked(jobId: bigint): Promise<Hex> {
    const tx = await this.wallet.writeContract({
      address: this.deployment.agentEscrow,
      abi: agentEscrowAbi,
      functionName: "refundBlocked",
      args: [jobId],
    });
    await this.wallet.waitForReceipt(tx);
    return tx;
  }

  async getJob(jobId: bigint): Promise<EscrowJob> {
    return (await this.publicClient.readContract({
      address: this.deployment.agentEscrow,
      abi: agentEscrowAbi,
      functionName: "getJob",
      args: [jobId],
    })) as EscrowJob;
  }

  async nextJobId(): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.deployment.agentEscrow,
      abi: agentEscrowAbi,
      functionName: "nextJobId",
    })) as bigint;
  }

  // ---------- compliance ----------

  async isAllowed(account: Address): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.deployment.complianceGate,
      abi: complianceGateAbi,
      functionName: "isAllowed",
      args: [account],
    })) as boolean;
  }

  /** Screener-only: push a screening verdict on-chain. */
  async setAllowed(account: Address, allowed: boolean, reason: string): Promise<Hex> {
    const tx = await this.wallet.writeContract({
      address: this.deployment.complianceGate,
      abi: complianceGateAbi,
      functionName: "setAllowed",
      args: [account, allowed, keccak256(toHex(reason))],
    });
    await this.wallet.waitForReceipt(tx);
    return tx;
  }
}
