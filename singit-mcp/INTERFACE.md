# PaymentBackend contract (for the capture402 integration)

Implement `PaymentBackend` from [`src/backend/types.ts`](src/backend/types.ts). The MCP server checks every
mandate rule (budget, per-tx cap, expiry, allowed counterparties, open disputes, human approval) **before**
it calls the backend. The backend only moves escrowed testnet USDC. `MockBackend` (in-memory) is the reference
behaviour. `Capture402Backend` implements the pinned public ABI; live acceptance is separate (see [devnet guide](../docs/CAPTURE402-DEVNET.md)).

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

See [devnet setup and acceptance](../docs/CAPTURE402-DEVNET.md) and
[environment template](.env.example) for exact configuration, commands, private
before-send evidence, funding estimates, skipped live tests, upgrade limitations
and the **unresolved PaymentService durable journal/reservation dependency**.
Direct backend smoke is separate from a full MCP E2E. Live signing/sending,
funding and deployment require separate explicit authorization.

## For the Capture402Backend implementer

`src/backend/capture402.ts` is owned by the teammate (implementation above). Our side ships the contract and the harness, and the implementation must keep passing them:

- **Selection:** `buildBackendFromEnv` in [`src/backend/factory.ts`](src/backend/factory.ts) builds `Capture402Backend` when `SINGIT_BACKEND=capture402`, from explicit provider/deployment configuration (see the devnet guide and [`.env.example`](.env.example); no default RPC); mainnet hosts are refused. Change the constructor if you need to, and update the factory in the same commit.
- **Keys:** only from the file paths in `SINGIT_PAYER_KEYPAIR` (signs `authorize`) and `SINGIT_MERCHANT_KEYPAIR` (signs capture/void/refund, incl. human-approved refunds). Never generate, store, log or print keys. Missing/unreadable key -> `BackendError` with a clear code.
- **Contract requirements** (all checked by the conformance suite):
  1. Shapes as in `types.ts`: `hold` -> `{holdId: payment PDA, txSig}`, writes -> `{txSig}` (devnet signatures), `createMandate` -> `{}` (no-op, mandates stay off-chain).
  2. `capture` partial with `releaseRemainder:false` leaves `held = maximum - amount`; `releaseRemainder:true` sets `held = 0`. `release` = `void`. `refund` is paid from the merchant ATA, `amount <= refundable`.
  3. `getStatus` decodes the `Payment` account and returns every `EscrowStatus` field (bigints for amounts, unix-second numbers for deadlines), `null` if the account does not exist.
  4. **Mint re-check (QA M-2):** `getStatus` must report the **actual on-chain** mint. `PaymentService.hold` re-reads it after `authorize` and refuses `WRONG_MINT` (budget restored, remainder voided, hold never active) unless it equals `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. Refusing a non-USDC mint before sending is also fine.
  5. **Refund deadline exposed:** `getStatus().refundDeadline` must be the on-chain `refund_deadline`; `open_dispute` refuses `REFUND_WINDOW_CLOSED` once `now >= refundDeadline`.
  6. Errors are `BackendError` with `code` = capture402 facilitator reason, with or without the `invalid_auth_capture_svm_` prefix: `amount`, `unexpected_payment_state` (stale `expectedHeld/expectedRefundable`), `capture_deadline_expired`, `refund_deadline_expired` (the suite checks these four), plus `payment_not_found`, `empty_hold`, `insufficient_funds` as in MockBackend.
- **Conformance suite:** [`test/backend-contract.ts`](test/backend-contract.ts) `runBackendContract(label, makeFixture)`. `MockBackend` passes it in CI (`test/backend-contract.mock.test.ts`). The devnet run (`test/backend-contract.capture402.test.ts`) is skipped unless all of these are set:
  `SINGIT_CONTRACT_DEVNET=1 SINGIT_PAYER_KEYPAIR=<path> SINGIT_MERCHANT_KEYPAIR=<path> SINGIT_PAYER_ADDRESS=<pubkey> SINGIT_MERCHANT_ADDRESS=<pubkey> SINGIT_PROGRAM_ID=<id> npx vitest run test/backend-contract.capture402.test.ts`
  (`SINGIT_CONTRACT_UNIT`, default `100000` = 0.1 USDC per test unit; about 7 holds, so ~0.7 USDC moved and ~0.03 SOL of rent locked). Deadline-expiry and wrong-mint cases run on the mock only.
- **Smoke:** `npm run devnet:smoke` ([`scripts/devnet-smoke.ts`](scripts/devnet-smoke.ts)). With no env it prints a preflight checklist and exits 1 without sending anything. With the env above (+ `SINGIT_BACKEND=capture402`) it checks the devnet genesis hash and SOL/USDC balances, then hold 1 USDC -> capture 0.6 -> release 0.4 -> getStatus, printing explorer links (`?cluster=devnet`).
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
| 10 | Dispute: only the hold's payer opens it, and only while `now < hold.refundDeadline` (same boundary as refund — a dispute after that could never be refunded); it freezes captures. `resolve_dispute` needs a **human approval token**, an HMAC over `(disputeId, outcome, refundAmount)` keyed by `SINGIT_HUMAN_APPROVAL_SECRET` and issued with `npm run approve`. No MCP tool can produce it. "refund" releases what is still held (void) and then calls `refund`, signed by the merchant key the backend holds. "reject" sends no tx. | `REFUND_WINDOW_CLOSED`, `HUMAN_APPROVAL_REQUIRED` | H-1 |

**Merchant signer (H-1):** the program has no arbiter, so a human-approved refund is executed with the **merchant/server key** held by the backend. Keys: devnet throwaway keypairs generated locally by the team, loaded from env (`SINGIT_PAYER_KEYPAIR` / `SINGIT_MERCHANT_KEYPAIR`), never committed; agents never see keys. The service never generates or stores keys.

## Audit log (stable, consumed by the dashboard)

Schema: `AuditEntry` in [`src/audit.ts`](src/audit.ts). Fields are only ever added, never renamed.

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

## Operation journal, UNKNOWN outcomes, idempotency & salt reuse

Every money-moving call (`hold`/`capture`/`release`/`refund`/`resolve_dispute`, plus the internal
`cleanup_release`) runs through a durable `OperationRecord` (`src/store.ts`): `id, key, action,
actor, mandateId, holdId, disputeId?, params (+paramsHash), salt?, prepared?, expected?, state,
result?, error?, reservation, createdAt, updatedAt`. `state` moves `pending` -> `succeeded` |
`failed` | `unknown`.

- **`OPERATION_UNKNOWN`:** thrown when the backend throws `BackendOutcomeUnknown` (a possible send
  whose outcome is unproven) or anything else non-`BackendError` escapes the call — never
  reclassified as a definite failure. The reservation is kept, the per-hold lock stays held, and
  the op is marked `unknown`. It converges via `reconcile(opId)` / `reconcilePending()` (run at
  startup for ops a previous process left `pending`), or a retry with the **same
  `idempotencyKey`** (which reconciles first, then replays).
- **`BackendError`** is a definite outcome: `phase: "validation"` (never executed) or
  `"confirmed_failure"` (landed with an error) both mark the op `failed`, free its reservation
  (except `cleanup_release`, where the underlying hold is still genuinely held on-chain and must
  keep being retried), and surface a `Refusal`. `BackendError.code === "refund_deadline_expired"`
  (and any future facilitator synonym for it) maps to `REFUND_WINDOW_CLOSED` instead of the
  generic `BACKEND_ERROR`, matching `open_dispute`'s code for the same condition.
- **Idempotency:** the scoped key is `${action}:${actor}:${idempotencyKey}`. Same key + same
  params -> replays the (now-terminal) result, reconciling first if still `pending`/`unknown`.
  Same key + different params -> `IDEMPOTENCY_KEY_REUSED`.
- **Salt:** generated once per `hold` call and durably persisted on the op **before**
  `backend.hold()` is awaited (the journal write happens synchronously, before the first `await`).
  A reconcile or an idempotent replay of that same op never regenerates the salt or targets a new
  PDA.
- **`getTxOutcome` is optional** on `PaymentBackend` — `Capture402Backend` does not implement it
  yet. When absent, `reconcile()` leaves the op `pending`/`unknown` rather than throwing; a
  same-idempotencyKey retry (which reconciles via `getStatus` where applicable) and a future
  `getTxOutcome` remain the ways to converge it. `MockBackend` implements it, so it exercises the
  full reconcile path in tests.
- **`onPrepared` (`SubmitContext`)** is optional too: a backend that calls it durably records
  `op.prepared` (`txSig`/`holdId`/`lastValidBlockHeight`) before sending, so a reconcile after a
  lost response can still resolve truth even without `getTxOutcome`, as long as `getStatus`
  reflects the attempt.
- **Backend calls are serialized:** every money-moving backend call on a given `PaymentService`
  instance runs through one FIFO queue, so two concurrent calls (e.g. two holds racing on the same
  mandate) never overlap in flight on the backend, even though the reservation/lock checks above
  already make their outcome race-free.

`GET /api/state` also returns `ops: OperationRecord[]` (same shape as above, amounts as decimal
strings; `v` stays `1`).

## MCP tools (schemas: `toolSchemas` in [`src/server.ts`](src/server.ts), zod)

Amounts are base-unit decimal strings (`"2500000"` = 2.5 USDC). Times are integer unix seconds. Every write takes `actor`, the calling agent's id/address. The audit `action` is exactly the tool name. **`hold` is the pay tool**; there is no separate `pay`.

| Tool | Args | Returns (`ok: true`) |
|---|---|---|
| `create_mandate` | `actor, payer, totalBudget, perTxCap, expiresAt, allowedCounterparties[], note?` | `mandate, remaining` |
| `get_mandate` | `mandateId` | `mandate, remaining, holds[]` |
| `list_mandates` | – | `mandates: [{mandate, remaining, holds}]` |
| `hold` | `actor, mandateId, payee, amount, mint?, captureDeadline?, refundDeadline?` | `hold, txSig, remaining` |
| `capture` | `actor, holdId, amount, releaseRemainder?` | `hold, txSig` |
| `release` | `actor, holdId` | `hold, txSig` |
| `refund` | `actor, holdId, amount` | `hold, txSig` |
| `open_dispute` | `actor, holdId, reason, evidence[]` | `dispute` |
| `list_disputes` | `status? ("open"\|"resolved"), mandateId?` | `disputes[]` |
| `resolve_dispute` | `actor, disputeId, outcome ("refund"\|"reject"), refundAmount?, approvalToken` | `dispute, txSig` (null for reject) |
| `list_audit_log` | `mandateId?, limit?` | `entries: AuditEntry[]` |

- **Refusal:** `isError: true`, `{ok: false, code, reason}`. The same object is in `structuredContent` and as JSON text in `content`.
- **Hold object:** `id, mandateId, payer, payee, mint, maximum, held, captured, refunded, captureDeadline, refundDeadline, txSigs[], lastTxSig, disputeId?`.
- **txSig / txRef:** `txSig` is a mock ref (`mock-tx-N`) for MockBackend and a finalized devnet signature for Capture402Backend that links to the Solana explorer (`https://explorer.solana.com/tx/<sig>?cluster=devnet`). It appears in the tool result, in `hold.txSigs`/`lastTxSig`, in `dispute.txSigs`, and in the audit `txSig`.
- **Approval token:** `issueApprovalToken(secret, {disputeId, outcome, refundAmount})` in `src/approval.ts`. It is HMAC-SHA256 over `singit-dispute-v1|disputeId|outcome|amount`, and the amount is forced to 0 for `reject`. CLI: `SINGIT_HUMAN_APPROVAL_SECRET=… npm run approve -- d-1 refund 2500000`.

## Transports
- stdio (default): `npx tsx src/index.ts`
- streamable HTTP: `--http` or `SINGIT_MCP_HTTP=1`. Binds `127.0.0.1`, **port 8787** (override with `PORT`), path `/mcp`, `GET /health`. Stateless, with one shared in-memory state per process.
- Backend: `SINGIT_BACKEND=mock` (default) or `capture402` (built by `buildBackendFromEnv`; explicit provider/deployment configuration required, see devnet guide). `SINGIT_MOCK_BALANCES='{"buyer-agent":"100000000"}'`.
- Durable state (optional): `SINGIT_STATE_DIR` points `PaymentService` at a `FileStateStore` journal directory (`state.jsonl`); unset = in-memory `MemoryStateStore`, nothing survives a restart. Devnet signing keys: `SINGIT_PAYER_KEYPAIR`, `SINGIT_MERCHANT_KEYPAIR` (file paths only — see "Capture402Backend implementation" above; never log or print their contents).
- HTTP handler lives in `src/http.ts` (`createHttpHandler`); `src/index.ts` just wires env/backend into it. Two rate-limit buckets, each its own `createRateLimiter` instance keyed by `cf-connecting-ip` header ?? socket address: `"mcp"` (`SINGIT_RATE_LIMIT_PER_MIN`, default 120) covers `/mcp` and `/human/resolve`; `"state"` (`SINGIT_STATE_RATE_LIMIT_PER_MIN`, default 600) covers `GET /api/state`. Over the limit: `429 {ok:false, error:"rate limited"}` with `Retry-After: 60`.
- `GET /api/state`: dashboard snapshot — `{v: 1, backend, mandates, disputes, audit, holds, ops}` (bigints as decimal strings; `holds` is every hold across all mandates, `ops` is every operation journal record — see "Operation journal" above). `Access-Control-Allow-Origin: *` (read-only, GET only).
- `POST /human/resolve`: human console for `resolve_dispute`, same shape as the MCP tool (`{disputeId, outcome, refundAmount?, actor?, approvalToken?}`), no CORS. The request always needs header `x-singit-human-secret` equal to `SINGIT_HUMAN_ROUTE_SECRET` (only honored if ≥16 chars), checked first regardless of `approvalToken`. If `approvalToken` is in the body it's passed through as-is (the service HMAC-verifies it); otherwise the server mints the token itself. Missing/wrong header → 401 `HUMAN_AUTH_REQUIRED`; route secret not configured → 403 `HUMAN_ROUTE_DISABLED`; refusal from the service (e.g. a forged/invalid token) → 409 `{ok:false, code, reason}`; bad JSON/amount → 400 `INVALID_INPUT`. Body capped at 64 KB. Success: 200 `{ok:true, dispute, txSig}`.
- `POST /human/reset` (HTTP only, not an MCP tool): same `x-singit-human-secret` auth as `/human/resolve` (403 `HUMAN_ROUTE_DISABLED` / 401 `HUMAN_AUTH_REQUIRED`; `approvalToken` is not accepted), checked before the mode check. Only works on the mock backend — otherwise 409 `{ok:false, code:"RESET_MOCK_ONLY"}`. Replaces the shared `PaymentService` with a fresh one seeded from `DEFAULT_MOCK_BALANCES`/`SINGIT_MOCK_BALANCES`, records one `"reset"` audit entry, and responds 200 `{ok:true, reset:true, audit}`. Body optional `{actor?: string}`, default `"human"`.
- Default mock balances (`DEFAULT_MOCK_BALANCES` in `src/backend/mock.ts`, used whenever `SINGIT_MOCK_BALANCES` is unset): `buyer-agent` and `agent:research-bot` 100 USDC; `seller-agent`, `agent:data-vendor` and `agent:gpu-broker` 20 USDC (the dashboard story uses the `agent:` ids).

## In-process use (dashboard)
`import { PaymentService } from "src/service.ts"`, `{ MockBackend } from "src/backend/mock.ts"`, `{ issueApprovalToken } from "src/approval.ts"`.
`new PaymentService({ backend, now?, approvalSecret?, mint? })`. Write methods (`createMandate, hold, capture, release, refund, openDispute, resolveDispute`) are async, take bigint amounts and throw `Refusal {code, message}`. Reads are sync: `getMandate(id)` (throws if missing), `listMandates()`, `listDisputes({status?, mandateId?})`, `getHold(id)`, `getDispute(id)`, `listAuditLog({mandateId?, limit?})`.
