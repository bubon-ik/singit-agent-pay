# Contributing

## Capture402 devnet backend

`singit-mcp/src/backend/capture402.ts` implements the public ABI pinned in
[the devnet guide](docs/CAPTURE402-DEVNET.md). The default remains MockBackend.
See that guide and `singit-mcp/.env.example` for configuration, local verification,
authorized live commands, funding estimates and PaymentService blockers.

Use Node 20/22/24, run `npm ci` at the root and `npm test` before a PR.
Never commit `.env*` except the empty `.env.example`, keypairs, signed wires or
live receipts. Keep off-chain policy in `singit-mcp/src/service.ts`.
Live signing/sending, funding and deployment each require separate authorization.
Do not retry an UNKNOWN outcome or manufacture a new payment identity.
