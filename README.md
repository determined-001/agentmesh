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

# tests + checks
pnpm test:contracts             # 51 Foundry tests (unit + fuzz + invariant)
pnpm test                       # 34 vitest tests (SDK, x402, stores)
pnpm typecheck && pnpm lint     # tsc + biome (same gates as CI)

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

Full guide: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) · operations: [docs/RUNBOOK.md](docs/RUNBOOK.md)

### Deployed contracts

Live on Arc Testnet (chain id `5042002`), verified on ArcScan. Happy path,
dispute→arbiter, and blocked-seller→`refundBlocked` all exercised end-to-end
against these — see [docs/testnet-verification.md](docs/testnet-verification.md).

| Contract | Address |
| --- | --- |
| AgentRegistry | [`0xaF9F344839699B098F7E469669d3F81e2B39879A`](https://testnet.arcscan.app/address/0xaf9f344839699b098f7e469669d3f81e2b39879a) |
| ComplianceGate | [`0x1a0fCa0e1f79Fb9F7003b111948Ce3b2be837F53`](https://testnet.arcscan.app/address/0x1a0fca0e1f79fb9f7003b111948ce3b2be837f53) |
| AgentEscrow | [`0xace347d8d4ac669E7B1a6247042F4c00A1c4cf7B`](https://testnet.arcscan.app/address/0xace347d8d4ac669e7b1a6247042f4c00a1c4cf7b) |

```bash
# 1. deploy — writes deployments/arc-testnet.json automatically
cd contracts
AGENTMESH_NETWORK=arc-testnet \
USDC_ADDRESS=0x3600000000000000000000000000000000000000 \
DISPUTE_WINDOW=3600 ARBITER_ADDRESS=<watcher> SCREENER_ADDRESS=<watcher> GATE_ADMIN_ADDRESS=<watcher> \
forge script script/Deploy.s.sol \
  --rpc-url https://rpc.testnet.arc.network --broadcast --private-key $DEPLOYER_PRIVATE_KEY

# 2. run services (docker compose up -d --build, or bare:)
AGENTMESH_NETWORK=arc-testnet SELLER_PRIVATE_KEY=... pnpm dev:seller
AGENTMESH_NETWORK=arc-testnet WATCHER_PRIVATE_KEY=... pnpm dev:watcher

# 3. smoke the whole loop (faucet-sized amounts; prints explorer links)
AGENTMESH_NETWORK=arc-testnet BUYER_PRIVATE_KEY=... pnpm demo:testnet
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

- x402 payments are **payer-bound**: server-issued single-use quotes + a payer signature over `quoteId‖txHash`; observed transfers can't be claimed by third parties, replays are rejected, and the replay set survives restarts (SQLite).
- Fallback screening (no Compliance Engine key) is **clearly labeled** in watcher logs — no pretend compliance. Compliance-API outages **fail closed** (default-deny), never open.
- Blocked sellers can never be paid — not even by the arbiter. `refundBlocked()` lets anyone return funds to the buyer, so compliance blocks can't strand money.
- The extension holds **no keys**; actions proxy through the dashboard's `/api/action`, which requires a bearer token (`DASHBOARD_ACTION_TOKEN`) off-local.
- `AgentEscrow`: OpenZeppelin `SafeERC20` + `ReentrancyGuard` + `Ownable2Step` + `Pausable` (pause blocks new jobs only — funds-out paths are never pausable). Invariant-tested: escrow balance always equals the sum of open jobs; no double payout.
- Services are restart-safe (kill -9 drill in CI-adjacent testing): watcher resumes pending releases from durable state; seller keeps payment history and replay protection.
- Demo keys are anvil's well-known development accounts; never use them beyond local testing.
