# singit-agent-pay

**Agents that pay each other, safely:** an MCP server that lets AI agents hold, capture, release and refund USDC under human-set mandates (budget, per-tx cap, allowed payees, deadlines), with disputes only a human can resolve and a full audit log.

> **Status:** the default demo runs on the **mock backend** (in-memory, synthetic data, no keys). The Solana devnet backend (`Capture402Backend`) is implemented and tested locally against the pinned public ABI. The live entrypoint requires a private durable journal and resolves original pending transactions before serving writes. [Devnet acceptance](docs/CAPTURE402-DEVNET.md) still requires a verified deployment, explicit provider/keys/funding and separate authorization. Devnet only, never mainnet.

## Quickstart

Requires Node 20, 22 or 24 (`nvm use` reads `.nvmrc` = 22), macOS or Linux.

```sh
npm ci            # also installs singit-mcp/ dependencies
npm run demo:all  # MCP server on :8787 + dashboard on :5173, Ctrl-C stops both
```

Then open http://127.0.0.1:5173 and press **▶ Run demo story**. The story is in [docs/DEMO.md](docs/DEMO.md).

For an operator with funded devnet wallets and private configuration, use
`npm run live:all -- /absolute/path/to/private/devnet.env`.
[Live demo setup](docs/LIVE-DEMO.md) explains the two wallet roles, startup recovery
and the separate browser/MCP acceptance. Live mode never falls back to mock.

| URL | What |
|---|---|
| http://127.0.0.1:8787/mcp | MCP, streamable HTTP |
| http://127.0.0.1:8787/health | health check |
| http://127.0.0.1:8787/api/state | read-only JSON state |
| http://127.0.0.1:5173 | demo dashboard |

On first run `demo:all` writes random local dev secrets to `singit-mcp/.env.local` (gitignored).

Other scripts: `npm run demo` (the same story in the terminal), `npm test` (singit-mcp unit + contract tests, then the dashboard e2e), `npm run typecheck`.

Dashboard e2e on its own: `(cd singit-mcp && npm ci)`, then `cd demo-dashboard && npm run test:e2e` (in-process, imports `../singit-mcp/src`). Without singit-mcp's deps: `SINGIT_BACKEND=local npm run test:e2e` (built-in local adapter).

## Connect an MCP client

**Streamable HTTP (recommended):** start the server with `npm run start:http` (or `npm run demo:all`), then point the client at `http://127.0.0.1:8787/mcp`. The human approval secret stays in the server process, out of the agent's config.

```sh
# Claude Code
claude mcp add --transport http singit http://127.0.0.1:8787/mcp
```

```jsonc
// Cursor: .cursor/mcp.json
{ "mcpServers": { "singit": { "url": "http://127.0.0.1:8787/mcp" } } }
```

**stdio:** the client spawns the server itself. Don't put the human approval secret in the agent's config; disputes then refuse to resolve, which is the safe default.

```sh
# Claude Code
claude mcp add singit -- npx tsx /ABS/PATH/singit-agent-pay/singit-mcp/src/index.ts
```

```jsonc
// Claude Desktop: claude_desktop_config.json (Cursor uses the same shape)
{
  "mcpServers": {
    "singit": {
      "command": "npx",
      "args": ["tsx", "/ABS/PATH/singit-agent-pay/singit-mcp/src/index.ts"]
    }
  }
}
```

### Tools (11)

Amounts are USDC base units as decimal strings (`2500000` = 2.5 USDC); times are Unix seconds. Every write takes an `actor`. **`hold` is the pay tool.**

| Tool | What it does |
|---|---|
| `create_mandate` | Payer, total budget, per-tx cap, expiry, allowed payees |
| `get_mandate` | A mandate with its remaining budget and holds |
| `list_mandates` | All mandates |
| `hold` | Lock funds for a payee (payment authorization) |
| `capture` | Capture some or all of a hold |
| `release` | Return the uncaptured remainder to the payer |
| `refund` | Payee refunds a captured amount |
| `open_dispute` | Payer disputes a hold; captures freeze |
| `list_disputes` | Disputes, filterable by status or mandate |
| `resolve_dispute` | Refund or reject; needs a human approval token |
| `list_audit_log` | Every action, including blocked ones |

Full schemas, refusal codes and the backend contract: [docs/INTERFACE.md](docs/INTERFACE.md). Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repository layout

| Path | What |
|---|---|
| `singit-mcp/` | The MCP server: mandate engine, `PaymentBackend` (mock + Capture402 devnet implementation), human approval, audit log, tests |
| `demo-dashboard/` | Zero-dependency web dashboard that plays the demo story against singit-mcp |
| `docs/` | Architecture, interface, demo story |

## Built during the hackathon

FinTechers Prague, Track 2 "Agents that pay each other", 19–20 Oct 2026. Everything in this repository was written during the hackathon (the first commit is tagged `hackathon-start`):

- **singit-mcp:** MCP server (stdio + streamable HTTP) with 11 tools
- **Mandate engine:** budget, per-tx cap, allowed counterparties, expiry, devnet-USDC mint pinning, deadline bounds
- **Escrow lifecycle:** hold / capture / release / refund over a pluggable `PaymentBackend`
- **Human approval:** disputes resolve only with an HMAC token over the exact decision, issued out of band; agents cannot self-approve
- **Audit log:** every action and every refusal, with stable codes
- **Demo dashboard:** live story, blocked events, human console
- **Backend contract tests:** one conformance suite for the mock and the devnet backend

## Pre-existing (reused, not judged)

- **SingIt:** [singitai.app](https://singitai.app), [github.com/bubon-ik/SingItAI](https://github.com/bubon-ik/SingItAI). The team's existing product and x402 API; not part of this repository.
- **capture402 escrow:** [capture402-solana](https://github.com/starPaw/capture402-solana), the Solana auth/capture escrow program the devnet backend targets. First published 19 Oct 2026 10:46 (CEST), before the 12:00 kickoff. Not part of this repository.

## Safety

Solana devnet and devnet USDC only. Keys are devnet throwaway keypairs loaded from file paths in env (`SINGIT_PAYER_KEYPAIR`, `SINGIT_MERCHANT_KEYPAIR`), never committed; agents never see keys. `txSig` values are mock refs (`mock-tx-N`) on mock and finalized devnet signatures on Capture402. UNKNOWN is a separate pending outcome, never payment proof.

## License

[Apache-2.0](LICENSE), same as capture402.
