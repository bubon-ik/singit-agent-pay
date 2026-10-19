# Demo story

Mock backend, synthetic data, no keys. Buyer `agent:research-bot` pays two sellers under one mandate; the human is `human:kostiantyn`.
Two ways to play it:

- **Terminal:** `npm run demo` (root) prints every step and the audit log.
- **Dashboard:** `npm run demo:all` (root), open http://127.0.0.1:5173 and press *▶ Run demo story*. The dashboard stops at the dispute and waits for the human.

Amounts are USDC (6 decimals on-chain: `2500000` = 2.5 USDC).

| # | Actor | Action | Result |
|---|---|---|---|
| 1 | human | `create_mandate`: payer `agent:research-bot`, budget **10 USDC**, per-tx cap **4 USDC**, expiry 2 h, allowed payees `agent:data-vendor`, `agent:gpu-broker` | mandate created, remaining 10 |
| 2 | research-bot | `hold` 3 USDC for data-vendor | held 3, remaining 7 |
| 3 | data-vendor | `capture` 2.5 USDC | captured 2.5, still held 0.5 |
| 4 | data-vendor | `release` the 0.5 remainder | back to the payer, remaining 7.5 |
| 5 | research-bot | `hold` 4 USDC for gpu-broker | held 4, remaining 3.5 |
| 6 | gpu-broker | `capture` 4 USDC | captured 4 |
| 7 | research-bot | `hold` 5 USDC for data-vendor | **BLOCKED `OVER_PER_TX_CAP`** (cap is 4) |
| 8 | research-bot | `hold` 1 USDC for `agent:unknown-seller` | **BLOCKED `COUNTERPARTY_NOT_ALLOWED`** |
| 9 | research-bot | `hold` 4 USDC more for data-vendor | **BLOCKED `OVER_BUDGET`** (remaining 3.5) |
| 10 | data-vendor | `refund` 0.5 USDC (goodwill) | refunded; refunds never re-open the budget |
| 11 | research-bot | `open_dispute` on the 4 USDC gpu-broker hold ("GPU job returned empty results") | dispute open, captures on that hold frozen |
| 12 | research-bot | `resolve_dispute` on its own dispute (no token / forged token) | **BLOCKED `HUMAN_APPROVAL_REQUIRED`**: an agent cannot approve itself |
| 13 | human | approves a **4 USDC refund** (dashboard console or `npm run approve -- <disputeId> refund 4000000`) | dispute resolved, 4 USDC back to research-bot |

Every step, including every blocked one, is a row in `list_audit_log` (actor, action, outcome, code, amount, txSig).
`txSig` values are mock refs (`mock-tx-N`) until the Solana devnet backend is wired.

## Reset between runs

The dashboard has a *Reset* button. Against the MCP HTTP server directly (mock backend only; any other backend answers `409 RESET_MOCK_ONLY`):

```sh
set -a; . singit-mcp/.env.local; set +a   # written by npm run demo:all on first run
curl -s -X POST http://127.0.0.1:8787/human/reset \
  -H "x-singit-human-secret: $SINGIT_HUMAN_ROUTE_SECRET" \
  -H 'content-type: application/json' -d '{"actor":"human"}'
```

This restores the default mock balances (`agent:research-bot` 100 USDC, sellers 20 USDC each) and clears all mandates, holds, disputes and the audit log.
