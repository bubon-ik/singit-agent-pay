# Contributing

## Devnet backend (teammate)

The one open piece is the Solana devnet backend: **`singit-mcp/src/backend/capture402.ts` → `Capture402Backend`**. It is a stub today: every method throws `not_implemented`. The mandate engine, human approval, audit log and dashboard do not change; `SINGIT_BACKEND=capture402` selects your backend through `singit-mcp/src/backend/factory.ts`.

- The `PaymentBackend` contract and the capture402 instruction mapping are in [docs/INTERFACE.md](docs/INTERFACE.md) (hold = `authorize`, capture = `capture`, release = `void` / `releaseRemainder`, refund = `refund` from the merchant ATA, `getStatus` decodes `Payment`, `createMandate` is a no-op).
- Devnet only; the mint is pinned to devnet USDC (`DEVNET_USDC_MINT` in `singit-mcp/src/backend/types.ts`). The factory refuses mainnet RPC URLs.
- Keys come only from the file paths in `SINGIT_PAYER_KEYPAIR` / `SINGIT_MERCHANT_KEYPAIR`. Never generate, commit, log or print keys.

### Definition of done

1. `npm test` stays green (mock backend is still the default).
2. The shared conformance suite passes against devnet: `singit-mcp/test/backend-contract.ts` runs via `singit-mcp/test/backend-contract.capture402.test.ts`, gated on env (no keys in the repo):
   ```sh
   cd singit-mcp
   SINGIT_CONTRACT_DEVNET=1 SINGIT_PROGRAM_ID=<devnet program id> \
   SINGIT_PAYER_KEYPAIR=/path/payer.json SINGIT_MERCHANT_KEYPAIR=/path/merchant.json \
   SINGIT_PAYER_ADDRESS=<payer pubkey> SINGIT_MERCHANT_ADDRESS=<merchant pubkey> \
   npx vitest run test/backend-contract.capture402.test.ts
   ```
   Without those variables the devnet suite is skipped and prints what is missing. The same suite runs against `MockBackend` in `test/backend-contract.mock.test.ts`.
3. `npm run devnet:smoke` (in `singit-mcp/`, `scripts/devnet-smoke.ts`) succeeds with your own devnet keys and prints explorer links.
4. After a hold, `getStatus` returns the on-chain mint so the service re-check against devnet USDC is real; `txSig` is a devnet signature (`https://explorer.solana.com/tx/<sig>?cluster=devnet`).

## General

- Node 20/22/24, `npm ci` at the root, `npm test` before every PR.
- Never commit `.env*`, keypairs or `id.json`; `.gitignore` covers them.
- Keep the off-chain policy in `singit-mcp/src/service.ts`; backends only move money.
