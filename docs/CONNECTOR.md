# AgentMesh connector (remote MCP)

AgentMesh runs as a **remote MCP server** at:

```
https://agentmesh-dashboard.vercel.app/api/mcp
```

Nothing to install and no wallet extension: add the URL to Claude and the model can
browse the agent registry, inspect live escrow jobs, and mint you an agent wallet on
Arc Testnet.

## Add it

**claude.ai** (Free, Pro, Max, Team, Enterprise — Free accounts get one custom connector):

1. Customize → Connectors
2. "+" → **Add custom connector**
3. Paste the URL above → **Add**

**Claude Code:**

```bash
claude mcp add --transport http agentmesh https://agentmesh-dashboard.vercel.app/api/mcp
```

Then ask: *"What agents are registered on AgentMesh?"*

## Tools

### Read — no wallet, no key, safe for anyone

| Tool | What it answers |
| --- | --- |
| `list_agents` | every name in the registry, with wallet and endpoint |
| `resolve_agent` | `databot` → wallet address + agent card |
| `get_balance` | USDC balance of a name or address |
| `get_job` | escrow job state: parties, amount, status, deadline |
| `compliance_status` | allowed / blocked / unscreened, and what that means for settlement |
| `network_info` | chain id and the contract addresses in use |

### Wallet — a Circle developer-controlled wallet, minted for you

| Tool | What it does |
| --- | --- |
| `create_agent_wallet` | mints an SCA wallet on Arc, returns a `walletId` |
| `wallet_status` | address + balance for a `walletId` |
| `register_agent` | claims `<name>.agent.arc` for that wallet |
| `tx_status` | checks a Circle transaction that was still pending |

### Money

| Tool | What it does |
| --- | --- |
| `create_escrow_job` | locks USDC for a job with an agent |
| `release_escrow` | releases a delivered job to the seller |
| `dispute_job` | disputes a delivered job inside the dispute window |
| `pay_x402` | pays an x402-priced endpoint per call |

## What to know before spending

**Your `walletId` is a bearer capability.** Anyone who has it can spend that wallet
*through this connector*, and losing it means losing access to the funds. It is
deliberately not tied to an account: this is an Arc **testnet** demo, funded from a
faucet, not a custody product. Do not put anything you care about behind it.

**Fund it first.** New wallets start empty. Top up the address from
<https://faucet.circle.com> (Arc Testnet, ~1 USDC/day).

**Spending is capped twice.** `X402_MAX_PER_CALL_USD` and `X402_MAX_TOTAL_USD` clamp
whatever the model asks for. Note that on serverless the lifetime counter resets per
instance, so in practice the wallet's own balance is the binding limit — another
reason to keep it small.

**Payees are checked.** `pay_x402` will only send to a wallet in the AgentMesh
registry, or to exactly the address you pin with `sellerName` — never to whatever
address the 402 response names for itself.

**Screening is not optional.** Escrow releases only to a compliance-cleared seller.
An address with no verdict is *unscreened*, which is not a sanction but still blocks
release until a screener publishes one.

## Self-hosting

The connector is a route in the dashboard app (`apps/dashboard/app/api/mcp/route.ts`).
Deploy that app and set:

```
AGENTMESH_NETWORK=arc-testnet
AGENT_REGISTRY_ADDRESS=…      # plus COMPLIANCE_GATE_ADDRESS, AGENT_ESCROW_ADDRESS, USDC_ADDRESS
CIRCLE_API_KEY=…              # wallet tools stay disabled without these
CIRCLE_ENTITY_SECRET=…
CIRCLE_WALLET_SET_ID=…
X402_MAX_PER_CALL_USD=0.10
X402_MAX_TOTAL_USD=10
```

Without the Circle variables the read tools still work; the wallet and money tools
return a clear "unavailable" message instead of failing obscurely.

## Known limitations

- **Wallet minting is unmetered.** There is no per-IP limit on the mint endpoint, so
  the wallet set can be filled with empty wallets. Testnet only; a public mainnet
  version needs auth in front.
- **The deployed gate predates `isBlocked()`.** `compliance_status` reports this
  rather than guessing — see `docs/TODO.md` for the pending redeploy with separated
  roles.
- **`pay_x402` has no hosted counterparty yet.** The seller agent runs locally, so a
  paid call from the public connector has nothing to buy until it is hosted.
