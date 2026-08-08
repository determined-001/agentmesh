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

| Role       | Env var               | Needs funds? | Powers                            |
| ---------- | --------------------- | ------------ | --------------------------------- |
| Deployer   | `DEPLOYER_PRIVATE_KEY`| yes (gas)    | one-shot deploy, then powerless   |
| Buyer      | `BUYER_PRIVATE_KEY`   | yes          | pays x402 + escrow                |
| Seller     | `SELLER_PRIVATE_KEY`  | yes (gas)    | registers name, delivers jobs     |
| Watcher    | `WATCHER_PRIVATE_KEY` | yes (gas)    | SCREENER role only — screens sellers, releases, refunds |
| Arbiter    | `ARBITER_ADDRESS`     | yes (gas)    | escrow owner: resolves disputes, swaps the gate, pauses  |
| Gate admin | `GATE_ADMIN_ADDRESS`  | no           | grants/revokes screeners, sets verdict TTL |

**These must be six distinct addresses.** The watcher is the only one that runs
online, and it must hold nothing but `SCREENER_ROLE`. Arbiter and gate admin are
cold keys that sign only when a human decides something — a single compromised
hot key must never be able to resolve every dispute, swap the compliance gate,
and screen sellers all at once.

Faucet drips ~1 USDC/day per address — start dripping every address that needs
gas a few days before you need them, or consolidate by transferring. The arbiter
and gate admin sign rarely, so a small balance each is enough.

## 2. Deploy contracts

```bash
cd contracts
AGENTMESH_NETWORK=arc-testnet \
USDC_ADDRESS=0x3600000000000000000000000000000000000000 \
DISPUTE_WINDOW=3600 \
RESOLVE_TIMEOUT=604800 \
VERDICT_TTL=86400 \
GATE_ADMIN_DELAY=172800 \
ARBITER_ADDRESS=<arbiter-address> \
GATE_ADMIN_ADDRESS=<gate-admin-address> \
SCREENER_ADDRESS=<watcher-address> \
forge script script/Deploy.s.sol \
  --rpc-url https://rpc.testnet.arc.network \
  --broadcast --private-key $DEPLOYER_PRIVATE_KEY
```

This writes `deployments/arc-testnet.json` (commit it) and wires every
privileged role in the constructors; the deployer keeps nothing. If any two of
the three role addresses match, the script prints a `WARNING` — do not ship that.

`VERDICT_TTL` is applied at deploy time only when the gate admin *is* the
deployer. With a separate admin (the correct setup), the script logs a note and
the admin calls `setVerdictTtl(86400)` itself afterwards.

**Confirm role separation before trusting the deployment:**

```bash
R=https://rpc.testnet.arc.network
cast call <escrow> "owner()(address)" --rpc-url $R                 # arbiter
cast call <gate> "hasRole(bytes32,address)(bool)" \
  $(cast keccak "SCREENER_ROLE") <watcher> --rpc-url $R            # true
cast call <gate> "hasRole(bytes32,address)(bool)" \
  0x00...00 <watcher> --rpc-url $R                                 # MUST be false
```

Verification: ArcScan is Blockscout-flavored — try
`forge verify-contract --verifier blockscout --verifier-url https://testnet.arcscan.app/api <addr> <contract>`;
if unsupported, note it in the artifact commit and move on.

### Changing the gate admin later

`ComplianceGate` uses OpenZeppelin's `AccessControlDefaultAdminRules`, so
`grantRole(DEFAULT_ADMIN_ROLE, …)` is rejected by design. Hand over in two steps
with a `GATE_ADMIN_DELAY` wait between them:

```bash
cast send <gate> "beginDefaultAdminTransfer(address)" <new-admin> --private-key $OLD_ADMIN_KEY
# ...wait out GATE_ADMIN_DELAY...
cast send <gate> "acceptDefaultAdminTransfer()" --private-key $NEW_ADMIN_KEY
```

### Retiring a previous deployment

Pause the old escrow so no new jobs land on it, then let the in-flight ones
drain through release/refund (pause deliberately does not block those):

```bash
cast send <old-escrow> "pause()" --private-key $OLD_ARBITER_KEY --rpc-url $R
```

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

`DASHBOARD_ACTION_TOKEN` is **required**. `POST /api/action` signs with
`DASHBOARD_PRIVATE_KEY`, so it fails closed: with no token it rejects every
request, including when `AGENTMESH_NETWORK` is unset. The only bypass is
`DASHBOARD_ALLOW_UNAUTHENTICATED=1`, which is honoured solely when
`AGENTMESH_NETWORK=local` — never set it on a deployed host.

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
