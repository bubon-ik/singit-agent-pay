# PaymentBackend contract (for the capture402 integration)

Implement `PaymentBackend` from [`src/backend/types.ts`](src/backend/types.ts). The MCP server checks every
mandate rule (budget, per-tx cap, expiry, allowed counterparties, open disputes, human approval) **before**
it calls the backend. The backend only moves escrowed testnet USDC. `MockBackend` (in-memory) is the reference
behaviour. `Capture402Backend` is the stub to fill in.

- **Network:** Solana **devnet only**. Mint: devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (`DEVNET_USDC_MINT`). Base / EVM is out of scope.
- **Units:** USDC base units, 6 decimals, `bigint` (1 USDC = `1000000n`). Strings at the MCP boundary only.
- **Times:** unix seconds, checked against the chain `Clock`.
- **holdId:** the capture402 **payment PDA** = `PDA(["auth-capture-v1", payer, salt], programId)`; vault = ATA(payment PDA, mint).
- **expectedHeld / expectedRefundable:** passed straight into capture/void/refund data. The program rejects the tx if on-chain state differs.
- **Off-chain only (no instruction):** mandates, per-tx caps, counterparty lists, disputes, human approval, audit log.
- **Receipts:** `hold` returns `{holdId, txSig}`, the other writes return `{txSig}`. `txSig` is a mock ref (`mock-tx-N`) until `Capture402Backend` is wired to devnet; only then it is a devnet signature that links to the Solana explorer (`https://explorer.solana.com/tx/<sig>?cluster=devnet`). It is written to the audit log.

| Method | capture402 instruction (tag) | Data after tag | Accounts (s = signer, w = writable) | Signs |
|---|---|---|---|---|
| `createMandate(terms)` | none (off-chain) | – | – | – |
| `hold({payer, payee, mint, maximum, captureDeadline, refundDeadline, salt})` | `authorize` (0) | `version=1, escrow=0, fee=0:u64, salt:32, maximum:u64, captureDeadline:i64, refundDeadline:i64` (67 B) | payer(s,w), server=payee, payment PDA(w), mint, payer ATA(w), vault(w), rent funder(s,w), System, Token, ATA program | payer (+ funder) |
| `capture({holdId, amount, releaseRemainder, expectedHeld, expectedRefundable})` | `capture` (2) | `amount:u64, releaseRemainder:u8, expectedHeld:u64, expectedRefundable:u64` (26 B) | server(s), payment(w), mint, vault(w), server ATA(w), payer ATA(w), Token | merchant |
| `release({holdId, expectedHeld, expectedRefundable})` | `void` (3) | `expectedHeld:u64, expectedRefundable:u64` (17 B) | server(s), payment(w), mint, vault(w), payer ATA(w), Token | merchant |
| `refund({holdId, amount, expectedHeld, expectedRefundable})` | `refund` (4) | `amount:u64, expectedHeld:u64, expectedRefundable:u64` (25 B) | server(s), payment(w), mint, server ATA(w), payer ATA(w), Token | merchant |
| `getStatus(holdId)` | read `Payment` account | 176 B, `SACPAY01`: payer, server, mint, salt, maximum, capture_deadline, refund_deadline, held, refundable | – | – |

Not exposed as a tool: `reclaim` (1). The payer can take back an unused hold at or after `captureDeadline`, with no merchant consent needed. This is the payer's safety net if the seller goes silent.

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
| 10 | Dispute: only the hold's payer opens it; it freezes captures. `resolve_dispute` needs a **human approval token**, an HMAC over `(disputeId, outcome, refundAmount)` keyed by `SINGIT_HUMAN_APPROVAL_SECRET` and issued with `npm run approve`. No MCP tool can produce it. "refund" releases what is still held (void) and then calls `refund`, signed by the merchant key the backend holds. "reject" sends no tx. | `HUMAN_APPROVAL_REQUIRED` | H-1 |

**Merchant signer (H-1):** the program has no arbiter, so a human-approved refund is executed with the **merchant/server key** held by the backend. Keys: devnet throwaway keypairs generated locally by the team, loaded from env (`SINGIT_PAYER_KEYPAIR` / `SINGIT_MERCHANT_KEYPAIR`), never committed; agents never see keys. The service never generates or stores keys.

## Audit log (stable, consumed by the dashboard)

Schema: `AuditEntry` in [`src/audit.ts`](src/audit.ts). Fields are only ever added, never renamed.

```ts
{ seq, ts /*ISO UTC*/, actor, action /*create_mandate|hold|capture|release|refund|open_dispute|resolve_dispute*/,
  outcome /*"ok"|"blocked"|"error"*/, code /*RefusalCode|null*/, reason,
  mandateId, holdId, disputeId, amount /*base units string*/, txSig, held, refundable /*escrow state after*/ }
```

**On-chain rules (mirrored by MockBackend):**
- `authorize`: `maximum > 0`, `now < captureDeadline <= refundDeadline`, payer ≠ server. The full maximum moves into the vault (`held = maximum`, `refundable = 0`).
- `capture`: `now < captureDeadline`, `0 < amount <= held`. Then `held -= amount` (or `held = 0` with releaseRemainder, the rest goes to the payer) and `refundable += amount`.
- `void`: `held > 0`. Everything held goes back to the payer.
- `refund`: `now < refundDeadline`, `0 < amount <= refundable`. It is paid from the **merchant's ATA**, not the vault, and it never restores the authorization.
- Errors are plain `ProgramError`s (`InvalidArgument`, `InsufficientFunds`, …), with no custom codes. Map them to `BackendError(code, message)`, using the facilitator reason names in `integration/src/facilitator.ts` (`Reason`) where possible.

**TS helpers to reuse** (capture402 `integration/src`): `authorizeInstruction`, `captureInstruction`, `voidInstruction`, `refundInstruction` (transactions.ts), and `paymentAddress`, `ata`, `decodePayment` (program.ts).

Keys: devnet throwaway keypairs generated locally by the team, loaded from env (`SINGIT_PAYER_KEYPAIR` / `SINGIT_MERCHANT_KEYPAIR`), never committed; agents never see keys. Never real or mainnet keys.

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
- **txSig / txRef:** `txSig` is a mock ref (`mock-tx-N`) until `Capture402Backend` is wired to devnet; only then it is a devnet signature that links to the Solana explorer (`https://explorer.solana.com/tx/<sig>?cluster=devnet`). It appears in the tool result, in `hold.txSigs`/`lastTxSig`, in `dispute.txSigs`, and in the audit `txSig`.
- **Approval token:** `issueApprovalToken(secret, {disputeId, outcome, refundAmount})` in `src/approval.ts`. It is HMAC-SHA256 over `singit-dispute-v1|disputeId|outcome|amount`, and the amount is forced to 0 for `reject`. CLI: `SINGIT_HUMAN_APPROVAL_SECRET=… npm run approve -- d-1 refund 2500000`.

## Transports
- stdio (default): `npx tsx src/index.ts`
- streamable HTTP: `--http` or `SINGIT_MCP_HTTP=1`. Binds `127.0.0.1`, **port 8787** (override with `PORT`), path `/mcp`, `GET /health`. Stateless, with one shared in-memory state per process.
- Backend: `SINGIT_BACKEND=mock` (default) or `capture402` (stub, uses `SINGIT_RPC_URL`, `SINGIT_PROGRAM_ID`). `SINGIT_MOCK_BALANCES='{"buyer-agent":"100000000"}'`.
- HTTP handler lives in `src/http.ts` (`createHttpHandler`); `src/index.ts` just wires env/backend into it. Two rate-limit buckets, each its own `createRateLimiter` instance keyed by `cf-connecting-ip` header ?? socket address: `"mcp"` (`SINGIT_RATE_LIMIT_PER_MIN`, default 120) covers `/mcp` and `/human/resolve`; `"state"` (`SINGIT_STATE_RATE_LIMIT_PER_MIN`, default 600) covers `GET /api/state`. Over the limit: `429 {ok:false, error:"rate limited"}` with `Retry-After: 60`.
- `GET /api/state`: dashboard snapshot — `{v: 1, backend, mandates, disputes, audit, holds}` (bigints as decimal strings; `holds` is every hold across all mandates). `Access-Control-Allow-Origin: *` (read-only, GET only).
- `POST /human/resolve`: human console for `resolve_dispute`, same shape as the MCP tool (`{disputeId, outcome, refundAmount?, actor?, approvalToken?}`), no CORS. If `approvalToken` is in the body it's passed through as-is; otherwise the request needs header `x-singit-human-secret` equal to `SINGIT_HUMAN_ROUTE_SECRET` (only honored if ≥16 chars) and the server mints the token itself. Missing/wrong header → 401 `HUMAN_AUTH_REQUIRED`; route secret not configured → 403 `HUMAN_ROUTE_DISABLED`; refusal from the service → 409 `{ok:false, code, reason}`; bad JSON/amount → 400 `INVALID_INPUT`. Body capped at 64 KB. Success: 200 `{ok:true, dispute, txSig}`.
- `POST /human/reset` (HTTP only, not an MCP tool): same `x-singit-human-secret` auth as `/human/resolve` (403 `HUMAN_ROUTE_DISABLED` / 401 `HUMAN_AUTH_REQUIRED`; `approvalToken` is not accepted), checked before the mode check. Only works on the mock backend — otherwise 409 `{ok:false, code:"RESET_MOCK_ONLY"}`. Replaces the shared `PaymentService` with a fresh one seeded from `DEFAULT_MOCK_BALANCES`/`SINGIT_MOCK_BALANCES`, records one `"reset"` audit entry, and responds 200 `{ok:true, reset:true, audit}`. Body optional `{actor?: string}`, default `"human"`.
- Default mock balances (`DEFAULT_MOCK_BALANCES` in `src/backend/mock.ts`, used whenever `SINGIT_MOCK_BALANCES` is unset): `buyer-agent` and `agent:research-bot` 100 USDC; `seller-agent`, `agent:data-vendor` and `agent:gpu-broker` 20 USDC (the dashboard story uses the `agent:` ids).

## In-process use (dashboard)
`import { PaymentService } from "src/service.ts"`, `{ MockBackend } from "src/backend/mock.ts"`, `{ issueApprovalToken } from "src/approval.ts"`.
`new PaymentService({ backend, now?, approvalSecret?, mint? })`. Write methods (`createMandate, hold, capture, release, refund, openDispute, resolveDispute`) are async, take bigint amounts and throw `Refusal {code, message}`. Reads are sync: `getMandate(id)` (throws if missing), `listMandates()`, `listDisputes({status?, mandateId?})`, `getHold(id)`, `getDispute(id)`, `listAuditLog({mandateId?, limit?})`.
