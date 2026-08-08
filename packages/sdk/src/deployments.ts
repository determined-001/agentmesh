import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chainFor, type Deployment, loadDeployment, type NetworkName } from "@agentmesh/shared";
import { AgentMeshClient } from "./client.js";
import { type AgentWallet, walletFromEnv } from "./wallet/index.js";

/** Locate the deployment artifact. Resolution order:
 *  1. AGENTMESH_DEPLOYMENT_JSON — explicit path (containers, CI, anywhere
 *     outside the monorepo tree);
 *  2. walk up from cwd looking for `deployments/<network>.json` (monorepo). */
export function findDeploymentFile(network: NetworkName, startDir = process.cwd()): string | undefined {
  const explicit = process.env.AGENTMESH_DEPLOYMENT_JSON;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`AGENTMESH_DEPLOYMENT_JSON points to a missing file: ${explicit}`);
    }
    return explicit;
  }
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
  // Env vars (USDC_ADDRESS etc.) still override the JSON inside loadDeployment.
  const deployment = loadDeployment(network, fromJson);
  // A stale or mismatched artifact silently pointed the stack at addresses from
  // another chain; the artifact records the chain it was written for, so say so.
  const expected = chainFor(network).id;
  if (deployment.chainId !== undefined && deployment.chainId !== expected) {
    throw new Error(
      `Deployment artifact${file ? ` ${file}` : ""} is for chainId ${deployment.chainId}, but ${network} is chainId ${expected}`,
    );
  }
  return deployment;
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
