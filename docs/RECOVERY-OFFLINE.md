# Offline recovery, merchant refund and payer reclaim scenarios

Preparation for MVP-05 (#13) and MVP-08 (#15), based on journal/runtime PR
[#23 at `643dac3070b97677e24ce7c457ced924f82839e2`](https://github.com/bubon-ik/singit-agent-pay/pull/23).
The companion is `integration/RECOVERY-OFFLINE.md` in the separate public
Capture402 checkout.
These are synthetic local scenarios. `PaymentService({ live: true })` selects
the stricter policy in tests; it still uses MockBackend/FaultyBackend, never RPC.
No new MCP authority, economic instruction or idempotency mechanism is introduced.

## Reproduce locally

Use installed locked dependencies, Node 24 and the pinned Rust/SBF toolchain in
Capture402. Installation, source review and running these tests do not authorize
merge, hosted Actions, installation, deployment or live payments.

From the SingIt checkout:

```sh
npm --prefix singit-mcp run test:recovery:offline
npm run typecheck
npm --prefix singit-mcp run build
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" npm test
npm --prefix demo-dashboard run test:unit
```

The focused command names only local test files. The clean environment on the
full suite prevents an inherited live-test opt-in, keypair path or RPC credential
from enabling its optional devnet cases. Fourteen optional live cases must remain
SKIPPED, not PASS. Tests bind ephemeral loopback ports; a sandbox denial is a
harness failure, not a chain result. No provider change is a remedy.

From the separate public Capture402 checkout:

```sh
cargo-build-sbf --tools-version v1.53 --arch v0 -- --locked --offline
cargo test --locked --offline --test sac001 --test sac002 --test sac003
npm --prefix integration run typecheck
npm --prefix integration run test:recovery:offline
SINGIT_CHECKOUT="$PUBLIC_SINGIT_CHECKOUT" npm --prefix examples/singit-merchant test
python3 -B ops/check_local_paths.py
```

`PUBLIC_SINGIT_CHECKOUT` names this SingIt source checkout. The merchant harness
launches the separate payment service with synthetic credentials and mock policy.
It does not run a real LLM or a live merchant. Build the SBF from the candidate
source before testing; a pre-existing binary hash alone is insufficient.

## Scenario matrix

Amounts are six-decimal synthetic USDC units. Every scenario has its own fixture
and private temporary journal; it is not a proposed sequence of live payments.

| Scenario | Evidence and required outcome | Local coverage |
| --- | --- | --- |
| Normal purchase baseline | One hold of 1,000,000, one capture of 650,000 with atomic 350,000 release; no separate release/refund | `safety.mcp`, merchant compatibility suite |
| Independent agreed refund | Merchant refunds 100,000 after that purchase. H=0, gross captured=650,000, refunded=100,000, F=550,000; committed=650,000 and remaining=350,000. Restart/same-key replay returns the original receipt without another backend call | `recovery.offline` |
| Refund role refusal | Payer and another merchant cannot invoke the refund backend | `recovery.offline`; authenticated role refusals in `principals.mcp`/`safety.mcp` in the full gate |
| Merchant spent its liquidity | A separate synthetic payment consumes the merchant proceeds. Refund fails without changing the original F, service refund accounting or mandate | `recovery.offline`; token CPI rollback also in Capture402 `sac003` |
| Lost refund response | UNKNOWN closes admission. Restart observes only the original operation/signature, commits receipt/history/audit once and never resends | `recovery.offline`, `review-regressions` |
| Missing original history / legacy missing wire | H=0 and expiry are insufficient; the Capture402 adapter reports pending. Original identity/evidence and committed budget remain, no new refund | `recovery.offline` pending adapter boundary; actual RPC/wire mapping in `capture402` |
| Post-refund storage failure | Backend executed once; failed terminal commit closes admission. Fresh reader and original-only reconciliation apply accounting and terminal audit once | `recovery.offline`, `accounting.atomic`, `journal-safety`, `store-io` |
| Wrong terms / H=0 cleanup | Quarantine and reservation remain; no inferred payer repayment or automatic live cleanup | `service.hardening` fix3b, `runtime`, `safety.mcp` |
| Unaccepted multi-step dispute | Held remainder plus requested refund is refused server-side, including after restart. No release/refund child is created | `recovery.offline`, `safety.mcp` |
| Payer recovery | At Dc, reclaim only positive H without merchant/sponsor signatures; captured F unchanged. Wrong payer and insufficient SOL refuse before send. A lost response retains original wire/journal; H=0 is not proof | Capture402 `mvp-recovery-offline`, `reclaim`, `payer-recovery*` |
| Deployment mismatch | Synthetic genesis/loader/program-data/executable/slot/mint mismatch refuses admission; a restored identity cannot reopen the latched runtime | `capture402`, `runtime`; Capture402 `rpc-recovery-identity` |
| Corrupt/replaced journal, audit bundle or shutdown race | Preserve original bytes; incomplete bundles refuse load; writer closes on continuity loss; accepted work drains before custody release | PR #23 `review-regressions`, `journal-safety`, `store-io`, `inspection`, `runtime` |

Mock transaction references and LiteSVM's finalized labels are local adapter
assertions, not observations of a Solana devnet validator. A mock process restart
in these tests retains the same economic fixture; a newly empty MockBackend is
never treated as recovered economic history.

## Operator boundaries carried into the runbook

Recovery is observation of original operations. Keep original operation IDs,
keys, signed wires, pending reservations, journal bytes and wallet namespace.
Read-only reconciliation can append verified local outcomes; it cannot sign/send
or convert missing history into permission for a new attempt. PR #23's compatible
v1 audit backfill is recovered history, not new chain acceptance. Ambiguous v1
records and partial v2 writes require byte-preserving refusal and inspection.

An agreed refund is a separate merchant action before Dr, with its own immutable
intent, amount, stable idempotency key and operation ID. It requires merchant
authority, token liquidity and SOL. Human dispute approval is an application
decision, not a replacement for the stored merchant's on-chain signature. Never
automatically release/capture to make a refused dispute become a single-step
flow. A service dispute is not an on-chain freeze.

Reclaim is a separate payer action at/after Dc, through Capture402's existing
operator route. It requires an independently pinned existing deployment, exact
payment identity, canonical accounts, payer authority/SOL, durable journal and
exclusive operational custody. It returns only current H; it cannot refund F.
The CLI's optional continuation flags and specialised expiry proofs are outside
this MVP procedure. UNKNOWN stops the attempt with no retry or provider switch.

Deployment digest linkage is explicit: Capture402's record hashes only the
source-sized executable slice after the 45-byte ProgramData metadata and checks
the remaining allocation padding is zero. `SINGIT_EXECUTABLE_SHA256` hashes the
entire payload after metadata, including that padding. Record both digests and
sizes and review their byte-level relation; the two digest strings need not be
equal. Neither pin may be replaced with an arbitrary observed account hash.

Capture402 reclaim does not automatically import a release into PaymentService.
Retain local reservations/quarantine until the particular original outcome and
token effects are reviewed. Do not edit the journal or restore mandate budget
from H=0, a CLI exit code, a deadline or an observed payer balance alone.

## Evidence and gate disposition

Keep the acceptance packet private: both source SHAs, clean/dirty status and a
digest of any uncommitted patch, lockfile hashes, toolchain, SBF build/digest,
commands/exit codes/counts/skips, exact-source review and remaining limitations.
Re-run on the final frozen combined revisions after separately authorized
integration/merges; evidence on a PR head or dirty working tree cannot certify
that later source. Historical **263/14/22 PASS** and PR #23's counts are comparison
baselines only.

This preparation grants none of `OFFLINE_READY`, `ONE_RUN_AUTHORIZED` or
`MVP_ACCEPTED`. The first also needs the final source review, merchant devnet
profile and useful real-LLM mock trace. The second needs separate authorization
covering preflight and the exact bounded run. The third follows actual devnet
E2E and explicit operator/reviewer acceptance. No issue closes from these tests.
