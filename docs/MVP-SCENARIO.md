# Single-merchant real-agent MVP acceptance contract

## Scope and source ownership

One real LLM buyer obtains an expense-quality report from one merchant, using the
actual MCP transports and Capture402 on Solana devnet. One designated host runs
one payment runtime with one payer/merchant wallet pair. Circle devnet USDC only.
Mainnet, customer funds, cross-host custody and HA are outside this MVP.

`singit-agent-pay` owns principals, mandates, idempotency, journal, recovery and
economic admission. `starPaw/capture402-solana` owns the program, ABI, operator
tools and the original isolated merchant/buyer example. This repository also
provides the standalone [Bedrock buyer](../examples/bedrock-buyer/README.md),
adapted from Capture402 PR #10, with its merchant, adapters and local mock tests.
It uses this checkout's payment service and does not require a Capture402 source
checkout. Its validation is separate from the accepted Codex source pair.
The existing SingItAI product is an external reference, not a dependency of this
workflow. Its current x402/CDP
payment path is not evidence that it uses the Capture402 MCP integration.

Reuse trusted principals and MCP idempotency already merged through PRs #17–19.
Capture402 merchant PR #7 contains mock preparation; its later authenticated
revision already uses role tokens, the human mandate route and stable keys.
Integration, review, merge, installation and live acceptance remain separate.

## One normal purchase

1. A human issues one mandate through the human control path: total budget
   1,000,000 base units, per-transaction cap 1,000,000, exactly the selected
   merchant and explicit Unix-second expiry. The buyer cannot issue or expand it.
2. A trusted buyer wrapper durably binds one user intent to the input and mandate.
   The real LLM calls quote, authorize/hold, purchase and read-result steps over
   MCP. A scripted buyer or dashboard remains an offline reference, not an LLM trace.
3. The merchant quotes maximum 1,000,000 and fixed report price 650,000 base units.
   Intent, input digest, artifact digest, payer, merchant, mint and terms are bound.
4. The buyer authorizes one hold with its stable key. The merchant captures
   650,000 with `releaseRemainder: true`, returning 350,000 in that same instruction.
   The normal purchase has one authorize transaction and one capture transaction;
   it has no additional release or refund transaction.
5. Artifact bytes are durably prepared before capture. Delivery follows proven
   original success and durable local completion. Completed requests return those
   same bytes; an incomplete or UNKNOWN purchase blocks new purchase attempts.

For synthetic rehearsal, use deadlines measured from the scenario clock: capture
after ten minutes, refund after seventy minutes, and mandate expiry after fifteen
minutes. All deadlines are fixed before signing. A future live approval
must record the actual chosen values; this document grants no operational authority.

The existing merchant example remains mock-only until its explicit devnet profile,
final combined review and the gates below are accepted. This work does not enable it.

## Expected result and accounting

The public synthetic input has rows `(invoice-1, compute, 1200)`,
`(invoice-2, data, 800)`, `(invoice-2, data, 800)`.
Expected output: total `2800`, compute `1200`, data `1600`, duplicate ID
`invoice-2`, three rows and two unique IDs. Duplicate rows remain in totals.
Input amounts are caller-supplied integer units; they are not payment prices.

After the normal purchase: held `0`, gross captured `650000`, refunded `0`,
refundable `650000`, mandate committed `650000`, remaining `350000`, unresolved
reservations `0`. Payer USDC decreases by `650000`, merchant USDC increases by
`650000`, and the payment vault holds `0`. SOL fees and account rent are separate.
Both original transaction outcomes must be finalized with `err = null`.

Bind evidence across mandate, business intent, order, original operation IDs,
payment PDA, signatures and artifact digest. The price is fixed demo pricing,
not measured LLM usage. Model/provider credentials, wallet keys, human secrets
and merchant credentials must be inaccessible to buyer tools and model context.

## Failure acceptance

- Wrong principal, role, payee, mint, cap, terms or budget: refuse before a send.
- Lost responses: observe the original operation ID; no fresh salt, blockhash,
  key, payment, state directory or provider to bypass uncertainty.
- Concurrent/restarted calls: no duplicate economic effect, accounting delta,
  human decision or artifact. Reconciliation never signs or sends.
- Failed pre-send persistence: no send. Failed post-send persistence: close
  admission, retain evidence/reservations and withhold uncommitted delivery.
- Corrupt/incompatible journals: stop startup; offline diagnosis preserves bytes.
- Deployment/network/mint mismatch: stop admission until reviewed restart.
- Refund and payer reclaim have separate acceptance and budgets. Refund is
  merchant-funded and does not replenish the mandate. Deadline arrival alone
  returns nothing; reclaim is payer-signed and preserves captured funds.
- Multi-step live dispute refunds and automatic cleanup remain disabled.

## Ordered gates

| Gate | Required evidence | Authority |
| --- | --- | --- |
| `OFFLINE_READY` | Final combined sources/lockfiles/toolchain; typecheck/build, contract, transport, dashboard, storage/fault/redaction tests; useful real LLM trace against mock; exact-head review | Does not permit live operations |
| `ONE_RUN_AUTHORIZED` | Accepted existing source/deployment identity, approved RPC and wallet namespace, original journal continuity, balances/ATAs; recorded deadlines, USDC/SOL/attempt caps and stop/go/operator/reviewer roles; explicit owner authorization for preflight and one bounded scenario | Limited to the named run; UNKNOWN stops it |
| `MVP_ACCEPTED` | Actual LLM → merchant → MCP → devnet trace, original finalized outcomes, reconciled balances, correct durable artifact, no pending/UNKNOWN, operator/reviewer disposition | Experimental devnet MVP only |

Offline preparation may proceed before live authorization. Final MVP acceptance
is obtained after the authorized run, so it is not a prerequisite for permitting
that test. No gate is granted by writing this contract or by historical smoke.
Merge, publication, deployment, restart, funding and hosted Actions each retain
their own required authorization. No new faucet or redeployment is a prerequisite.

## Remaining ownership

- #9/#10: retain role and idempotency regressions; do not recreate implemented work.
- #11: atomic terminal/audit/accounting and human-decision recovery; compatible
  journal upgrades and refusal of ambiguous legacy states.
- #12: one-host custody, admission/readiness and offline blocked-state inspection.
- #13 and Capture402 #6: separately accepted refund/reclaim and environment.
- #14: useful real-agent mock rehearsal, then the separately authorized devnet E2E.
- #15: final combined candidate and operator/reviewer evidence.

Real traces, original wires, receipts, wallet identities and operational records
stay private. Public examples and normal test fixtures are synthetic. Published
results must distinguish MOCK, HISTORICAL, NOT RUN and accepted devnet evidence.
