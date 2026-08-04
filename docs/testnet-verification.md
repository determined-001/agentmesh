# AgentMesh — Arc Testnet Verification

Signer path: Circle Developer-Controlled Wallets (`WALLET_PROVIDER=circle`) for
buyer/seller/watcher; deployer is a throwaway EOA (forge scripts can't sign
via Circle's API). All amounts and gas paid in Arc Testnet USDC.

## Contracts

Deployed via `contracts/script/Deploy.s.sol`, `DISPUTE_WINDOW=3600`,
`VERDICT_TTL=86400`. All privileged roles (arbiter, gate admin, screener)
assigned to the watcher address; deployer retains no powers.

| Contract | Address | Explorer |
| --- | --- | --- |
| AgentRegistry | `0xaF9F344839699B098F7E469669d3F81e2B39879A` | [verified](https://testnet.arcscan.app/address/0xaf9f344839699b098f7e469669d3f81e2b39879a) |
| ComplianceGate | `0x1a0fCa0e1f79Fb9F7003b111948Ce3b2be837F53` | [verified](https://testnet.arcscan.app/address/0x1a0fca0e1f79fb9f7003b111948ce3b2be837f53) |
| AgentEscrow | `0xace347d8d4ac669E7B1a6247042F4c00A1c4cf7B` | [verified](https://testnet.arcscan.app/address/0xace347d8d4ac669e7b1a6247042f4c00a1c4cf7b) |

## Agent registration

| Agent | Address | Tx |
| --- | --- | --- |
| buyerbot.agent.arc | `0xd82f5b48434b91f5029fd3d3e30bac27810b3a25` | [0x6bc499b0...7ce18](https://testnet.arcscan.app/tx/0x6bc499b02affb688652aa433eff65d56a706835ece9f553d0cc737dbf347ce18) |
| databot.agent.arc | `0x73c0eFcba509CF96466FdB43Ff598CE1642C68B3` | [0x0f76e2a5...16978](https://testnet.arcscan.app/tx/0x0f76e2a5a5586753c8a047e30231f3eb266cdb9f555f6709c9f8edc8c9e16978) |

## x402 micropayments (agentmesh-direct scheme)

5 calls, buyerbot → databot, $0.001–$0.002 each, $0.007 total. Payer
signature verified via `publicClient.verifyMessage` (ERC-6492/1271-aware —
required for Circle SCA wallets; plain viem `verifyMessage` only recovers
ECDSA and rejects every smart-contract signer, see fix below).

| # | Amount | Tx |
| --- | --- | --- |
| 1 | $0.001 | [0xfcc0492c...91ea9](https://testnet.arcscan.app/tx/0xfcc0492c61f8f405a2155fc5569cd65f962293f94a5a28f5afdf3171de491ea9) |
| 2 | $0.002 | [0xdb13702f...b66ef1](https://testnet.arcscan.app/tx/0xdb13702fb1c285e041589473a59902dae5a6805c355d06f01856835b89b66ef1) |
| 3 | $0.001 | [0x465ef612...c63109](https://testnet.arcscan.app/tx/0x465ef6123ec4c5ddb4a656031bc9b8a3f4f1a844c586fb73a8c6ab9821c63109) |
| 4 | $0.002 | [0xa875d961...13fc704](https://testnet.arcscan.app/tx/0xa875d96178b82da8ffc79117f5338a28d069c078a9a5773bb3226c0dc13fc704) |
| 5 | $0.001 | [0xc996ecbf...698288](https://testnet.arcscan.app/tx/0xc996ecbf943845b16e5869bddd593e0df7be8575dbc54e54970b85debf698288) |

## Escrow job #1 — happy path (funded → delivered → auto-released)

$0.25 job, buyerbot → databot.

| Step | Tx |
| --- | --- |
| Funded | [0xef4e2cc3...b10f25](https://testnet.arcscan.app/tx/0xef4e2cc301bf372523d7b0fe746ca6c2a2884cfbd38fa9b7d312aa6b03b10f25) |
| Seller screened (watcher, local-allowlist fallback) | [0xfb8a7aad...5806f](https://testnet.arcscan.app/tx/0xfb8a7aad1c79edc21919b5cbfe42a3bd043d2a089c0ec892b64027d214a5806f) |
| Delivered | (event only, no separate tx recorded) |
| Auto-released (after 3600s dispute window) | [0x3928c423...da554d6](https://testnet.arcscan.app/tx/0x3928c42355cc6d796da7f0d3f3aeff732a651a8b8c0b0a3a7c1272b70da554d6) |

All 10 transactions above confirmed on-chain with `status: success`
(`cast receipt <tx> status`).

## Not yet exercised

- Dispute → arbiter resolution path.
- Blocked-seller → `refundBlocked()` path.
- Circle Compliance Engine screening (currently `local-allowlist-fallback`;
  needs `CIRCLE_COMPLIANCE_API_KEY`).
- 48h unattended soak.

## Bugs found and fixed during this run

1. **x402 signature verification rejected all Circle SCA wallets.**
   `apps/seller-agent/src/x402Middleware.ts` used viem's standalone
   `verifyMessage` (ECDSA-only, explicitly documented as not supporting
   contract accounts). Every Circle-signed payment claim failed with
   `invalid payment signature`. Fixed by injecting a `verifySignature`
   function, wired to `mesh.publicClient.verifyMessage` in production
   (ERC-6492/1271-aware) and to the plain crypto check in unit tests
   (EOA fixtures only, no RPC needed).
2. **Unbounded `eth_getLogs` range growth on RPC failure.** Both
   `apps/seller-agent/src/index.ts` and `apps/watcher/src/index.ts` only
   advanced their polling cursor after a successful log query; a run of
   RPC failures let the queried range grow every tick with no cap, risking
   a permanent desync if the range grew past whatever limit the RPC
   enforces. Fixed with a `MAX_BLOCK_RANGE` cap (default 500 blocks) so
   each tick makes bounded, self-healing progress.
3. **Public RPC rate limiting at the default 2s poll interval** — both
   services hitting `rpc.testnet.arc.network` every 2s (3 calls/tick each)
   triggered `request limit reached`. Mitigated by raising `POLL_MS` to
   10000 in this deployment's `.env`; the range cap above prevents this
   from ever causing permanent desync even if it recurs.
4. **`demo/src/testnet.ts` hardcoded an EOA wallet**, bypassing
   `WALLET_PROVIDER=circle` entirely (`new ViemEoaWallet(...)` built
   directly from `BUYER_PRIVATE_KEY`, ignoring the wallet abstraction used
   everywhere else). Switched to `meshFromEnv("BUYER_PRIVATE_KEY")`.
5. **`demo/src/testnet.ts`'s default `ESCROW_WAIT_MS` (30 min) was shorter
   than the deployed `DISPUTE_WINDOW` (3600s = 60 min)**, so the script was
   guaranteed to time out before the watcher was even allowed to
   auto-release. Raised the default to 70 minutes.
