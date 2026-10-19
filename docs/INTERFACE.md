<!-- Reference copy. Canonical backend interface: ../singit-mcp/INTERFACE.md. -->
# PaymentBackend contract (for the capture402 integration)

Implement `PaymentBackend` from [`src/backend/types.ts`](../singit-mcp/src/backend/types.ts). The MCP server checks every
mandate rule (budget, per-tx cap, expiry, allowed counterparties, open disputes, human approval) **before**
it calls the backend. The backend only moves escrowed testnet USDC. `MockBackend` (in-memory) is the reference
behaviour. `Capture402Backend` implements the pinned public ABI; live acceptance is separate (see [devnet guide](CAPTURE402-DEVNET.md)).

- **Network:** Solana **devnet only**. Mint: devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (`DEVNET_USDC_MINT`). Base / EVM is out of scope.
- **Units:** USDC base units, 6 decimals, `bigint` (1 USDC = `1000000n`). Strings at the MCP boundary only.
- **Times:** unix seconds, checked against the chain `Clock`.
- **holdId:** the capture402 **payment PDA** = `PDA(["auth-capture-v1", payer, salt], programId)`; vault = ATA(payment PDA, mint).
- **expectedHeld / expectedRefundable:** passed straight into capture/void/refund data. The program rejects the tx if on-chain state differs.
- **Off-chain only (no instruction):** mandates, per-tx caps, counterparty lists, disputes, human approval, audit log.
- **Receipts:** `hold` returns `{holdId, txSig}`, the other writes return `{txSig}`. `txSig` is a mock ref (`mock-tx-N`) for MockBackend and a finalized devnet signature for Capture402Backend that links to the Solana explorer (`https://explorer.solana.com/tx/<sig>?cluster=devnet`). It is written to the audit log.

| Method | capture402 instruction (tag) | Data after tag | Accounts (s = signer, w = writable) | Signs |
|---|---|---|---|---|
| `createMandate(terms)` | none (off-chain) | – | – | – |
| `hold({payer, payee, mint, maximum, captureDeadline, refundDeadline, salt})` | `authorize` (0) | `version=1, escrow=0, fee=0:u64, salt:32, maximum:u64, captureDeadline:i64, refundDeadline:i64` (67 B) | payer(s,w), server=payee, payment PDA(w), mint, payer ATA(w), vault(w), rent funder(s,w), System, Token, ATA program | payer (+ funder) |
| `capture({holdId, amount, releaseRemainder, expectedHeld, expectedRefundable})` | `capture` (2) | `amount:u64, releaseRemainder:u8, expectedHeld:u64, expectedRefundable:u64` (26 B) | server(s), payment(w), mint, vault(w), server ATA(w), payer ATA(w), Token | merchant |
| `release({holdId, expectedHeld, expectedRefundable})` | `void` (3) | `expectedHeld:u64, expectedRefundable:u64` (17 B) | server(s), payment(w), mint, vault(w), payer ATA(w), Token | merchant |
| `refund({holdId, amount, expectedHeld, expectedRefundable})` | `refund` (4) | `amount:u64, expectedHeld:u64, expectedRefundable:u64` (25 B) | server(s), payment(w), mint, server ATA(w), payer ATA(w), Token | merchant |
| `getStatus(holdId)` | read `Payment` account | 176 B, `SACPAY01`: payer, server, mint, salt, maximum, capture_deadline, refund_deadline, held, refundable | – | – |

Not exposed as a tool: `reclaim` (1). The payer can take back an unused hold at or after `captureDeadline`, with no merchant consent needed. This is the payer's safety net if the seller goes silent.

## Capture402Backend implementation

The backend reuses the public ABI at commit
`236b09a44240d285ee6f33d2e8dac79f81058e3d`. All amounts/guards are `bigint`;
H/F guards are preserved exactly. Authorize uses the configured payer as signer,
funder and fee payer; capture/void/refund use the configured merchant.

Configure an explicit approved HTTPS Helius/QuickNode endpoint, independently
reviewed program ID, ProgramData address/slot/executable digest and separate
throwaway keypair files outside Git. No default/public RPC fallback exists.
Actual devnet genesis, executable identity, Circle USDC and canonical accounts
are checked; no source fixture program ID is accepted as deployment evidence.

Receipts require `finalized` and `err === null`. `BackendError.phase` separates
pre-send validation from finalized failure. `BackendOutcomeUnknown` separately
retains original holdId/salt/signature/wire/lifetime for possible sends and blocks
further writes on that backend instance. It is not a confirmed payment failure.
`getStatus` returns null only for an absent finalized account; malformed accounts
and unavailable RPC throw. `held === 0` alone is not payment proof.

See [devnet setup and acceptance](CAPTURE402-DEVNET.md) and
[environment template](../singit-mcp/.env.example) for exact configuration, commands, private
before-send evidence, funding estimates, skipped live tests, upgrade limitations
and the **remaining live PaymentService persistence/startup acceptance gates**.
Direct backend smoke is separate from a full MCP E2E. Live signing/sending,
funding and deployment require separate explicit authorization.

## For the Capture402Backend implementer

`src/backend/capture402.ts` is owned by the teammate (implementation above). Our side ships the contract and the harness, and the implementation must keep passing them:

- **Selection:** `buildBackendFromEnv` in [`src/backend/factory.ts`](../singit-mcp/src/backend/factory.ts) builds `Capture402Backend` when `SINGIT_BACKEND=capture402`, from explicit provider/deployment configuration (see the devnet guide and [`.env.example`](../singit-mcp/.env.example); no default RPC); the actual RPC genesis must be devnet. Change the constructor if you need to, and update the factory in the same commit.
- **Deployment configuration:** set `SINGIT_RPC_URL`, `SINGIT_PROGRAM_ID`, `SINGIT_PROGRAM_DATA`, `SINGIT_DEPLOYMENT_SLOT`, `SINGIT_EXECUTABLE_SHA256` and both keypair paths explicitly. Only HTTPS Helius/QuickNode is allowed; public devnet RPC is not an alternative. The executable digest covers all ProgramData bytes after offset 45, including padding, and needs independent source/deployment approval. `SINGIT_EVIDENCE_DIR` is also required by the live scripts.
- **Concurrency and phases:** writes on one backend instance are exclusive. A concurrent call gets validation-phase `BackendError("backend_busy")` and sends nothing; a new call while an original operation is unresolved gets validation-phase `reconciliation_required`, without someone else's receipt/evidence. Only the original possibly sent invocation raises `BackendOutcomeUnknown`. `BackendError.phase` distinguishes `validation` (no send by that call) and `confirmed_failure` (original signature finalized with non-null err).
- **Per-call evidence hook:** all four economic writes accept an optional second argument: `backend.hold(req, { onPrepared: async prepared => journal.persistAndSync(prepared) })` (also capture/release/refund). The awaited `SubmitContext` hook receives `PreparedTx`: `txSig`, `holdId` (PDA), a safe numeric `lastValidBlockHeight`, and `evidence` containing the exact signature, salt for hold, original amount/guards, signed wire, blockhash, string lifetime, program/network and ABI commit. PaymentService journals this complete object before send. A thrown/rejected hook prevents send with validation-phase `evidence_unavailable`. PaymentService forwards `prepared.evidence` during reconciliation. There is no implicit durable MCP journal merely from constructing a backend; a live caller must restore pending records before admitting writes.
- **Reconciliation:** main uses `getTxOutcome(query: TxOutcomeQuery): Promise<TxOutcome>`, with optional original `evidence`. Original finalized success maps to `executed`, original finalized error to `failed`, and missing history or missing original wire to `pending`. It never exposes chain `not_found` as terminal to PaymentService. The richer `await backend.getTxOutcome(originalEvidence)` overload verifies the signed operation and queries only its original signature with transaction-history search, finalized block height and a checked Payment snapshot at a bounded minimum context slot. It returns `{status: "landed" | "failed" | "pending" | "not_found", terminal, expired, blockHeight, signature, payment, slot?, transactionError?}`. Only original-signature finalized evidence (`landed`/`failed`, `terminal: true`) clears the latch. `pending` and `not_found` stay nonterminal, including after expiry or when payment state resembles the expected effect. No resend, new blockhash/salt, provider switch or economic compensation occurs. Durable callers must restore unresolved evidence with this method before admitting any new writes after restart, persist the returned terminal observation and retain reservations on read/persistence errors. Generic `PaymentBackend` exposes the query API as optional for non-chain backends.
- **Keys:** only from the file paths in `SINGIT_PAYER_KEYPAIR` (signs `authorize`) and `SINGIT_MERCHANT_KEYPAIR` (signs capture/void/refund, incl. human-approved refunds). Never generate, store, log or print keys. Missing/unreadable key -> `BackendError` with a clear code.
- **Contract requirements** (all checked by the conformance suite):
  1. Shapes as in `types.ts`: `hold` -> `{holdId: payment PDA, txSig}`, writes -> `{txSig}` (devnet signatures), `createMandate` -> `{}` (no-op, mandates stay off-chain).
  2. `capture` partial with `releaseRemainder:false` leaves `held = maximum - amount`; `releaseRemainder:true` sets `held = 0`. `release` = `void`. `refund` is paid from the merchant ATA, `amount <= refundable`.
  3. `getStatus` decodes the `Payment` account and returns every `EscrowStatus` field (bigints for amounts, unix-second numbers for deadlines), `null` if the account does not exist.
  4. **Mint re-check (QA M-2):** `getStatus` must report the **actual on-chain** mint. `PaymentService.hold` re-reads it after `authorize` and refuses `WRONG_MINT` (budget restored, remainder voided, hold never active) unless it equals `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. Refusing a non-USDC mint before sending is also fine.
  5. **Refund deadline exposed:** `getStatus().refundDeadline` must be the on-chain `refund_deadline`; `open_dispute` refuses `REFUND_WINDOW_CLOSED` once `now >= refundDeadline`.
  6. Errors are `BackendError` with `code` = capture402 facilitator reason, with or without the `invalid_auth_capture_svm_` prefix: `amount`, `unexpected_payment_state` (stale `expectedHeld/expectedRefundable`), `capture_deadline_expired`, `refund_deadline_expired` (the suite checks these four), plus `payment_not_found`, `empty_hold`, `insufficient_funds` as in MockBackend.
- **Conformance suite:** [`test/backend-contract.ts`](../singit-mcp/test/backend-contract.ts) `runBackendContract(label, makeFixture)`. `MockBackend` passes it in CI (`test/backend-contract.mock.test.ts`). The devnet run (`test/backend-contract.capture402.test.ts`) is skipped unless all of these are set:
  `SINGIT_CONTRACT_DEVNET=1 SINGIT_PAYER_KEYPAIR=<path> SINGIT_MERCHANT_KEYPAIR=<path> SINGIT_PAYER_ADDRESS=<pubkey> SINGIT_MERCHANT_ADDRESS=<pubkey> SINGIT_PROGRAM_ID=<id> npx vitest run test/backend-contract.capture402.test.ts`
  (`SINGIT_CONTRACT_UNIT`, default `100000` = 0.1 USDC per test unit; about 7 holds, so ~0.7 USDC moved and ~0.03 SOL of rent locked). Deadline-expiry and wrong-mint cases are skipped on devnet; the controlled offline Capture402 fixture also covers them. The explicit provider/deployment/evidence variables above are required in addition to the variables shown in the command.
- **Smoke:** `npm run devnet:smoke` ([`scripts/devnet-smoke.ts`](../singit-mcp/scripts/devnet-smoke.ts)). With no env it prints a preflight checklist and exits 1 without sending anything. With the env above (+ `SINGIT_BACKEND=capture402`) it checks the devnet genesis hash and SOL/USDC balances, then hold 1 USDC -> capture 0.6 -> release 0.4 -> refund 0.2 -> getStatus, verifying balances and printing explorer links (`?cluster=devnet`).
- **Program id: confirmed by partner for the hackathon devnet deployment: `992QmwmwCebawRJsTCgvc8qnzGivbFaD39ZQE7VhHp7o`** (ProgramData, slot and SHA256 in `docs/CAPTURE402-DEVNET.md`). History below: no devnet program id is committed in capture402-solana @ `236b09a44240d285ee6f33d2e8dac79f81058e3d`. The accepted Devnet deployment id is loaded at runtime from a deployment record (`/etc/capture402/deployment-identity.v1.json` via `SAC006_DEPLOYMENT_RECORD_PATH`: `integration/operators/lib.ts:52`, parsed at `integration/src/deployment-record.ts:121`), which is not in the repo. The only ids in the repo are test fixtures, **not** deployments: `3uWi9x2SRpmjztkpkr2WWeBoVq3exjXG2YfDWLvm8KsQ` (`integration/test/rpc-ledger.test.ts:42`, `integration/test/client.test.ts:12`, `integration/test/fixtures/operational-fixture.ts:20`), `992QmwmwCebawRJsTCgvc8qnzGivbFaD39ZQE7VhHp7o` (`ops/test_reconcile_wire.py:17`, later confirmed by the partner as the deployment; the repo reference alone proves nothing), and the harness id `[42;32]` (`src/lib.rs:18`, `LOCAL_PROGRAM_ID` in `integration/src/program.ts`).
- **Faucet mint:** the capture402 devnet faucet mints its own test token; our service only accepts devnet USDC `4zMMC9…`. Fund the payer with devnet USDC (e.g. Circle faucet), or agree on a change.

## Mandate rules (enforced by `PaymentService` before any backend call)

The program has no aggregate budget, no per-tx cap, no mint pin, no deadline bounds and no arbiter. These rules come from QA review `qa/capture402-review.md`. Each refused call returns its code and writes an audit row with `outcome: "blocked"`.

| # | Rule | Code | QA |
|---|---|---|---|
| 1 | Mandate exists. Caller is the mandate's payer. | `MANDATE_NOT_FOUND`, `NOT_PAYER` | – |
| 2 | `now < mandate.expiresAt` | `MANDATE_EXPIRED` | M-1 |
| 3 | Payee is in `allowedCounterparties` | `COUNTERPARTY_NOT_ALLOWED` | M-1 |
| 4 | `0 < amount <= perTxCap` | `INVALID_INPUT`, `OVER_PER_TX_CAP` | M-1 |
| 5 | `committed + amount <= totalBudget`, where committed = Σ(held + captured) over the mandate's holds. A release lowers it; a refund does **not**, because a refund never restores the authorization on-chain either. | `OVER_BUDGET` | M-1 |
| 6 | The mint is devnet USDC, both on the request and on the hold read back via `getStatus`. | `WRONG_MINT` | M-2 |
| 7 | Deadlines are unix **seconds** (values ≥ 1e11 are treated as milliseconds and rejected). `now < captureDeadline <= min(mandate.expiresAt, now + 7 days)`. `refundDeadline - captureDeadline >= 1 h` (default 24 h) and `<= 30 days`. | `INVALID_DEADLINE` | M-3 |
| 8 | Capture: caller = payee, `amount <= held`, `now < captureDeadline`, no open dispute on the hold | `NOT_PAYEE`, `CAPTURE_EXCEEDS_HOLD`, `CAPTURE_DEADLINE_PASSED`, `DISPUTE_OPEN` | – |
| 9 | Refund: caller = payee, `amount <= captured - refunded`, `now < refundDeadline` | `REFUND_EXCEEDS_CAPTURED`, `REFUND_DEADLINE_PASSED` | – |
| 10 | Dispute: only the hold's payer opens it, and only while `now < hold.refundDeadline` (same boundary as refund — a dispute after that could never be refunded); while it is open this service refuses captures (not an on-chain freeze). `resolve_dispute` needs a **human approval token**, an HMAC over `(disputeId, outcome, refundAmount)` keyed by `SINGIT_HUMAN_APPROVAL_SECRET` and issued with `npm run approve`. No MCP tool can produce it. "refund" releases what is still held (void) and then calls `refund`, signed by the merchant key the backend holds; live mode refuses that two-step form (`ACTION_DISABLED`). "reject" sends no tx. | `REFUND_WINDOW_CLOSED`, `HUMAN_APPROVAL_REQUIRED` | H-1 |

**Merchant signer (H-1):** the program has no arbiter, so a human-approved refund is executed with the **merchant/server key** held by the backend. Keys: devnet throwaway keypairs generated locally by the team, loaded from env (`SINGIT_PAYER_KEYPAIR` / `SINGIT_MERCHANT_KEYPAIR`), never committed; agents never see keys. The service never generates or stores keys.

## Audit log (stable, consumed by the dashboard)

Schema: `AuditEntry` in [`src/audit.ts`](../singit-mcp/src/audit.ts). Fields are only ever added, never renamed.

```ts
{ seq, ts /*ISO UTC*/, actor, action /*create_mandate|hold|capture|release|refund|open_dispute|resolve_dispute*/,
  outcome /*"ok"|"blocked"|"error"*/, code /*RefusalCode|null*/, reason,
  mandateId, holdId, disputeId, amount /*base units string*/, txSig, held, refundable /*escrow state after*/ }
```

`amount` is the base-unit amount of the action: `totalBudget` for `create_mandate`, the held/captured/released/refunded amount for the escrow actions, the refund for an approved `resolve_dispute`; `null` where there is no amount (e.g. `open_dispute`, a rejected dispute).

**On-chain rules (mirrored by MockBackend):**
- `authorize`: `maximum > 0`, `now < captureDeadline <= refundDeadline`, payer ≠ server. The full maximum moves into the vault (`held = maximum`, `refundable = 0`).
- `capture`: `now < captureDeadline`, `0 < amount <= held`. Then `held -= amount` (or `held = 0` with releaseRemainder, the rest goes to the payer) and `refundable += amount`.
- `void`: `held > 0`. Everything held goes back to the payer.
- `refund`: `now < refundDeadline`, `0 < amount <= refundable`. It is paid from the **merchant's ATA**, not the vault, and it never restores the authorization.
- Errors are plain `ProgramError`s (`InvalidArgument`, `InsufficientFunds`, …), with no custom codes. Map them to `BackendError(code, message)`, using the facilitator reason names in `integration/src/facilitator.ts` (`Reason`) where possible.

**TS helpers to reuse** (capture402 `integration/src`): `authorizeInstruction`, `captureInstruction`, `voidInstruction`, `refundInstruction` (transactions.ts), and `paymentAddress`, `ata`, `decodePayment` (program.ts).

Keys: devnet throwaway keypairs generated locally by the team, loaded from env (`SINGIT_PAYER_KEYPAIR` / `SINGIT_MERCHANT_KEYPAIR`), never committed; agents never see keys. Never real or mainnet keys.

## Journal v2 and blocked-state inspection

Terminal operations, accounting and an `operation_outcome` audit proof commit
atomically; associated human decisions are included. Audit v1 adds optional
`operationId`, `operationAction`, `operationState` and `recovered` fields on these
proofs. Business-call audit rows remain separate. A verified deployment/network/mint
mismatch closes admission until reviewed restart, including when found by a read.
Corrupt/unsupported or ambiguous legacy records stop startup without truncation.
The offline inspection CLI reports aggregate counts only and never opens admission.
See [JOURNAL.md](JOURNAL.md) for compatibility and diagnosis and
[MVP-SCENARIO.md](MVP-SCENARIO.md) for the agreed workflow and ordered gates.

## MCP tools (schemas: `toolSchemas` in [`src/server.ts`](../singit-mcp/src/server.ts), zod)

Amounts are base-unit decimal strings (`"2500000"` = 2.5 USDC). Times are integer unix seconds. Every write takes `actor`, the calling agent's id/address. The audit `action` is exactly the tool name. **`hold` is the pay tool**; there is no separate `pay`.

| Tool | Args | Returns (`ok: true`) |
|---|---|---|
| `create_mandate` | `actor, payer, totalBudget, perTxCap, expiresAt, allowedCounterparties[], note?` | `mandate, remaining` |
| `get_mandate` | `mandateId` | `mandate, remaining, holds[]` |
| `list_mandates` | – | `mandates: [{mandate, remaining, holds}]` |
| `hold` | `actor, mandateId, payee, amount, mint?, captureDeadline?, refundDeadline?, idempotencyKey?` | `hold, operationId, replay, txSig, remaining` |
| `capture` | `actor, holdId, amount, releaseRemainder?, idempotencyKey?` | `hold, operationId, replay, txSig` |
| `release` | `actor, holdId, idempotencyKey?` | `hold, operationId, replay, txSig` |
| `refund` | `actor, holdId, amount, idempotencyKey?` | `hold, operationId, replay, txSig` |
| `open_dispute` | `actor, holdId, reason, evidence[]` | `dispute` |
| `list_disputes` | `status? ("open"\|"resolved"), mandateId?` | `disputes[]` |
| `resolve_dispute` | `actor, disputeId, outcome ("refund"\|"reject"), refundAmount?, approvalToken, idempotencyKey?` | `dispute, txSig` (null for reject) |
| `get_operation` | `operationId` | `operation` (redacted public status; own mandates only) |
| `list_audit_log` | `mandateId?, limit?` | `entries: AuditEntry[]` |

- **Refusal:** `isError: true`, `{ok: false, code, reason, operationId?}`. The same object is in `structuredContent` and as JSON text in `content`.
- **Hold object:** `id, mandateId, payer, payee, mint, maximum, held, captured, refunded, captureDeadline, refundDeadline, txSigs[], lastTxSig, disputeId?`.
- **txSig / txRef:** `txSig` is a mock ref (`mock-tx-N`) for MockBackend and a finalized devnet signature for Capture402Backend that links to the Solana explorer (`https://explorer.solana.com/tx/<sig>?cluster=devnet`). It appears in the tool result, in `hold.txSigs`/`lastTxSig`, in `dispute.txSigs`, and in the audit `txSig`.
- **Approval token:** `issueApprovalToken(secret, {disputeId, outcome, refundAmount})` in `src/approval.ts`. It is HMAC-SHA256 over `singit-dispute-v1|disputeId|outcome|amount`, and the amount is forced to 0 for `reject`. CLI: `SINGIT_HUMAN_APPROVAL_SECRET=… npm run approve -- d-1 refund 2500000`.

## Trust boundary and principals (MVP-01, #9)

Local-only MVP: the server binds `127.0.0.1`; one buyer, one merchant, one human operator. This is not an untrusted public API.

- **Principal comes from the transport, never from tool input.** HTTP: `Authorization: Bearer <token>`, where `SINGIT_BUYER_TOKEN` maps to the buyer (`SINGIT_PAYER_ADDRESS`) and `SINGIT_MERCHANT_TOKEN` to the merchant (`SINGIT_MERCHANT_ADDRESS`). Tokens are at least 16 chars, all distinct from each other and from the human secrets, compared in constant time. stdio: the process boundary is the trust boundary and `SINGIT_MCP_PRINCIPAL=buyer|merchant` fixes the principal.
- **When tokens are set**, `/mcp` rejects missing or unknown tokens (401 `AUTH_REQUIRED`), a Host outside the loopback allowlist or `SINGIT_MCP_ALLOWED_HOSTS` (403), and any `Origin` outside `SINGIT_MCP_ALLOWED_ORIGINS` (403), all before business logic. `X-Forwarded-*` is never trusted and `/mcp` sends no CORS headers.
- **`actor` is informational.** With a principal it must equal the principal's id, or the call is refused with `PRINCIPAL_FORBIDDEN` before any backend call.
- **Role matrix:** buyer can `hold`, `open_dispute` and `release`; merchant can `capture`, `refund` and `release`. The `create_mandate` and `resolve_dispute` tools are refused for every agent principal. Reads (`get_mandate`, `list_mandates`, `list_disputes`, `list_audit_log`) and mutations are limited to mandates where the principal is payer or an allowed counterparty.
- **Mandate issuance is human-only:** `POST /human/mandate` (header `x-singit-human-secret` = `SINGIT_HUMAN_ROUTE_SECRET`) with `{payer,totalBudget,perTxCap,expiresAt,allowedCounterparties,note?}`. Dispute decisions stay on `/human/resolve` or `npm run approve`. No MCP tool returns a human secret or approval token.
- **Legacy modes (explicit):** with no agent tokens, `/mcp` is open only on the mock backend (local demo). A non-mock backend refuses unauthenticated MCP unless `SINGIT_MCP_TRUSTED_OPERATOR=1`. With both `SINGIT_BUYER_TOKEN` and `SINGIT_MERCHANT_TOKEN` set, `live-all.sh` leaves that mode off and the dashboard bridge acts as each agent under its own token (mandates go through `POST /human/mandate`). Without the tokens it falls back to trusted-operator mode, where the operator process is the trust boundary. Agent writes refused as `PRINCIPAL_FORBIDDEN` are audited with the real principal.

## Transports
- stdio (default): `npx tsx src/index.ts`
- streamable HTTP: `--http` or `SINGIT_MCP_HTTP=1`. Binds `127.0.0.1`, **port 8787** (override with `PORT`), path `/mcp`, `GET /health` (liveness), `GET /ready` (economic readiness, see "Live safety policy"). Stateless, with one shared in-memory state per process.
- Backend: `SINGIT_BACKEND=mock` (default) or `capture402` (built by `buildBackendFromEnv`; explicit provider/deployment configuration required, see devnet guide). `SINGIT_MOCK_BALANCES='{"buyer-agent":"100000000"}'`.
- HTTP handler lives in `src/http.ts` (`createHttpHandler`); `src/index.ts` just wires env/backend into it. Two rate-limit buckets, each its own `createRateLimiter` instance keyed by `cf-connecting-ip` header ?? socket address: `"mcp"` (`SINGIT_RATE_LIMIT_PER_MIN`, default 120) covers `/mcp` and `/human/resolve`; `"state"` (`SINGIT_STATE_RATE_LIMIT_PER_MIN`, default 600) covers `GET /api/state`. Over the limit: `429 {ok:false, error:"rate limited"}` with `Retry-After: 60`.
- `GET /api/state`: dashboard snapshot — `{v: 1, backend, mandates, disputes, audit, holds, ops}` (bigints as decimal strings; `holds` is every hold across all mandates). `ops` contains public operation status projections: identity/action, state, amounts, reservation, timestamps, errors and transaction metadata. Prepared metadata includes only `txSig`, `holdId` and `lastValidBlockHeight`; full evidence, signed wires, salt and idempotency keys remain in the private journal in every lifecycle state. The dashboard also redacts in-process and legacy upstream records. Public reads never mutate the original reconciliation evidence. `Access-Control-Allow-Origin: *` (read-only, GET only).
- `POST /human/resolve`: human console for `resolve_dispute`, same shape as the MCP tool (`{disputeId, outcome, refundAmount?, actor?, approvalToken?}`), no CORS. The request always needs header `x-singit-human-secret` equal to `SINGIT_HUMAN_ROUTE_SECRET` (only honored if ≥16 chars), checked first regardless of `approvalToken`. If `approvalToken` is in the body it's passed through as-is (the service HMAC-verifies it); otherwise the server mints the token itself. Missing/wrong header → 401 `HUMAN_AUTH_REQUIRED`; route secret not configured → 403 `HUMAN_ROUTE_DISABLED`; refusal from the service (e.g. a forged/invalid token) → 409 `{ok:false, code, reason}`; bad JSON/amount → 400 `INVALID_INPUT`. Body capped at 64 KB. Success: 200 `{ok:true, dispute, txSig}`.
- `POST /human/reset` (HTTP only, not an MCP tool): same `x-singit-human-secret` auth as `/human/resolve` (403 `HUMAN_ROUTE_DISABLED` / 401 `HUMAN_AUTH_REQUIRED`; `approvalToken` is not accepted), checked before the mode check. Only works on the mock backend — otherwise 409 `{ok:false, code:"RESET_MOCK_ONLY"}`. Replaces the shared `PaymentService` with a fresh one seeded from `DEFAULT_MOCK_BALANCES`/`SINGIT_MOCK_BALANCES`, records one `"reset"` audit entry, and responds 200 `{ok:true, reset:true, audit}`. Body optional `{actor?: string}`, default `"human"`.
- Default mock balances (`DEFAULT_MOCK_BALANCES` in `src/backend/mock.ts`, used whenever `SINGIT_MOCK_BALANCES` is unset): `buyer-agent` and `agent:research-bot` 100 USDC; `seller-agent`, `agent:data-vendor` and `agent:gpu-broker` 20 USDC (the dashboard story uses the `agent:` ids).

## Live safety policy (MVP-02 #10, MVP-04 #12, MVP-05 #13)

`createServiceRuntime` turns this on for `SINGIT_BACKEND=capture402` (`new PaymentService({ live: true })`); the mock demo keeps the defaults.

- **One intent = one `idempotencyKey`.** `hold`, `capture`, `release`, `refund` and `resolve_dispute` take an optional `idempotencyKey` (1-128 chars of `[A-Za-z0-9._:-]`); live mode refuses a missing one with `IDEMPOTENCY_KEY_REQUIRED` before any send. The client generates it once per intent and resends it unchanged on every retry. The key is scoped to the trusted principal and the action; the same key with different parameters is `IDEMPOTENCY_KEY_REUSED`.
- **Replay first.** After authorization, the key is looked up before any check that only applies to a new operation (held amount, refundable, deadlines). A retry after success returns the original outcome (`replay: true`, same `operationId`, the hold exactly as that operation left it), even after a full capture, a release or a passed deadline. A concurrent identical request gets `OPERATION_PENDING` with the in-flight `operationId`; it never sends twice.
- **`operationId` everywhere.** Successful economic results carry `operationId`; `OPERATION_UNKNOWN`, `OPERATION_PENDING`, `IDEMPOTENCY_KEY_REUSED` and journaled failures carry it in the refusal. `get_operation {operationId}` returns the redacted public status (no wire, salt, evidence or params hash) and only for the caller's own mandates. After a lost response, observe the original operation; the server never refreshes salt/blockhash or resubmits.
- **Fail-closed admission.** A verified deployment/network/mint identity mismatch, an UNKNOWN outcome (live), any failed durable journal write (`STORAGE_FAILURE`, all modes) or shutdown closes economic write admission: new `create_mandate`/`hold`/`capture`/`release`/`refund`/`resolve_dispute` operations are refused with `ADMISSION_CLOSED`, while reads, `get_operation` and keyed replays keep working. Only a restart reopens it, and live startup refuses while any original outcome is unresolved. The hold reservation and its pending op are journaled in one record; a journal failure before the send means nothing is sent.
- **Liveness vs readiness.** `GET /health` only says the process answers. `GET /ready` reports economic readiness `{ready, backend, admission: {open, code, reason, unresolvedOps}}` (200 when ready, 503 otherwise; counts and reason codes only). Live backends require the `x-singit-human-secret` header for it.
- **One writer per economic namespace.** Besides the state-directory lock, a live runtime takes an exclusive lock for its program + payer + merchant in `SINGIT_NAMESPACE_LOCK_DIR` (default `~/.singit-mcp/locks`), so a second runtime with the same wallets refuses (`NAMESPACE_LOCKED`) even with another `SINGIT_STATE_DIR`. It does not coordinate separate hosts. Locks are never removed by age.
- **No guessed cleanup.** On-chain `held == 0` is never read as repayment (a capture empties a hold too); a cleanup op stays `unknown` with its reservation until its own transaction is proven. Live mode sends no automatic cleanup release: a wrong-terms hold is quarantined with its amount still committed.
- **Disputes are an application rule.** While a dispute is open, this service refuses captures; it is not an on-chain freeze, and the merchant key used outside the service could still capture. Live mode refuses the two-step "release what is still held, then refund" resolution (`ACTION_DISABLED`); release or capture first, then resolve with a single refund. A refund is merchant-funded and not guaranteed.
- **Buyer recovery after `captureDeadline`.** Expiry alone returns nothing. The payer's on-chain `reclaim` returns what is still held at or after `captureDeadline`, signed by the payer key with SOL for the fee; it is not an MCP tool and is a separately authorized operator action. Already captured funds are not affected by it.

## In-process use (dashboard)
`import { PaymentService } from "src/service.ts"`, `{ MockBackend } from "src/backend/mock.ts"`, `{ issueApprovalToken } from "src/approval.ts"`.
`new PaymentService({ backend, now?, approvalSecret?, mint?, store?, live? })`. Write methods (`createMandate, hold, capture, release, refund, openDispute, resolveDispute`) are async, take bigint amounts and throw `Refusal {code, message, operationId?}`; `holdOp/captureOp/releaseOp/refundOp` return `{hold, operationId, replay, txSig}`. `admissionStatus()` and `closeAdmission(code, reason)` expose write admission. Reads are sync: `getMandate(id)` (throws if missing), `listMandates()`, `listDisputes({status?, mandateId?})`, `getHold(id)`, `getDispute(id)`, `listAuditLog({mandateId?, limit?})`.
