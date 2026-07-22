import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chainFor, type Deployment, loadDeployment, type NetworkName } from "@agentmesh/shared";
import { AgentMeshClient } from "./client.js";
import { type AgentWallet, walletFromEnv } from "./wallet/index.js";

/** Locate `deployments/<network>.json` by walking up from cwd (monorepo root holds it). */
export function findDeploymentFile(network: NetworkName, startDir = process.cwd()): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "deployments", `${network}.json`);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function readDeployment(network: NetworkName): Deployment {
  const file = findDeploymentFile(network);
  const fromJson = file ? (JSON.parse(readFileSync(file, "utf8")) as Partial<Deployment>) : undefined;
  return loadDeployment(network, fromJson);
}

/** One-call bootstrap for services and scripts: network from AGENTMESH_NETWORK
 *  (default "local"), wallet from env, addresses from deployments file. */
export function meshFromEnv(privateKeyEnv?: string): {
  client: AgentMeshClient;
  wallet: AgentWallet;
  network: NetworkName;
} {
  const network = (process.env.AGENTMESH_NETWORK ?? "local") as NetworkName;
  const chain = chainFor(network);
  const wallet = walletFromEnv(chain, privateKeyEnv);
  const deployment = readDeployment(network);
  return { client: new AgentMeshClient(chain, deployment, wallet), wallet, network };
}
