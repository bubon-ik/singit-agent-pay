# Journal v2 and offline blocked-state inspection

The v2 reader preserves every original v1 byte. New records append to the same
private `state.jsonl`; no migration rewrites an installed file. A normal startup
may append missing historical audit proofs for compatible v1 atomic outcomes,
without applying any accounting delta or sending a transaction. These rows are
marked `recovered`; they are journal history, not new independent chain acceptance.

## Atomic boundaries

- A hold reservation and pending operation share one record before the first await.
- Every terminal outcome, hold/mandate mutation and `operation_outcome` audit proof
  share one `opcommit` record and fsync. Confirmed failure and reservation release
  use that same boundary. UNKNOWN retains its reservation and original evidence.
- A dispute release/refund commits the affected human decision with its child
  operation. The approved decision metadata is durable before a possible send.
  Reconciliation cannot create another child; unaccepted multi-step live flows
  remain disabled.
- Mandate issuance, dispute opening/linking and non-economic resolution use a
  `statecommit` with their audit row. Normal business-call audit rows remain
  separate from terminal proofs; the dashboard avoids duplicate charge cards.
- Exact duplicate `statecommit` records are ignored as whole atomic units before
  applying snapshots. Reusing an audit identity with different state is corruption.
  Successful resolution children require their hold, original receipt and consistent
  human-decision/dispute state in the same record; incomplete bundles refuse load.

Each writer pins the directory and journal identity, size and modification metadata.
Replacement, truncation, external append/rewrite, links and permission drift refuse
further writes before another economic backend call. These checks bind the open writer to
its retained file; offline parsing alone does not authenticate continuity with a
previous installation or authorize selecting another state directory.

Short writes are completed before fsync. A failed write/fsync poisons the writer
and closes service admission. The same process restores its last successfully
committed read view, including reservations, and cannot replay an uncommitted
success. It refuses further journal writes and unresolved reconciliation until
inspection and restart. A failed append may still have reached disk; only reading
the preserved journal on a fresh startup can establish that record's outcome.
Previously committed terminal outcomes remain readable and replayable without a send.
An interrupted, malformed, unsupported or ambiguous
file is never truncated, skipped, reset, silently treated as empty, or repaired by
startup or inspection. This intentionally replaces the older tail-truncation policy.

## Compatible and refused legacy data

The reader validates v1/v2 record tags, versions and payload shapes. A v1 terminal
success is compatible only when its original atomic op/hold snapshot and receipt
are present and agree. Prepared and terminal signatures must match; successful
hold snapshots must retain that same receipt as their latest history entry.
Historical resolve children without atomic decision state,
non-atomic terminal records and old failed accounting require operator review
(`LEGACY_REVIEW_REQUIRED`). They are not automatically normalized or replayed.
Pending/UNKNOWN records remain unresolved until their original outcome is proven;
missing original signed evidence never becomes permission to send again.

Keep a private byte-for-byte backup before any separately authorized installed
upgrade. Do not run an old reader on a v2 journal: historical binaries did not
enforce version rejection and cannot enforce the new atomic boundaries. Code
rollback cannot undo chain state. Ambiguous legacy reconciliation/migration needs
an explicit reviewed disposition preserving the original. There is no automatic
conversion or financial repair command.

### Explicit disposition of a fully reviewed v1 history

`review:legacy` is a separate offline operator tool. It supports only a complete
v1 history of standalone records whose operations are all terminal. It rejects
pending/UNKNOWN, partial/corrupt files, mixed-format histories, open disputes,
missing originals, inconsistent receipts/accounting and already reviewed files.
It imports no runtime, RPC client, signer or key loader. It verifies the retained
signed wires and their actual program, signer, canonical ATAs and immutable terms;
it cannot establish chain finality without independently reviewed external evidence.

A private mode-600 review JSON names distinct operator/reviewer identities and
binds the exact original UTF-8 prefix SHA256/byte count, parsed snapshot digest,
program/genesis/payer/merchant namespace and private evidence digest. Its per-op
`finalized_success` dispositions include the original signature, finalized/err=null
attestation, evidence digest and historical receipt snapshot already present at
that terminal record in the original file. Those receipts must reproduce the
whole retained hold history. A `retained_failure` preserves the original failed
hold and its committed reservation; it proves neither no-send nor permission to
repeat or free that budget. Review is not an account snapshot or an H=0 inference.

Construct and independently review this packet privately; never derive an
approval from the tool's exit status. A separately authorized live preflight must
check the particular originals and namespace before any installed application.
Explicitly stop/exclude an older runtime that predates custody locks. Retain a
byte-for-byte backup and the old process/configuration identity. Then:

```sh
npm run review:legacy -- --check --state-dir /private/state --review /private/review.json
# Only after the separate installed disposition authorization and exclusive custody:
npm run review:legacy -- --apply --state-dir /private/state --review /private/review.json
```

Check mode changes no bytes or locks. Apply mode acquires the same state and
host-wide namespace locks as the runtime (`SINGIT_NAMESPACE_LOCK_DIR`, or the
normal home-directory default), validates again and appends one fsynced v2
`legacyreview` record to the original file. It accepts no accounting override,
never edits/truncates the prefix and never sends or signs. A partial append remains
blocked for inspection, without automatic truncation or another apply attempt.
The reader supplies immutable original receipt projections from the reviewed
history; all final holds, mandates, disputes, keys and failed reservations remain
unchanged. Later startup must match the retained review's program/genesis/payer/
merchant namespace before backend construction or audit backfill. Later startup audit backfills are labeled recovered history, not new
execution or fresh chain proof. Old v1 additions, another review record or changed
terminal originals after this boundary refuse load. Never start an older reader
on the resulting file. The review tool is not exposed through MCP or HTTP.

## Inspection when startup refuses

With the existing dependencies installed:

```sh
npm run inspect:state -- --state-dir /absolute/private/state-directory
```

This command imports no service runtime, backend, signer or RPC configuration. It
opens the existing regular private journal read-only, rejects links/permissive
paths, and never creates a state directory, lock or journal or changes permissions.
It checks file identity/change and reports a digest, integrity code and aggregate
counts only. It never prints wallet identities, original wires, salts, keys,
idempotency parameters, notes or raw parser errors.

`ready` is always `false`: inspection grants no economic authority. `complete`
means the whole file was parsed, not that live transactions were accepted.
For a refused file, counts are only a valid prefix (or the parsed ambiguous legacy
snapshot); do not treat missing rows as absent obligations. A changing/oversized
file or an unreadable path gives no trusted snapshot. Exit 0 means complete
offline parsing; exit 2 means refusal. No live environment variables are required.

After a refusal, preserve journal, original evidence, reservations and namespace.
Do not remove a lock while its owner is running, choose a new store/wallet to
escape history, or append records manually. Inspection is not a repair tool.

## Runtime identity failure

The Capture402 backend continues checking genesis, deployment and mint on reads
and before sends. A verified mismatch latches both backend and runtime admission
closed. Restoring the observed bytes does not reopen that process; operator review
and a fresh startup are required. Transient RPC errors are not deployment proof
and do not authorize retries or provider changes. A queued write rechecks admission
before invoking its backend. Startup also checks admission after best-effort
reconciliation, so a swallowed storage failure cannot expose economic tools.

Shutdown refuses new mutating calls immediately and retains both custody locks
until accepted calls finish their backend work, local commits and audit records.
An idle shutdown releases synchronously. A process killed with active work leaves
its locks for operator inspection. The closed service cannot append later transport
refusal/reset records after custody is released. Original signatures recovered by
reconciliation are included once in both the operation receipt and hold history.

Offline fault suites cover these source boundaries. Installed upgrades, filesystem
failure acceptance on a target host, cross-host custody, real LLM and live economic
acceptance remain separate. See [MVP-SCENARIO.md](MVP-SCENARIO.md).
