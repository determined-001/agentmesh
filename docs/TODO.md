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

- [ ] **Obtain Circle API key** (Developer Console) — the one gate on the whole
      Circle path. Create the developer-controlled wallets there.
- [ ] **Fund the agent wallets** from <https://faucet.circle.com> (Arc Testnet),
      ~1 USDC/day per address. USDC is also the gas token on Arc, so one asset
      funds everything. Roles: buyer, seller, watcher (+ deployer for the
      one-shot deploy).
- [ ] **Deploy contracts** — one command in [DEPLOYMENT.md](DEPLOYMENT.md) §2.
      Writes `deployments/arc-testnet.json` (commit it) and hands every
      privileged role to the watcher address.
      USDC = `0x3600000000000000000000000000000000000000` (6dp),
      `DISPUTE_WINDOW=3600`, `VERDICT_TTL=86400`.
- [ ] **Try contract verification** on ArcScan (Blockscout-flavored;
      `forge verify-contract --verifier blockscout --verifier-url https://testnet.arcscan.app/api`).
      If unsupported, note it in the artifact commit and move on.
- [ ] **Run services** against testnet (docker compose, or `pnpm dev:seller` /
      `pnpm dev:watcher` with `AGENTMESH_NETWORK=arc-testnet`). Confirm
      `:4021/readyz` and `:4031/readyz` return 200.
- [ ] **Full testnet e2e** — `pnpm demo:testnet`. Exercise: register, x402
      micropayment, escrow → delivered → auto-release, dispute → arbiter,
      blocked-seller → `refundBlocked`. Record tx hashes in
      `docs/testnet-verification.md` (create it).
- [ ] **48h unattended soak** — services pointed at testnet, watch pino logs,
      induce ≥1 restart of each and confirm recovery.
- [ ] **Circle Compliance Engine screening** — set `CIRCLE_COMPLIANCE_API_KEY`
      so the watcher screens sellers via Circle instead of the local denylist
      fallback. Same key family as the wallets.

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
