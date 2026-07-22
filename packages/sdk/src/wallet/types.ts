import type { Abi, Address, Hex, TransactionReceipt } from "viem";

export interface WriteContractParams {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

/** Abstraction over how an agent signs and submits Arc transactions.
 *  Implementations: ViemEoaWallet (local private key) and CircleWallet
 *  (Circle Developer-Controlled Wallets API). Selected via WALLET_PROVIDER env. */
export interface AgentWallet {
  readonly kind: "eoa" | "circle";
  getAddress(): Promise<Address>;
  writeContract(params: WriteContractParams): Promise<Hex>;
  waitForReceipt(txHash: Hex): Promise<TransactionReceipt>;
  /** Sign an arbitrary message (EIP-191). Used to bind x402 payment claims to the payer. */
  signMessage(message: string): Promise<Hex>;
}
