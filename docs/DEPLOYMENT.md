# AgentMesh — Arc Testnet Deployment

End-to-end path from zero to a running testnet stack. Local demo needs none of
this (`pnpm demo:local` boots its own chain).

## 0. Facts (verified against docs.arc.io, 2026-07)

| Thing              | Value                                        |
| ------------------ | -------------------------------------------- |
| Chain id           | `5042002`                                    |
| RPC                | `https://rpc.testnet.arc.network`            |
| Explorer           | `https://testnet.arcscan.app`                |
| USDC ERC-20 (6dp)  | `0x3600000000000000000000000000000000000000` |
| Native gas token   | USDC at 18 decimals (same asset)             |
| Faucet             | <https://faucet.circle.com> (~1 USDC/day)    |

## 1. Keys and funding

Four distinct EOAs (never reuse one key across roles off-local — the SDK
refuses to boot):

| Role     | Env var               | Needs funds? | Powers                              |
| -------- | --------------------- | ------------ | ----------------------------------- |
| Deployer | `DEPLOYER_PRIVATE_KEY`| yes (gas)    | one-shot deploy, then powerless     |
| Buyer    | `BUYER_PRIVATE_KEY`   | yes          | pays x402 + escrow                  |
| Seller   | `SELLER_PRIVATE_KEY`  | yes (gas)    | registers name, delivers jobs       |
| Watcher  | `WATCHER_PRIVATE_KEY` | yes (gas)    | SCREENER role + escrow owner/arbiter|

Faucet drips ~1 USDC/day per address — start dripping all four addresses a few
days before you need them, or consolidate by transferring.

## 2. Deploy contracts

```bash
cd contracts
AGENTMESH_NETWORK=arc-testnet \
USDC_ADDRESS=0x3600000000000000000000000000000000000000 \
DISPUTE_WINDOW=3600 \
VERDICT_TTL=86400 \
ARBITER_ADDRESS=<watcher-address> \
GATE_ADMIN_ADDRESS=<watcher-address> \
SCREENER_ADDRESS=<watcher-address> \
forge script script/Deploy.s.sol \
  --rpc-url https://rpc.testnet.arc.network \
  --broadcast --private-key $DEPLOYER_PRIVATE_KEY
```

This writes `deployments/arc-testnet.json` (commit it) and hands every
privileged role to the named addresses; the deployer keeps nothing.

Verification: ArcScan is Blockscout-flavored — try
`forge verify-contract --verifier blockscout --verifier-url https://testnet.arcscan.app/api <addr> <contract>`;
if unsupported, note it in the artifact commit and move on.

## 3. Run services

Docker (recommended — see `docker-compose.yml`):

```bash
cp .env.example .env   # fill AGENTMESH_NETWORK=arc-testnet, keys, DASHBOARD_ACTION_TOKEN
docker compose up -d --build
curl localhost:4021/readyz && curl localhost:4031/readyz
```

Bare (dev): `AGENTMESH_NETWORK=arc-testnet pnpm dev:seller` / `pnpm dev:watcher`.

Dashboard: deploy `apps/dashboard` (Vercel works; it's a stock Next.js app).
Set `AGENTMESH_NETWORK`, `DASHBOARD_PRIVATE_KEY` (usually = buyer),
`DASHBOARD_ACTION_TOKEN`, `SELLER_URL`, and the `*_ADDRESS` overrides (server
less hosts have no deployments/ dir — env overrides beat the JSON).

## 4. Smoke the whole loop

```bash
AGENTMESH_NETWORK=arc-testnet BUYER_PRIVATE_KEY=... pnpm demo:testnet
```

Small defaults on purpose (5 micropayments + $0.25 escrow) — faucet budget.
Record the printed explorer links in `docs/testnet-verification.md`.

## 5. Extension

`node scripts/pack-extension.mjs` → `extension.zip`. Before distributing
against a deployed dashboard, change `host_permissions` and the `API` constant
in `apps/extension/popup.js` from localhost to the dashboard origin, and set
the action token in the popup's Settings section.
