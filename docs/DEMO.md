# Judge demo — 5 minutes, nothing to install

Two ways to see AgentMesh work. The first needs only a browser.

## A. Live, from your own Claude (2 min)

Add the connector — claude.ai → Customize → Connectors → **+** → Add custom connector:

```
https://agentmesh-dashboard.vercel.app/api/mcp
```

Then run these prompts in order. Each one is answered from Arc Testnet, live.

1. **"What agents are registered on AgentMesh?"**
   → the on-chain naming registry: `databot.agent.arc`, `buyerbot.agent.arc`, their
   wallets and endpoints. Names are ERC-721, so an agent identity is transferable.

2. **"Is databot compliance-screened? What does that mean for payment?"**
   → the `ComplianceGate` verdict, and the distinction the escrow depends on:
   *unscreened* is not *blocked*. An unscreened seller cannot be paid, but neither can
   a third party cancel their delivered job — that asymmetry is a fixed griefing bug,
   not a detail.

3. **"Show me escrow job 3 and explain its state."**
   → parties, amount, status, deadline, deliverable hash, straight from `AgentEscrow`.

4. **"Create an agent wallet for me."**
   → mints a Circle developer-controlled wallet on Arc. No private key is generated,
   shown, or stored anywhere the user can lose it — the point of the Circle path.

5. **"What network and contracts is this connector pointed at?"**
   → chain id 5042002 and the deployed addresses, so nothing above is taken on trust.

Then open <https://agentmesh-dashboard.vercel.app> — the same chain state, rendered.

## B. Full lifecycle on a local chain (3 min)

Everything the connector cannot show without a hosted seller: micropayments,
delivery, screening, auto-release, and the dispute branch — with balance assertions
that fail loudly if any of it is fake.

```bash
pnpm install
pnpm demo:local
```

Boots its own anvil, deploys the contracts, then runs: naming → 50 x402
micropayments → screened $5 escrow job → delivery → watcher auto-release after the
dispute window → dispute/refund branch. Every step asserts balances; a wrong number
aborts the run.

Watch it live in a second terminal:

```bash
pnpm dev:dashboard    # http://localhost:3000
```

## What to look at in the code

| Claim | Where |
| --- | --- |
| x402 payments are payer-bound and single-use | `apps/seller-agent/src/store.ts` — one IMMEDIATE transaction claims quote and payment together |
| A client never pays whoever the server names | `packages/sdk/src/x402Client.ts` — `PayeePolicy` is required, not defaulted |
| Compliance blocks payment, never traps funds | `contracts/src/AgentEscrow.sol` — `refundBlocked` + `refundUnresolved` |
| Money can't be stranded by a blacklist | `AgentEscrow._send` credits `owed[]` instead of reverting |
| The invariants hold under fuzzing | `contracts/test/EscrowInvariant.t.sol` — balance == open jobs + deferred |

`pnpm test` (56) and `pnpm test:contracts` (65, incl. fuzz + invariant) both run offline.

## Known gaps, stated plainly

- The Arc Testnet deployment still has one key holding arbiter + gate admin + screener;
  the redeploy with separated roles is written up in `docs/TODO.md` and blocked only on
  faucet-funded wallets.
- That deployment also predates `isBlocked()`, so `compliance_status` says so rather
  than guessing.
- `pay_x402` through the public connector has no hosted counterparty yet — the seller
  agent runs locally. Demo B covers that path end to end.
