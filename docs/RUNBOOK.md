# Devnet operator runbook (MVP-08, #15)

Experimental Solana devnet only. Not production software and not audited. Read [RELEASE-GATE.md](RELEASE-GATE.md) first. The ordered gates in [MVP-SCENARIO.md](MVP-SCENARIO.md) distinguish offline readiness, explicit authorization for one run, and final acceptance after that run. None is granted by this document.

The core rule: **UNKNOWN or any invariant failure stops writes first.** Never retry an uncertain payment with a new key, refresh its blockhash or salt, switch RPC provider, clear the journal, or compensate automatically.

## 1. Before the run (owner fills this in)

| Item | Value |
|---|---|
| Scenario (one) | hold 1 USDC → capture 0.65 with atomic release of 0.35; no separate release transaction |
| USDC cap for the whole run | |
| Payer SOL cap / merchant SOL cap | see the fee table in [CAPTURE402-DEVNET.md](CAPTURE402-DEVNET.md) |
| Maximum attempts | 1 (UNKNOWN is never repeated) |
| Operator | |
| Stop/go owner | |
| Reviewer | |
| Buyer recovery owner (reclaim after `captureDeadline`) | |
| SingIt SHA / Capture402 ABI pin | must match RELEASE-GATE.md |
| Capture402 integration/merchant source SHA and all lockfile digests | |
| Existing deployment record digest, program/ProgramData, loader, executable digest/size, slot, upgrade authority | |
| Executable digest definitions | Capture402: source-sized slice plus zero-padding check; SingIt: entire ProgramData payload after 45-byte metadata, including padding. Record both digests/sizes and reviewed byte linkage |
| Network/genesis, approved RPC configuration identifier, mint/token program | private binding; never put credential-bearing URLs here |
| Upgrade policy during the verification window | no upgrade or identity change; any change invalidates admission |
| Wallet namespace, original journals and canonical ATAs | retained private configuration; no unresolved originals |
| Owner authorization reference | must explicitly cover read-only preflight and the one exact run |

Checklist:
- [ ] The private env file is outside the checkout, mode 600, and based on `singit-mcp/deploy/hackathon.env.example` with `SINGIT_BACKEND=capture402`, an approved HTTPS devnet RPC, the confirmed program values, keypair paths, payer and merchant public addresses, `SINGIT_STATE_DIR` and both human secrets (16+ chars, all distinct).
- [ ] Payer and merchant are throwaway devnet wallets with Circle devnet USDC, SOL and canonical ATAs (MVP-06).
- [ ] Agent tokens `SINGIT_BUYER_TOKEN` / `SINGIT_MERCHANT_TOKEN` (16+ chars, distinct) are set in the env file for the buyer and merchant agents. `live:all` then runs without trusted-operator mode. Agents never get keypairs, human secrets or RPC credentials.
- [ ] Locked dependencies are installed; `OFFLINE_READY` is recorded for the final combined source, including the review, useful real-LLM mock trace and merchant profile.
- [ ] The owner explicitly records `ONE_RUN_AUTHORIZED` before any live preflight or startup RPC. It names this deployment, namespace, scenario, deadlines, fee/budget caps and one attempt; refund/reclaim are separate actions.
- [ ] Read-only preflight under that authorization verifies source/deployed identity, network, roles, mint/ATAs, liquidity/SOL and absence of unresolved originals. A failed or uncertain check stops here; never deploy/fund/change providers to make the check pass.

This limited admission precedes E2E. It is not `MVP_ACCEPTED`; that decision follows
the run's original finalized outcomes, durable artifact and explicit operator and
reviewer acceptance. Local scenarios are in [RECOVERY-OFFLINE.md](RECOVERY-OFFLINE.md).

## 2. Start

```sh
# Only after the separately recorded operational authorization above:
npm run live:all -- /absolute/path/to/private/devnet.env
```

Startup runs in this order and refuses to serve on any failure:
1. Private state path and permissions.
2. Exclusive custody: the state directory lock, then the wallet namespace lock.
3. Load the journal; restore pending records.
4. Read-only reconciliation against original transactions. Nothing is signed or sent.
5. Network, deployment and wallet preflight.
6. Admission opens.

| Startup refusal | Meaning | Action |
|---|---|---|
| `PRIVATE_STATE_REQUIRED` | state dir missing, relative, inside Git or a symlink | fix the env file |
| `STATE_STORE_LOCKED` / `NAMESPACE_LOCKED` | another runtime holds this state dir or these wallets | see section 6 |
| `STARTUP_RECONCILIATION_REQUIRED` | an original outcome is still unresolved | see section 5; do not delete anything |
| preflight error | RPC, deployment or wallet account mismatch | stop; check MVP-06 values |

## 3. Watch while it runs

| What | How |
|---|---|
| Process alive | `GET /health` → `{ok: true}` (liveness only) |
| Allowed to pay | `GET /ready` with header `x-singit-human-secret` → 200 `ready: true`; 503 shows `admission.code` and `unresolvedOps` |
| Operations | dashboard, or `GET /api/state` → `ops` (public projection only) |
| One operation | MCP `get_operation {operationId}` |
| Alarms | audit `OUTCOME_UNKNOWN`, `/ready` 503, any `STORAGE_FAILURE` or `ADMISSION_CLOSED` refusal |

Log every `operationId` the agent receives, together with its intent and idempotency key.

## 4. Stop (kill switch)

- **Normal stop:** Ctrl-C in the `live:all` terminal, or `kill -TERM <mcp pid>`. Admission closes first; PR #23 drains accepted calls, backend work, local commits and audit before releasing custody locks. The journal and evidence stay untouched. A hung drain does not permit a second runtime.
- **Automatic stop:** an UNKNOWN outcome or a failed journal write closes admission by itself. Reads and same-key replays still work.
- Use `kill -9` only for a hung process. Then follow section 6 before restarting.

## 5. When something goes wrong

If startup refuses, use the strictly offline inspection command in [JOURNAL.md](JOURNAL.md).
It imports no backend and never repairs or truncates records. Corrupt/unsupported
journals and ambiguous legacy terminal accounting remain blocked for review.

| Signal | Do | Never |
|---|---|---|
| `OPERATION_UNKNOWN` | Stop the run (admission is already closed). Note the `operationId`. Observe it with `get_operation`, or by retrying the **same** key, which only observes. After a stop, restart only when the original transaction has finalized: startup reconciles it read-only. | new key, new salt or blockhash, other RPC provider, manual void/refund to "fix" it |
| `STORAGE_FAILURE` | Stop writes. Preserve an unchanged private journal copy after the writer stops; inspect it offline. Resolve disk/permission problems and review compatibility before a fresh startup in the same namespace. Startup may observe originals; an incomplete record remains blocked. | edit/truncate/clear the journal, reopen the poisoned writer or assume a failed fsync wrote nothing |
| `STARTUP_RECONCILIATION_REQUIRED` | Wait for the original signatures to finalize, then restart. Inspect the private journal only locally. | delete the journal, change `SINGIT_STATE_DIR` or wallets to get past it |
| `ACTION_DISABLED` on a dispute | Stop that workflow and retain the dispute/originals. Any agreed merchant refund or payer recovery needs its own accepted procedure and explicit authorization. | release or capture merely to bypass the multi-step guard; automatic compensation |
| Quarantined hold (wrong terms) | Funds stay committed; use buyer recovery (section 7) | automatic or ad-hoc release |

## 6. Stale locks after a crash

The lock files hold the PID of their owner: `.singit-mcp.lock` in `SINGIT_STATE_DIR`, and `<hash>.lock` in `SINGIT_NAMESPACE_LOCK_DIR` (default `~/.singit-mcp/locks`).
1. Read the PID from the file and confirm the process no longer exists (`ps -p <pid>`).
2. Only then remove that lock file. Locks are never removed by age.
3. Never run two runtimes for the same wallets, even on different hosts: the lock covers one host only.

## 7. Buyer recovery after `captureDeadline`

- Expiry alone returns nothing.
- What is still held can be returned only by the payer's on-chain `reclaim`, at or after `captureDeadline`, signed by the payer key with SOL for the fee.
- `reclaim` is not an MCP tool. Capture402 already provides `integration/src/reclaim.ts` and an unsigned-offer route. Their local scenario coverage is in [RECOVERY-OFFLINE.md](RECOVERY-OFFLINE.md). The accepted bounded MVP packet privately records the selected deployment binding and operator-route review. The normal purchase did not execute a live reclaim or refund; either requires separate authorization and its own original evidence.
- Already captured funds are not affected. A refund of captured funds is merchant-funded and never guaranteed.
- Bind the existing deployment record, source/artifact, network/genesis, program/loader/ProgramData/slot/upgrade authority, mint/token program, original payment PDA/payer/merchant/terms, approved RPC, payer fee readiness and retained journal/namespace before accepting a route. Use the Capture402 companion checklist; a network label or matching program address is insufficient.
- Stop the payment runtime and establish exclusive custody before a separately authorized operator recovery. Do not run an external payer CLI concurrently with the runtime or discard its locks/history to obtain custody.
- Preserve the original reclaim signature, exact wire, simulation, expected H/F and finalized outcome/token effects privately. This MVP procedure does not use `--retry-after`/`--blockhash-slot`. UNKNOWN, expiry and missing history never authorize another attempt.
- H=0 can follow capture. It proves neither payer repayment nor the original reclaim outcome. Do not release local reservations or repair mandate budget from it. External reclaim does not automatically update PaymentService accounting.

### Agreed merchant-funded refund (separate operation)

Refund requires the stored merchant's authority, USDC liquidity and SOL, strict
refund deadline and exact H/F. Bind the agreed amount to its own intent, stable
idempotency key and original operation ID. Observe/replay only that original
after response loss; never change payer, merchant, provider or key after an error.
It does not replenish mandate budget, reopen H or increase the original maximum.
Human dispute approval cannot replace the merchant signature. Do not enable the
unaccepted release-plus-refund dispute path or automatic live cleanup.

The normal 1 → 0.65 purchase has no refund or separate release transaction. A
refund/reclaim rehearsal is not implicitly included in its one-run authorization.
SOL shortage and merchant liquidity shortage are safe refusals; funding needs
separate authorization and is never an automatic repair.

## 8. Rollback

- A code rollback cannot roll back chain state.
- Never clear or reset the journal, move to new wallets to escape open obligations, or start an older reader on a newer journal.
- If in doubt, stop and keep everything as it is.

## 9. Evidence

Keys, RPC URLs with credentials, signed wires, journals, live receipts and wallet identities stay private. Anything public (screenshots, PR text, the demo) is synthetic or separately approved, and labeled MOCK, HISTORICAL or LIVE.

## 10. Event checklist (20 October 2026, 13:30 Europe/Prague)

- [ ] Re-confirm the track, timing and submission rules on https://thefintechers.com/hackathon.
- [ ] Freeze the SHA; re-run the offline gate on it; update RELEASE-GATE.md.
- [ ] Give the jury repository access and setup instructions (README → `npm run demo:all` for the mock demo).
- [ ] Declare honestly what existed before the event and what was built during it.
- [ ] Demo plan: 4 minutes plus 3 minutes Q&A. Without a live GO, run the mock demo labeled MOCK; historical devnet results are labeled HISTORICAL. A video is not proof of a live run.
