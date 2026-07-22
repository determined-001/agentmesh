# AgentMesh — Operations Runbook

## Key roles

| Key | Powers | Blast radius if leaked |
| --- | ------ | ---------------------- |
| Watcher | ComplianceGate SCREENER + gate admin + escrow owner (arbiter, pause, setGate) | Total: can allow anyone, resolve disputes, pause intake. Rotate FIRST. |
| Buyer | Own funds, dispute/release own jobs | Own balance only |
| Seller | Deliver jobs, receives payouts | Own balance only |
| Deployer | None post-deploy | Gas dust |

### Rotating the watcher key
1. New EOA, faucet-fund it.
2. From old key: `escrow.transferOwnership(new)` then from new key `escrow.acceptOwnership()` (Ownable2Step — both steps required).
3. Gate: `grantRole(SCREENER_ROLE, new)`, `grantRole(DEFAULT_ADMIN_ROLE, new)`, then from new key revoke both roles from old.
4. Update `WATCHER_PRIVATE_KEY`, restart watcher, confirm `readyz` + a screening log line.

## Pause procedure (incident: suspicious job flow)
- Pause: `cast send $ESCROW "pause()" --private-key $WATCHER_PRIVATE_KEY --rpc-url $RPC`
- Effect: blocks NEW jobs only. Release, dispute, refund, refundBlocked all stay live — a pause can never trap funds.
- Unpause: `cast send $ESCROW "unpause()" ...`

## Gate swap (incident: gate bug / compromised screener)
1. Deploy replacement ComplianceGate (constructor arg = admin).
2. `cast send $ESCROW "setGate(address)" $NEW_GATE --private-key $WATCHER_PRIVATE_KEY`
3. Re-screen active sellers on the new gate (watcher does this automatically for tracked jobs — wipe its `screened` table or bump `VERDICT_TTL`).
4. `GateChanged` event is emitted — auditable on the explorer.

## Dispute arbitration
1. Buyer disputed within the window → job status `Disputed`.
2. Inspect deliverable: seller `/jobs/<id>/deliverable`, spec hash on-chain.
3. Rule: `cast send $ESCROW "resolveDispute(uint256,bool)" <jobId> <true=pay seller|false=refund buyer>` from the watcher (arbiter) key.
4. Blocked seller: `resolveDispute(id, true)` reverts `ComplianceBlocked` by design (refund-only policy). Use `resolveDispute(id, false)`, or anyone may call `refundBlocked(id)`.

## Service recovery
- Both services keep SQLite state (`data/*.sqlite`) scoped to escrow+genesis; restart-safe. Kill -9 verified: watcher restart auto-releases pending jobs; seller restart keeps payments/replay sets.
- Watcher down: no screenings, auto-releases, or refunds happen. Funds are safe (escrow just waits). Restart; it resumes from its block cursor and tracked-jobs table.
- Seller down: 402 endpoints and deliverable fetches 404/refuse; escrow jobs keep accumulating and will be worked on restart (deadline permitting).
- Compliance API outage: watcher FAILS CLOSED — sellers stay unscreened (default-deny), releases revert until screening succeeds. This is intended; do not "fix" it by falling back to allow.

## Health / monitoring
- Seller: `:4021/healthz` (live) `:4021/readyz` (RPC + poller freshness).
- Watcher: `:4031/healthz`, `:4031/readyz`.
- Point a free pinger (healthchecks.io / UptimeRobot) at both `readyz` URLs; alert on 503/timeouts.
- Logs are pino JSON on stdout — `docker compose logs -f watcher | npx pino-pretty` for humans.

## Watcher-down triage
1. `curl :4031/readyz` — RPC unreachable vs tick stalled.
2. `docker compose logs --tail 100 watcher` — look for `"level":50`.
3. Common causes: RPC outage (retries automatically), out of gas USDC (fund the watcher address), role revoked (check `hasRole` on the gate).
