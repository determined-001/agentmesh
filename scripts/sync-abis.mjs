// Extracts contract ABIs from Foundry build output into packages/shared/src/abis
// as typed `as const` TypeScript modules for viem.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "packages/shared/src/abis");
mkdirSync(outDir, { recursive: true });

const contracts = [
  ["AgentRegistry.sol/AgentRegistry.json", "agentRegistryAbi"],
  ["ComplianceGate.sol/ComplianceGate.json", "complianceGateAbi"],
  ["AgentEscrow.sol/AgentEscrow.json", "agentEscrowAbi"],
  ["MockUSDC.sol/MockUSDC.json", "usdcAbi"],
];

for (const [artifact, exportName] of contracts) {
  const { abi } = JSON.parse(readFileSync(join(root, "contracts/out", artifact), "utf8"));
  const file = join(outDir, `${exportName}.ts`);
  writeFileSync(file, `export const ${exportName} = ${JSON.stringify(abi, null, 2)} as const;\n`);
  console.log(`wrote ${file}`);
}
