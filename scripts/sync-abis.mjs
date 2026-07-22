// Extracts contract ABIs from Foundry build output into packages/shared/src/abis
// as typed `as const` TypeScript modules for viem.
//
// Usage:
//   node scripts/sync-abis.mjs          write ABI modules
//   node scripts/sync-abis.mjs --check  exit 1 if modules are out of sync (CI drift gate)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "packages/shared/src/abis");
const checkMode = process.argv.includes("--check");
mkdirSync(outDir, { recursive: true });

const contracts = [
  ["AgentRegistry.sol/AgentRegistry.json", "agentRegistryAbi"],
  ["ComplianceGate.sol/ComplianceGate.json", "complianceGateAbi"],
  ["AgentEscrow.sol/AgentEscrow.json", "agentEscrowAbi"],
];

// usdcAbi is a hand-curated minimal ERC-20 surface, NOT generated from MockUSDC:
// the deployed testnet/mainnet USDC is not our mock, so the shared ABI must only
// promise standard ERC-20 members. `mint` is included for the local MockUSDC path
// and simply reverts/doesn't exist on real USDC.
const erc20Abi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "transferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Approval",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "spender", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
];

function render(exportName, abi) {
  return `export const ${exportName} = ${JSON.stringify(abi, null, 2)} as const;\n`;
}

let drift = false;

function emit(exportName, content) {
  const file = join(outDir, `${exportName}.ts`);
  if (checkMode) {
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (current !== content) {
      console.error(`DRIFT: ${file} out of sync with contracts/out — run: node scripts/sync-abis.mjs`);
      drift = true;
    }
    return;
  }
  writeFileSync(file, content);
  console.log(`wrote ${file}`);
}

for (const [artifact, exportName] of contracts) {
  const { abi } = JSON.parse(readFileSync(join(root, "contracts/out", artifact), "utf8"));
  emit(exportName, render(exportName, abi));
}
emit("usdcAbi", render("usdcAbi", erc20Abi));

if (checkMode) {
  if (drift) process.exit(1);
  console.log("ABIs in sync.");
}
