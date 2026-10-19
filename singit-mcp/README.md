# singit-mcp

SingIt MCP is an MCP server for agent-to-agent USDC payments on Solana devnet, with programmable mandates that constrain budgets, counterparties, and payment timing. Built at the FinTechers hackathon in Prague, Track 2 "Agents that pay each other".

## Quick start

```sh
npm install
npm test
npm run demo
```

`npm run demo:all` starts the MCP HTTP server and the demo dashboard from `../demo-dashboard`.

## Run the demo on your laptop

**Prereqs:** macOS or Linux, Node 22 or 20 (`nvm use` reads `.nvmrc`), and `singit-mcp/` and `demo-dashboard/` side by side in one folder. No Solana wallet or keys needed: it runs on the mock backend.

```sh
cd singit-mcp && npm run demo:all
```

On the first run this installs dependencies (`npm ci`) and writes local dev secrets to a gitignored `.env.local` (`SINGIT_HUMAN_APPROVAL_SECRET`, `SINGIT_HUMAN_ROUTE_SECRET`). It then starts both processes and prints:

```
  MCP (streamable HTTP): http://127.0.0.1:8787/mcp
  State (JSON):          http://127.0.0.1:8787/api/state
  Dashboard:             http://127.0.0.1:5173
```

Open the dashboard and run the story. `Ctrl-C` stops both processes.

**Troubleshooting**
- `Node vX is not supported`: run `nvm install 22 && nvm use 22`.
- `port 8787 is in use` (or 5173): stop the other process (`lsof -i :8787`), or run `MCP_PORT=8788 DASH_PORT=5174 npm run demo:all`.
- `npm ci failed`: check your network, then `rm -rf node_modules && npm run demo:all`.
- Approvals failing after you copied the folder: delete `.env.local` to regenerate the secrets.
- `/api/state` is read-only (600 requests/min bucket). Human approve/reject goes through `POST /human/resolve` with the `x-singit-human-secret` header (see INTERFACE.md).

## Run

- **stdio:** `npx tsx src/index.ts`
- **HTTP:** `npm run start:http` → `http://127.0.0.1:8787/mcp`
- Health check: `http://127.0.0.1:8787/health`

HTTP binds to `127.0.0.1`; set `PORT` to change the default port `8787`. The HTTP transport can also be selected with `SINGIT_MCP_HTTP=1`. `SINGIT_RATE_LIMIT_PER_MIN` sets the per-client request limit (default `120`).

### Connect to Claude Code

HTTP (recommended: the approval secret stays in the server process, out of the agent's config):

```sh
SINGIT_HUMAN_APPROVAL_SECRET=$(openssl rand -hex 32) npm run start:http   # human keeps this secret
claude mcp add --transport http singit http://127.0.0.1:8787/mcp
```

stdio (simplest; Claude Code spawns the server, so don't pass the secret here: disputes then refuse until you run it over HTTP):

```sh
claude mcp add singit -- npx tsx /ABS/PATH/singit-mcp/src/index.ts
```

## Tools

Amounts are USDC base units as decimal strings (`2500000` = 2.5 USDC); times are Unix seconds. Every write takes an `actor` identifying the calling agent. **`hold` is the pay tool.**

| Tool | What it does |
| --- | --- |
| `create_mandate` | Set a payer, total budget, per-transaction cap, expiry, and allowed payees. |
| `get_mandate` | Read a mandate, its remaining budget, and its holds. |
| `list_mandates` | List mandates with remaining budgets and holds. |
| `hold` | Lock up to the requested amount for a payee; this is payment authorization. |
| `capture` | Capture some or all of a hold. |
| `release` | Return the uncaptured held amount to the payer. |
| `refund` | Refund a captured amount from the payee to the payer. |
| `open_dispute` | Open a dispute as the payer and freeze further captures. |
| `list_disputes` | List disputes, optionally filtered by status or mandate. |
| `resolve_dispute` | Resolve a dispute as refund or reject with human approval. |
| `list_audit_log` | Read audit entries, optionally filtered by mandate or limit. |

## Mandate rules

The server checks each mandate before calling a backend: mandate and payer validity, expiry, allowed counterparties, per-transaction cap, total budget, devnet USDC mint, and deadline bounds. Captures require the payee, stay within the held amount and capture deadline, and are blocked by an open dispute. Refunds require the payee and must fit the captured, unrefunded amount before the refund deadline. See [INTERFACE.md](INTERFACE.md) for the rules, refusal codes, and backend contract.

## Human approval for disputes

Only a human can authorize dispute resolution. The `resolve_dispute` tool requires an HMAC token for the specific dispute, outcome, and refund amount, issued out of band with the human-only `SINGIT_HUMAN_APPROVAL_SECRET`. The agent cannot self-approve because no MCP tool can create or retrieve that secret or token. Keep the secret in the server environment; do not pass it to an agent.

```sh
SINGIT_HUMAN_APPROVAL_SECRET=your-secret npm run approve -- <disputeId> <refund|reject> [amount]
```

Use a secret at least 16 characters long. `amount` is in USDC base units and is used for a refund decision.

## Backends

`MockBackend` is the default in-memory backend for demos and tests. Set `SINGIT_BACKEND=capture402` to select `Capture402Backend`; it is currently a stub for the teammate integration. See [INTERFACE.md](INTERFACE.md) for the `PaymentBackend` contract and expected capture402 behavior.

For mock payer balances, set `SINGIT_MOCK_BALANCES` to a JSON object of addresses and base-unit amounts, for example `'{"buyer-agent":"100000000"}'`.

## Safety

This project targets Solana devnet and devnet USDC only. Keys: devnet throwaway keypairs generated locally by the team, loaded from env (`SINGIT_PAYER_KEYPAIR` / `SINGIT_MERCHANT_KEYPAIR`), never committed; agents never see keys. Never real or mainnet keys. `txSig` is a mock ref (`mock-tx-N`) until `Capture402Backend` is wired to devnet; only then it is a devnet signature that links to the Solana explorer (`https://explorer.solana.com/tx/<sig>?cluster=devnet`). The MCP server never needs the human approval secret on the agent side.

## Built during the hackathon

Everything in this repository was built during the hackathon; the scaffold is tagged `hackathon-start`. SingIt (the product and x402 API) and [capture402-solana](https://github.com/starPaw/capture402-solana) (the escrow program) pre-existed and are not part of this repository.

## License

Apache-2.0
