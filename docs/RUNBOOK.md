# Devnet operator runbook (MVP-08, #15)

Experimental Solana devnet only. Not production software and not audited. Read [RELEASE-GATE.md](RELEASE-GATE.md) first: a live run needs a GO there.

The core rule: **UNKNOWN or any invariant failure stops writes first.** Never retry an uncertain payment with a new key, refresh its blockhash or salt, switch RPC provider, clear the journal, or compensate automatically.

## 1. Before the run (owner fills this in)

| Item | Value |
|---|---|
| Scenario (one) | e.g. hold 1 USDC → capture 0.65 → release 0.35 |
| USDC cap for the whole run | |
| Payer SOL cap / merchant SOL cap | see the fee table in [CAPTURE402-DEVNET.md](CAPTURE402-DEVNET.md) |
| Maximum attempts | 1 (UNKNOWN is never repeated) |
| Stop/go owner | |
| Reviewer | |
| Buyer recovery owner (reclaim after `captureDeadline`) | |
| SingIt SHA / Capture402 ABI pin | must match RELEASE-GATE.md |

Checklist:
- [ ] The private env file is outside the checkout, mode 600, and based on `singit-mcp/deploy/hackathon.env.example` with `SINGIT_BACKEND=capture402`, an approved HTTPS devnet RPC, the confirmed program values, keypair paths, payer and merchant public addresses, `SINGIT_STATE_DIR` and both human secrets (16+ chars, all distinct).
- [ ] Payer and merchant are throwaway devnet wallets with Circle devnet USDC, SOL and canonical ATAs (MVP-06).
- [ ] Agent tokens `SINGIT_BUYER_TOKEN` / `SINGIT_MERCHANT_TOKEN` are set for the buyer and merchant agents. Agents never get keypairs, human secrets or RPC credentials.
- [ ] `npm ci` at the repository root; the offline gate passes on this SHA.

## 2. Start

```sh
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

- **Normal stop:** Ctrl-C in the `live:all` terminal, or `kill -TERM <mcp pid>`. Admission closes first, then the locks are released. The journal and evidence stay untouched.
- **Automatic stop:** an UNKNOWN outcome or a failed journal write closes admission by itself. Reads and same-key replays still work.
- Use `kill -9` only for a hung process. Then follow section 6 before restarting.

## 5. When something goes wrong

| Signal | Do | Never |
|---|---|---|
| `OPERATION_UNKNOWN` | Stop the run (admission is already closed). Note the `operationId`. Observe it with `get_operation`, or by retrying the **same** key, which only observes. After a stop, restart only when the original transaction has finalized: startup reconciles it read-only. | new key, new salt or blockhash, other RPC provider, manual void/refund to "fix" it |
| `STORAGE_FAILURE` | Stop. Fix the disk (space, permissions). Copy `state.jsonl` aside unchanged, then restart. Startup reconciles anything that was in flight. | edit, truncate or clear the journal |
| `STARTUP_RECONCILIATION_REQUIRED` | Wait for the original signatures to finalize, then restart. Inspect the private journal only locally. | delete the journal, change `SINGIT_STATE_DIR` or wallets to get past it |
| `ACTION_DISABLED` on a dispute | Merchant releases or captures what is still held first; then the human resolves with a single refund | |
| Quarantined hold (wrong terms) | Funds stay committed; use buyer recovery (section 7) | automatic or ad-hoc release |

## 6. Stale locks after a crash

The lock files hold the PID of their owner: `.singit-mcp.lock` in `SINGIT_STATE_DIR`, and `<hash>.lock` in `SINGIT_NAMESPACE_LOCK_DIR` (default `~/.singit-mcp/locks`).
1. Read the PID from the file and confirm the process no longer exists (`ps -p <pid>`).
2. Only then remove that lock file. Locks are never removed by age.
3. Never run two runtimes for the same wallets, even on different hosts: the lock covers one host only.

## 7. Buyer recovery after `captureDeadline`

- Expiry alone returns nothing.
- What is still held can be returned only by the payer's on-chain `reclaim`, at or after `captureDeadline`, signed by the payer key with SOL for the fee.
- `reclaim` is not an MCP tool. It is a separately authorized operator action; no accepted route exists on this SHA (see RELEASE-GATE.md).
- Already captured funds are not affected. A refund of captured funds is merchant-funded and never guaranteed.

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
