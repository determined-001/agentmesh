import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AgentWallet, WriteContractParams } from "./types.js";

/** Local private-key wallet. Default provider until a Circle Developer Console
 *  API key is configured (WALLET_PROVIDER=circle). */
export class ViemEoaWallet implements AgentWallet {
  readonly kind = "eoa" as const;
  readonly account: Account;
  readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;

  constructor(privateKey: Hex, chain: Chain) {
    this.account = privateKeyToAccount(privateKey);
    this.publicClient = createPublicClient({ chain, transport: http(), pollingInterval: 500 });
    this.walletClient = createWalletClient({ account: this.account, chain, transport: http() });
  }

  async getAddress(): Promise<Address> {
    return this.account.address;
  }

  async writeContract(params: WriteContractParams): Promise<Hex> {
    const { request } = await this.publicClient.simulateContract({
      account: this.account,
      address: params.address,
      abi: params.abi,
      functionName: params.functionName,
      args: params.args as unknown[],
    });
    return this.walletClient.writeContract(request);
  }

  async waitForReceipt(txHash: Hex): Promise<TransactionReceipt> {
    return this.publicClient.waitForTransactionReceipt({ hash: txHash });
  }
}
