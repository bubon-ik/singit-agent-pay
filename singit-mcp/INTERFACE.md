# PaymentBackend contract (for the capture402 integration)

Implement `PaymentBackend` from [`src/backend/types.ts`](src/backend/types.ts). The MCP server checks every
mandate rule (budget, per-tx cap, expiry, allowed counterparties, open disputes, human approval) **before**
it calls the backend. The backend only moves escrowed testnet USDC. `MockBackend` (in-memory) is the reference
behaviour. `Capture402Backend` is the stub to fill in.

- **Units:** USDC base units, 6 decimals, `bigint` (1 USDC = `1000000n`). Strings at the MCP boundary only.
- **Times:** unix seconds, checked against the chain `Clock`.
- **holdId:** the capture402 **payment PDA** = `PDA(["auth-capture-v1", payer, salt], programId)`; vault = ATA(payment PDA, mint).
- **expectedHeld / expectedRefundable:** passed straight into capture/void/refund data. The program rejects the tx if on-chain state differs.
- **Off-chain only (no instruction):** mandates, per-tx caps, counterparty lists, disputes, human approval, audit log.

| Method | capture402 instruction (tag) | Data after tag | Accounts (s = signer, w = writable) | Signs |
|---|---|---|---|---|
| `createMandate(terms)` | none (off-chain) | – | – | – |
| `hold({payer, payee, maximum, captureDeadline, refundDeadline, salt})` | `authorize` (0) | `version=1, escrow=0, fee=0:u64, salt:32, maximum:u64, captureDeadline:i64, refundDeadline:i64` (67 B) | payer(s,w), server=payee, payment PDA(w), mint, payer ATA(w), vault(w), rent funder(s,w), System, Token, ATA program | payer (+ funder) |
| `capture({holdId, amount, releaseRemainder, expectedHeld, expectedRefundable})` | `capture` (2) | `amount:u64, releaseRemainder:u8, expectedHeld:u64, expectedRefundable:u64` (26 B) | server(s), payment(w), mint, vault(w), server ATA(w), payer ATA(w), Token | merchant |
| `release({holdId, expectedHeld, expectedRefundable})` | `void` (3) | `expectedHeld:u64, expectedRefundable:u64` (17 B) | server(s), payment(w), mint, vault(w), payer ATA(w), Token | merchant |
| `refund({holdId, amount, expectedHeld, expectedRefundable})` | `refund` (4) | `amount:u64, expectedHeld:u64, expectedRefundable:u64` (25 B) | server(s), payment(w), mint, server ATA(w), payer ATA(w), Token | merchant |
| `getStatus(holdId)` | read `Payment` account | 176 B, `SACPAY01`: payer, server, mint, salt, maximum, capture_deadline, refund_deadline, held, refundable | – | – |

Not exposed as a tool: `reclaim` (1). The payer can take back an unused hold at or after `captureDeadline`, with no merchant consent needed. This is the payer's safety net if the seller goes silent.

**On-chain rules (mirrored by MockBackend):**
- `authorize`: `maximum > 0`, `now < captureDeadline <= refundDeadline`, payer ≠ server. The full maximum moves into the vault (`held = maximum`, `refundable = 0`).
- `capture`: `now < captureDeadline`, `0 < amount <= held`. Then `held -= amount` (or `held = 0` with releaseRemainder, the rest goes to the payer) and `refundable += amount`.
- `void`: `held > 0`. Everything held goes back to the payer.
- `refund`: `now < refundDeadline`, `0 < amount <= refundable`. It is paid from the **merchant's ATA**, not the vault, and it never restores the authorization.
- Errors are plain `ProgramError`s (`InvalidArgument`, `InsufficientFunds`, …), with no custom codes. Map them to `BackendError(code, message)`, using the facilitator reason names in `integration/src/facilitator.ts` (`Reason`) where possible.

**TS helpers to reuse** (capture402 `integration/src`): `authorizeInstruction`, `captureInstruction`, `voidInstruction`, `refundInstruction` (transactions.ts), and `paymentAddress`, `ata`, `decodePayment` (program.ts).

Devnet/test keys and mints only. Never real keys.
