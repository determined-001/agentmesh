# AgentMesh — Compliant Agent-to-Agent Settlement on Arc

> **Stripe + escrow + KYC for the agent economy.** Every AI agent gets a named, compliant wallet on Arc, pays peers per-call via x402 micropayments, and settles high-value jobs through automated, screened escrow.

Built for the Circle/Arc **Programmable Money Hackathon** (Agentic Economy track).

## Why

AI agents are becoming economic actors, but they can't hold bank accounts, card rails choke on sub-cent payments (~$0.30 minimum fee), and nobody wants an autonomous agent wiring $5,000 to an unscreened counterparty. Arc fixes the rails — USDC as native gas, sub-second finality — and AgentMesh adds the missing trust stack:

| Layer | What it does | Powered by |
|---|---|---|
| **Identity** | Named agent wallets (`databot.agent.arc`) with ERC-8004-aligned agent cards | ERC-721 registry + Circle Wallets (SCA) |
| **Payments** | Sub-cent, per-call x402 micropayments settled in USDC | x402 handshake on Arc (Gateway Nanopayments upgrade path) |
| **Settlement** | High-value jobs locked in escrow: deliver → dispute window → release | `AgentEscrow.sol` in USDC |
| **Compliance** | Sellers screened before funds ever release | Circle Compliance Engine (or labeled allowlist fallback) via on-chain `ComplianceGate` |
| **Automation** | Watcher auto-releases on delivery, refunds on missed deadlines | Event-driven watcher service |
| **Agent brain** | Any MCP-capable model (Claude, etc.) plugs in as a first-class agent | `@agentmesh/mcp-server` |

## Architecture

```
contracts/          Foundry — AgentRegistry (ERC-721 names), AgentEscrow, ComplianceGate
packages/shared     chain config (Arc Testnet 5042002), ABIs, x402 wire types
packages/sdk        viem client, wallet providers (EOA ⇄ Circle DCW), paidFetch (x402)
apps/mcp-server     MCP tools: register_agent, pay_x402, create_escrow_job, …
apps/seller-agent   "DataAgent" — x402-priced API + escrow job worker
apps/watcher        screening + auto-release/refund automation
apps/dashboard      Next.js live view: agents, payment stream, escrow timeline
apps/extension      MV3 popup: balances, approve-release / dispute buttons
demo/               end-to-end runners (local anvil + Arc Testnet)
```

**Escrow lifecycle:** `createJob` (buyer funds USDC) → `deliver` (seller submits proof hash) → dispute window → `release` (buyer anytime; watcher after window; **blocked unless the seller passes compliance screening**) — with `dispute`/arbiter-resolution and deadline-`refund` branches.

## Quickstart

```bash
# prerequisites: node ≥20, pnpm, foundry (forge/anvil)
pnpm install
node scripts/sync-abis.mjs      # after any contract change

# contract tests (21 passing)
pnpm test:contracts

# full e2e demo on a local anvil chain — boots everything:
# naming → 50 x402 micropayments → screened $5 escrow → delivery →
# watcher auto-release → dispute/refund branch, with balance assertions
pnpm demo:local
```

While the demo runs (or after it), watch it live:

```bash
pnpm dev:dashboard              # http://localhost:3000
```

Load the extension: `chrome://extensions` → Developer mode → **Load unpacked** → `apps/extension/`.

## Connect your model (MCP)

The buyer agent's "brain" is whatever model you connect. With Claude Code:

```bash
claude mcp add agentmesh \
  -e AGENTMESH_NETWORK=local -e BUYER_PRIVATE_KEY=0x... \
  -- pnpm --filter @agentmesh/mcp-server start
```

Then the model can drive the full lifecycle with tools: `register_agent`, `list_agents`, `resolve_agent`, `get_balance`, `pay_x402`, `create_escrow_job`, `get_job`, `release_escrow`, `dispute_job`, `fetch_deliverable`, `screen_address`.

Intent flow: *"Get me a market report, budget $5, release on delivery"* → the model resolves `databot`, samples its x402 endpoints for pennies, locks $5 in escrow, and the mesh handles screening, delivery detection, and release.

## Arc Testnet

```bash
# 1. deploy (USDC_ADDRESS = the Arc Testnet USDC ERC-20 address; fund the deployer from the Circle faucet)
cd contracts
USDC_ADDRESS=<arc-usdc> forge script script/Deploy.s.sol \
  --rpc-url $ARC_TESTNET_RPC_URL --broadcast --private-key $DEPLOYER_PRIVATE_KEY

# 2. record addresses in deployments/arc-testnet.json (see deployments/local.json for shape)

# 3. run services + demo
AGENTMESH_NETWORK=arc-testnet SELLER_PRIVATE_KEY=... pnpm dev:seller
AGENTMESH_NETWORK=arc-testnet WATCHER_PRIVATE_KEY=... pnpm dev:watcher
AGENTMESH_NETWORK=arc-testnet BUYER_PRIVATE_KEY=... pnpm demo:testnet   # prints explorer links
```

Note Arc's decimals gotcha: USDC is **18 decimals as native gas**, **6 decimals at the ERC-20 interface** — all AgentMesh amounts use the 6-decimal ERC-20 side.

## Circle product map

| Product | Status in AgentMesh |
|---|---|
| **USDC on Arc (native gas)** | ✅ all settlement, both x402 and escrow |
| **Circle Wallets (Developer-Controlled, SCA)** | ✅ adapter behind `WALLET_PROVIDER=circle` (EOA fallback default until API key configured) |
| **x402 / Nanopayments** | ✅ x402 handshake (402 → pay → retry, on-chain verification); direct-transfer settlement today, Gateway batching upgrade path |
| **Compliance Engine** | ✅ watcher screens via API when `CIRCLE_COMPLIANCE_API_KEY` set; labeled local-allowlist fallback otherwise |
| **Gas Station / CCTP / EURC** | roadmap — gasless onboarding + cross-chain withdrawal beats |

## Security / honesty notes

- Fallback screening (no Compliance Engine key) is **clearly labeled** in watcher logs — no pretend compliance.
- The extension holds **no keys**; actions proxy through the dashboard's server-side wallet.
- `AgentEscrow` uses OpenZeppelin `SafeERC20` + `ReentrancyGuard`; escrow release is impossible for screened-out sellers — funds fall back to dispute/refund paths.
- Demo keys are anvil's well-known development accounts; never use them beyond local testing.
