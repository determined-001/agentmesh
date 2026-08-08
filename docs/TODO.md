# AgentMesh — Remaining Work

Status as of 2026-07-23. Phases 1–4 and 6 (Docker/docs) are **done, tested, and
pushed** (51 Foundry + 34 vitest tests, CI green, kill-9 resilience drill
passed). What remains is the Arc Testnet launch (Phase 5) plus two small ops
items — most of it blocked on faucet-funded wallets, which only you can do.

Full plan: `~/.claude/plans/virtual-seeking-piglet.md` · Deploy steps:
[DEPLOYMENT.md](DEPLOYMENT.md) · Ops: [RUNBOOK.md](RUNBOOK.md)

---

## Phase 5 — Arc Testnet launch

**Signer = Circle agent wallets** (Circle Developer-Controlled Wallets). The
Circle API key is being obtained; once it lands, set `WALLET_PROVIDER=circle`
plus `CIRCLE_API_KEY` / `CIRCLE_ENTITY_SECRET` / `CIRCLE_WALLET_ID` /
`CIRCLE_WALLET_ADDRESS` and the stack signs with Circle wallets — no code
change. The EOA path stays only as the local-demo fallback.

- [x] **Obtain Circle API key** (Developer Console) — the one gate on the whole
      Circle path. Create the developer-controlled wallets there.
- [x] **Fund the agent wallets** from <https://faucet.circle.com> (Arc Testnet),
      ~1 USDC/day per address. USDC is also the gas token on Arc, so one asset
      funds everything. Roles: buyer, seller, watcher (+ deployer for the
      one-shot deploy).
- [x] **Deploy contracts** — one command in [DEPLOYMENT.md](DEPLOYMENT.md) §2.
      Writes `deployments/arc-testnet.json` (commit it) and hands every
      privileged role to the watcher address.
      USDC = `0x3600000000000000000000000000000000000000` (6dp),
      `DISPUTE_WINDOW=3600`, `VERDICT_TTL=86400`.
- [x] **Try contract verification** on ArcScan (Blockscout-flavored;
      `forge verify-contract --verifier blockscout --verifier-url https://testnet.arcscan.app/api`).
      If unsupported, note it in the artifact commit and move on.
      → All 3 contracts verified.
- [x] **Run services** against testnet (docker compose, or `pnpm dev:seller` /
      `pnpm dev:watcher` with `AGENTMESH_NETWORK=arc-testnet`). Confirm
      `:4021/readyz` and `:4031/readyz` return 200.
- [x] **Full testnet e2e** — happy path (`pnpm demo:testnet`), dispute →
      arbiter (`pnpm demo:testnet-dispute`), blocked-seller → `refundBlocked`
      (`pnpm demo:testnet-blocked`). All confirmed on-chain, see
      [testnet-verification.md](testnet-verification.md). Found + fixed
      3 real bugs along the way: x402 signature verification rejected Circle
      SCA wallets; unbounded eth_getLogs range growth on RPC failure;
      `refundBlocked()` had no SDK wrapper.
- [ ] **48h unattended soak** — services pointed at testnet, watch pino logs,
      induce ≥1 restart of each and confirm recovery.
- [ ] **Circle Compliance Engine screening** — set `CIRCLE_COMPLIANCE_API_KEY`
      so the watcher screens sellers via Circle instead of the local denylist
      fallback. Same key family as the wallets.

## Phase 7 — security remediation (2026-08-07)

A security + production-readiness review found 20 issues, four proven with
working exploits. All code fixes are landed and verified; what remains needs
faucet-funded wallets, so only you can do it.

- [x] **x402 double-spend** — the replay check spanned two awaits and used
      `INSERT OR IGNORE`, so N concurrent claims of one payment all settled.
      Now a single IMMEDIATE transaction; `used_tx` PK is the last line of
      defence. Regression test fires 10 concurrent claims.
- [x] **Unvalidated payee** — `paidFetch` trusted `payTo`/`network` from the
      402 body. Now: endpoint guard, network assert, required `PayeePolicy`,
      required `maxAmount`, plus a `SpendBudget` the connected model cannot
      raise (`X402_MAX_PER_CALL_USD` / `X402_MAX_TOTAL_USD`).
- [x] **`/api/action` open by default** — unset `AGENTMESH_NETWORK` counted as
      "local". Now fails closed; local demos opt in via
      `DASHBOARD_ALLOW_UNAUTHENTICATED=1`.
- [x] **`refundBlocked` griefing** — "unscreened" was indistinguishable from
      "blocked", so anyone could cancel a delivered job during a screening gap
      or watcher outage. Gate now exposes `isBlocked` (affirmative deny only);
      `refundUnresolved` is the timeout backstop that keeps such jobs from
      locking forever.
- [x] Deliverables + payment ledger authenticated; per-IP rate limiting;
      payload schema validation; deferred payout on blacklist; two-step gate
      admin; cursor durability; `safeFetch` redirect re-validation; container
      hardened; extension token off `storage.sync`.
- [x] **Dependencies**: 20 advisories (9 high) → **0**.
- [x] **CI green again** — `pnpm lint` was failing; slither is now blocking and
      a `pnpm audit --prod --audit-level high` gate was added.

- [ ] **Redeploy Arc Testnet with separated roles** — BLOCKED ON YOU. The live
      deployment has one Circle SCA holding escrow arbiter + gate admin +
      screener, and it is the watcher's hot key. The contracts also changed, so
      a redeploy is required either way. Needs three faucet-funded wallets; see
      [DEPLOYMENT.md](DEPLOYMENT.md) §1–2. Afterwards refresh
      `deployments/arc-testnet.json`, `README.md`,
      [testnet-verification.md](testnet-verification.md), and `pause()` the old
      escrow.

### Known limitation, deliberately not fixed

**Registry name squatting / front-running.** `AgentRegistry.register()` is
first-come and visible in the mempool, and names never expire, so a valuable
name can be sniped or held forever. The fix is commit–reveal, which makes every
registration a two-transaction flow. Judged not worth that cost while names are
free and have no resale market — revisit if either changes.

## Phase 6 — ops (not blocked; can do anytime)

- [ ] **Hosting decision** (deliberately left open). Recommendation:
      dashboard on Vercel (stock Next.js; token-authed `/api/action` works
      serverless) + seller-agent & watcher on one Fly.io machine or small VM
      via `docker-compose.yml` with a persistent volume (long-running pollers +
      SQLite must NOT be serverless).
- [ ] **Uptime monitoring** — point a free pinger (healthchecks.io /
      UptimeRobot) at both `/readyz` URLs once hosts exist; alert on 503/timeout.

---

## Not doing (explicit scope cuts)

- Mainnet deploy / paid security audit — out of scope for this push (target was
  a rock-solid testnet launch).
- npm publishing of `@agentmesh/sdk` / `@agentmesh/shared` — metadata is in
  place, but no changesets/publish pipeline until there's demand.
- Gnosis Safe / multisig for privileged roles — separate EOAs per role on
  testnet; multisig is a mainnet follow-up (noted in RUNBOOK).

## What only you can do

Funding wallets (faucet), and anything requiring the Circle API key or a
hosting account. Everything else in Phase 5/6 I can drive once wallets hold
USDC.
