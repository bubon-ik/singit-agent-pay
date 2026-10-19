# Capture402 backend: local implementation and devnet acceptance

This backend is for a **trusted local devnet service with separate throwaway keys**.
It is implemented and tested offline. No live signing, RPC request, funding,
deployment, devnet acceptance or full MCP E2E is established by local tests.
The direct smoke and contract suite require separate explicit owner authorization
before live execution. Live MCP use still requires review of the configured durable
store, startup restoration of unresolved evidence and the acceptance gates below.

## ABI and provenance

Pinned source: [starPaw/capture402-solana @ 236b09a44240d285ee6f33d2e8dac79f81058e3d](https://github.com/starPaw/capture402-solana/tree/236b09a44240d285ee6f33d2e8dac79f81058e3d).
`src/lib.rs` is normative. `singit-mcp/src/backend/capture402-abi/program.ts`
reuses the public `integration/src/program.ts` unchanged apart from provenance
comments. `instructions.ts` extracts the four instruction builders from public
`integration/src/transactions.ts`, changing only imports. No facilitator,
operational files, acceptance records or secrets are copied. Apache-2.0 and
upstream contributor attribution are retained in LICENSE and NOTICE.

`hold` signs authorize with the payer, who is also creation funder and fee payer.
Capture, void/release and refund are merchant-signed with merchant-paid fees.
There is no delegate substitution, facilitator or browser wallet flow.
`createMandate` returns `{}`; mandate policy remains off-chain. Refund transfers
from the merchant's canonical USDC ATA, never the escrow vault. `held = 0` does
not prove payment: void/reclaim also set it to zero, and refundable can decrease
through refunds. Payment history needs original finalized transaction evidence.

## Configuration and independent deployment acceptance

Copy `singit-mcp/.env.example` to a private ignored environment file and fill it
locally; never paste key material into chat. The program ID is mandatory; the
partner-confirmed hackathon deployment is recorded below. A deployer public key
is not a program ID. Local `[42;32]` and other source fixture IDs prove no deployment.

### Confirmed devnet deployment (hackathon fixture)

Public deployment identity supplied by the Capture402 author (starPaw) for this
hackathon. These are public on-chain values, not secrets:

```sh
SINGIT_PROGRAM_ID=992QmwmwCebawRJsTCgvc8qnzGivbFaD39ZQE7VhHp7o
SINGIT_PROGRAM_DATA=HTKbRudHxuqgQvqpfrUM59ZohVfbx81Yu8Bdyp897doM
SINGIT_DEPLOYMENT_SLOT=508146249
SINGIT_EXECUTABLE_SHA256=adee4e8f51fbc52b046c4d5a846c63ecdb63d392b1d16b559d3f6c2984b27415
```

Provenance: `992Qmwmw…` also appears as a test fixture in capture402-solana
`ops/test_reconcile_wire.py:17`; that repo reference proves nothing. It is the
deployment ID here only because the partner confirmed it as their devnet deployment.

Read-only check on 2026-10-19 (one public devnet RPC, genesis
`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, finalized):

- Program account exists, `executable: true`, owner
  `BPFLoaderUpgradeab1e11111111111111111111111`, points to the ProgramData above.
- ProgramData is owned by the upgradeable loader, has deployment slot `508146249`, and
  SHA256 of bytes after offset 45 (including padding) equals the value above.
- On-chain upgrade authority: `FoPVWtFGoGmnJCarUaqA7bbyhNpR7QsRDE171oDp1Bqm`
  (the program is upgradeable; the partner still has to confirm who holds this key).

This shows that the values agree with chain state. It is **not** independent acceptance:
nobody has compared a source build of the pinned commit with this payload yet.

**Still needed before any live smoke** (public values only, never keys):

- `SINGIT_PAYER_ADDRESS`, `SINGIT_MERCHANT_ADDRESS` (public keys of separate
  throwaway devnet wallets; keypair files stay local, outside Git, mode 600)
- confirmation of the upgrade authority above and its upgrade policy during the hackathon
- RPC choice: approved Helius/QuickNode HTTPS endpoint (the backend refuses public RPC)
- funding status: payer/merchant SOL and Circle devnet USDC ATAs (see planning table below)

Before configuration, the owner must independently approve the devnet deployment
and the executable built from the pinned source. Supply its program ID,
ProgramData address, deployment slot and SHA256 of the complete ProgramData
executable payload **after the 45-byte metadata, including allocation padding**.
This digest is not necessarily the SHA256 of an unpadded `.so` build artifact.
Compare source-built executable bytes with the deployed payload and account for
padding in that external review. A hash copied from an arbitrary RPC account is
not independent acceptance. The backend checks the upgradeable loader, executable
flag, Program-to-ProgramData pointer, slot and payload digest on every operation,
including immediately before a send. Other loader formats are refused.
An upgrade between this check and execution remains possible: upgrade authority
and deployment trust must be reviewed separately; this protocol has no atomic
code-hash pin in its transaction ABI.

Set an explicitly approved HTTPS Helius (`*.helius-rpc.com`, `*.helius.xyz`) or
QuickNode (`*.quiknode.pro`) RPC URL. The backend enforces Capture402's provider
policy and checks actual genesis
`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`; hostname is not network proof.
There is no default or fallback to public RPC, provider switch or resend.
RPC credentials, including path credentials, are never printed by these tools.

The only mint is Circle devnet USDC
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (six decimals, classic SPL Token).
Create and fund **canonical payer and merchant ATAs separately with authorization**.
The backend does not create these accounts or fund wallets. It creates only the
payment and its vault through authorize. Capture402's own faucet token is a
different mint and is refused. Both configured signers must match request and
payment identities. Key files must live outside Git checkouts.

Payment reads validate owner, discriminator, exact 176-byte size, decoded
invariants, canonical PDA, mint and all relevant ATAs, including vault backing,
no native token state, no frozen accounts and no vault delegate/close authority.
Only a finalized RPC account response of `null` yields `getStatus() === null`.
Malformed accounts and RPC failures produce distinct errors. Mint is returned
from the verified decoded payment. Amounts/guards are u64 bigint; deadlines must
fit the interface's exact safe-integer unix-second representation and obey chain
Clock boundaries. Application deadline/budget rules still belong to PaymentService.

## Outcomes and PaymentService dependency

The receipt shapes in PaymentBackend are unchanged. The compatible error extension is:

- `BackendError.phase === "validation"`: no transaction was submitted by this
  invocation. Codes such as `amount`, `unexpected_payment_state`, deadline and
  insufficient-funds errors describe observed pre-send conditions. Simulation
  rejection is `simulation_failed`, without inventing a specific on-chain reason.
- `BackendError.phase === "confirmed_failure"`, code `transaction_failed`: the
  original signature finalized with `err != null`; details retain signature and
  actual transaction error. Generic Solana `InvalidArgument` is not guessed to
  mean a particular Capture402 reason.
- `BackendOutcomeUnknown` is a separate Error with code `unknown_outcome` and
  `evidence`: operation, holdId, salt for authorize, amount/guards for mutations,
  original signature, exact signed wire, blockhash/lifetime, program/network and
  ABI commit. A lost send response, lost confirmation response, returned signature
  mismatch or confirmation timeout is UNKNOWN. Missing history is inconclusive.

Success requires the original signature at `finalized` with `err === null`.
`sendTransaction` uses `maxRetries: 0`. No salt, blockhash or signed message is
regenerated after a possible send. The backend protects one write/reconciliation at a time per instance. Overlapping
calls get validation-phase `backend_busy` without another call's evidence. New
writes while an original operation remains unresolved get validation-phase
`reconciliation_required`; only the original possibly sent call raises UNKNOWN.
`pendingOperation` exposes the original immutable evidence.

`getTxOutcome(originalEvidence)` validates the original signed wire and returns
`landed`, `failed`, `pending` or `not_found`, plus `terminal`, `expired`, finalized
block height and a verified Payment snapshot. It clears the latch only for the
original signature finalized with known err. Signature history missing, expiry,
and matching/changed/absent Payment state alone never prove the original failed.
The snapshot is bounded by the observed finalized epoch/status slot through
`minContextSlot`; present-day token-account spendability is not payment history.
Reconciliation does not send or sign anything. A persistence error keeps the
latch. There is no reset/retry method. After restart the caller must load durable
pending evidence and call reconciliation before admitting a new write; construction
alone is **not durable retry safety**. [Solana's RPC documentation](https://solana.com/docs/rpc/http/getsignaturestatuses)
describes the history search; [getTransaction](https://solana.com/docs/rpc/http/gettransaction)
explicitly permits null when a transaction is not found at the requested commitment.

Each economic method also accepts per-call `{onPrepared: async prepared => ...}`.
The `SubmitContext` hook receives `PreparedTx`: `txSig`, PDA/holdId, a safe numeric
`lastValidBlockHeight` and nested `evidence` retaining the original signature,
salt, amount/guards, wire and string lifetime. Its failure prevents send.
PaymentService journals the complete prepared object, and `OperationRecord`
retains it across JSON storage/reload. Reconciliation forwards `prepared.evidence`
in the main-compatible `TxOutcomeQuery`. This adapter returns `executed` only for
original finalized success, `failed` only for original finalized error, and
`pending` for missing history or a legacy journal without its original wire.
It never returns a terminal `not_found` to PaymentService. The direct evidence
overload above retains its richer observations. The synchronous backend factory
does not create a journal. The MCP entrypoint requires `SINGIT_STATE_DIR`, restores
the private journal and performs read-only startup reconciliation before serving.
See [live startup and recovery](LIVE-DEMO.md).

HTTP and dashboard state expose an explicit public operation view. Prepared
metadata includes only `txSig`, `holdId` and `lastValidBlockHeight`; signed wires,
full evidence, salt and idempotency keys stay in the private journal. Redaction
applies before send and in pending, UNKNOWN, succeeded and failed states, including
after a retention hook rejects. Reading public state never alters the private
evidence used for restart recovery or reconciliation. The dashboard also redacts
records received from an older upstream before caching or publishing them.

The optional `retainBeforeSend(evidence)` dependency runs before any possible
submission; a sink failure prevents sending. The two live scripts use exclusive
mode-600 files with file/directory fsync in `SINGIT_EVIDENCE_DIR`, outside Git.
`retainFinalized(evidence, err)` saves the original finalized observation before
releasing the write latch. A new script run refuses an evidence directory with a
prepared wire lacking a matching finalized receipt. The live contract fixture
reuses one backend so UNKNOWN blocks subsequent tests. These checks do not
serialize independent concurrent processes; use isolated sequential runs.
A prepared file means **possibly sent**, even after a crash. Preserve it forever
until an independently reviewed reconciliation determines the original outcome.
Do not rerun a suite, refresh blockhash, generate another salt, switch provider,
remove evidence, or automatically void/refund to compensate for UNKNOWN.

**Remaining live MCP acceptance gates:** current main supplies PaymentService's
operation journal, reservations, write serialization and UNKNOWN handling. This
branch connects that API to the real backend and tests all four operations through
a durable offline restart. The live entrypoint now selects a private durable store,
locks its directory and restores/reconciles pending records before admitting writes.
An unresolved original outcome stops startup. Its startup pass never sends cleanup
or replacement transactions. Verify this recovery behavior on the operator host.
Same-wallet custody across state directories, storage-failure admission and
disabled automatic cleanup are now covered offline (see INTERFACE "Live safety
policy"); they still need review and live acceptance. Local compatibility and mock MCP E2E are not live economic acceptance.

## Local checks

From `singit-mcp/`:

```sh
npm ci
npm run typecheck
npm test
npm run devnet:smoke  # clean env: checklist, exit 1, no network/signing/send
```

The offline signed-RPC fixture runs the existing shared backend contract including
controlled deadlines and wrong mint. Additional tests exercise wire/account roles,
bigints, invalid network/deployment/mint/signers/accounts, funding checks, confirmed
failure versus lost responses, and no new operation after UNKNOWN. This is
synthetic evidence, not devnet execution. Upstream `sac001/002/003` tests execute
the source-built SBF in LiteSVM; their results are separate from backend RPC tests.

## Authorized devnet commands

After deployment/provider/keys, private evidence directory and funding have been
reviewed and separately authorized, load the private environment locally. From
`singit-mcp/`:

```sh
set -a
. ./.env.local
set +a
# Direct backend: hold 1 -> capture 0.6 -> release 0.4 -> refund 0.2 USDC.
npm run devnet:smoke
# Separate approval for the suite's additional economic actions; do not rerun after UNKNOWN.
SINGIT_CONTRACT_DEVNET=1 npx vitest run test/backend-contract.capture402.test.ts
```

The smoke records intent/salt before authorize, exact signed wires before every
send, finalized receipts and decoded states/balances after every successful step.
It checks payer/merchant USDC deltas as well as H/F, stale release/refund guards
and duplicate release, stopping without cleanup on any discrepancy. Explorer
links use `?cluster=devnet`. A direct smoke is not an MCP end-to-end acceptance.

The devnet suite executes seven holds at default unit `100000n` (0.1 USDC), four
captures, two voids and one refund. It includes one in-process PaymentService
scenario (not a remote MCP transport). **Its deadline-expiry and wrong-mint tests
are skipped** because the live fixture has neither a controllable Clock nor a
wrong-mint fixture. Wrong-network, corrupt-account, lost-response and deployment
fault injection are local tests only. No live induced UNKNOWN is authorized.

Conservative planning for **both** scripts once, in isolated wallets:

| Resource | Planned requirement (not a funding action) |
|---|---|
| Payer USDC | Gross authorizations: 1 + 7 × 0.1 = **1.7 USDC**; recommend at least 2 USDC before both scripts, more for extra runs |
| Merchant USDC | Must retain liquidity for 0.2 smoke refund + 0.02 suite refund; preceding captures supply this if no concurrent spending; pre-seed a separate buffer if needed |
| New payment/vault pairs | 8 pairs; payment identity/rent and vault remain allocated; no close instruction |
| Payer SOL | 8 authorize fees + 8 × quoted payment/vault rent; roughly 0.0333 SOL at 5000 lamports/signature and ordinary rent; use at least 0.05 SOL plus separate ATA setup |
| Merchant SOL | 10 submitted operation fees total; roughly 0.00005 SOL at the same fee assumption; keep 0.01 SOL buffer |
| Existing ATAs | Creation rent/fees for payer and merchant are additional if absent; no automatic provisioning |

Actual fee quotes and rent are fetched before each send; these estimates are not
RPC measurements. Suite tests leave some escrow held (about 0.34 USDC at default
unit); expiry alone returns nothing. Any later explicit release/reclaim is a
separate authorized action. A failed/UNKNOWN run may leave more funds reserved.
Final acceptance still requires verified deployment identity, funded isolated
wallets, the authorized devnet runs, independent review and a separate full MCP
E2E after PaymentService's journal/reservation fixes.
