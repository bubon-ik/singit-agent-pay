# MVP release gate and Go/No-Go (MVP-08, #15)

Status as of 20 October 2026. This file records offline evidence only. A skipped or unrun test is not a PASS, and offline tests are not live economic acceptance.

The current offline candidate is recorded below; the older tables retain their
original historical SHA and results. The ordered acceptance sequence is
[MVP-SCENARIO.md](MVP-SCENARIO.md). Journal v2 preserves refused bytes and supports
only an explicitly reviewed, separately authorized legacy disposition; see
[JOURNAL.md](JOURNAL.md). Source acceptance never authorizes installed changes or
payments and does not close the real-agent devnet E2E gate.

## Current preparation and ordered decisions

Application source `2bca0bb28477659420b690b7ffccf589c6f4696c` includes the merged
journal/runtime, recovery scenarios and verified merchant-profile changes plus
the explicit offline legacy-disposition tool. The companion Capture402 source is
`208de48733d6a687c77359d4e7c0b0a615666374` (merchant, real CLI buyer and recovery
scenarios); its ABI pin remains `236b09a44240d285ee6f33d2e8dac79f81058e3d`.
Documentation/command-alias followups do not replace the private final merge-SHA,
tree and lockfile record. The merchant still defaults to mock. Automatic live
cleanup and multi-step disputes remain disabled.

Fresh offline checks on this application pair:

| Check | Result and environment |
| --- | --- |
| SingIt typecheck/build | PASS; Node 24.20.0, npm 11.19.0, macOS arm64 |
| MCP/backend/transport | 367 PASS, 14 live opt-in SKIPPED, 29 files; includes 20 legacy-disposition cases |
| Dashboard | 4 E2E and 11 unit PASS |
| Companion merchant | 43 PASS against this SingIt application source, authenticated HTTP and stdio |
| Capture402 local | 60 Rust and 1,860 integration PASS; 95 platform/opt-in SKIPPED; typecheck, wallet build and clippy PASS |
| Operator checks | 312 tests successful locally with 29 platform skips; all 312 successful in the Linux root/boot gate |
| Linux exact-source gate | [Components run 39344787816](https://github.com/starPaw/capture402-solana/actions/runs/39344787816), Capture402 SHA above: PASS; 1,954 integration PASS/1 root-only SKIPPED, separate root custody suite 31 PASS |
| SBF | Fresh empty-target macOS build matches the retained source artifact; Linux built/tested its own artifact. Both digests and toolchains are retained separately; cross-host binary reproducibility is not claimed |
| Real model mock | Four actual Codex CLI MCP calls, useful purchased report and exact artifact digest; budget/role refusals add zero operations. Trace/usage and credentials remain private |
| Independent source review | Agent review of the exact application revisions; original receipts, wire/action/amount/guard binding, namespace enforcement and byte preservation checked. This is not independent human security expertise |

All five dependency lockfiles retain their recorded digests. Rust is 1.90.0;
cargo-build-sbf is 2.2.14 with platform-tools v1.53 and architecture v0. Complete
commands, original test logs, the final source/tree identity, reviews, lockfiles,
source/deployed byte linkage and model trace belong in the private acceptance
packet. The recovery/refund scope and limitations are [RECOVERY-OFFLINE.md](RECOVERY-OFFLINE.md).

| Decision | Evidence required | Current disposition |
| --- | --- | --- |
| `OFFLINE_READY` | Exact final combined source review, lockfiles/toolchain, backend/transport/dashboard/merchant/fault checks, accepted refund/reclaim scope, useful real-LLM mock trace and reviewed devnet profile | Application checks/review complete as above. Final merged tree and documentation followup must match the private freeze record before promotion |
| `ONE_RUN_AUTHORIZED` | `OFFLINE_READY`, private existing-deployment/RPC/wallet/journal binding, named operator/reviewer/stop-go owner, deadlines and USDC/SOL/attempt caps, separate owner authorization explicitly covering read-only preflight and one run | NOT AUTHORIZED. This decision permits only the named experiment; it does not claim the experiment succeeded |
| `MVP_ACCEPTED` | The authorized real-LLM → merchant → MCP → devnet E2E, both original finalized outcomes with err=null, token/accounting effects, durable artifact digest, no pending/UNKNOWN, explicit operator and reviewer acceptance | NOT ACCEPTED; follows E2E |

The E2E result is required for final acceptance, not for permission to attempt the
single test that produces it. Merge authorization, operational authorization and
MVP acceptance are separate records. No merge, live preflight, deployment, funding
or hosted Actions is authorized by preparing this gate. Unfilled roles or a missing
required gate preserve refusal of live writes.

## Historical evidence only

The following tables describe their original revisions, including gaps that PR
#23 now addresses in source. They must not be read as current acceptance or as a
request to restore older tail repair. The separately reported **263/14/22 PASS**
and PR #23 test counts are also historical baselines; final SHAs require their own
results, skips and exact-head review. Keep operational acceptance packets private.

### Historical pinned candidate

| Item | Value |
|---|---|
| SingIt source | `main` at `1c4a45e840c7e16445b89594d4a5de7e6b2d7201` (PR #19 merged) |
| Capture402 ABI/source pin | `236b09a44240d285ee6f33d2e8dac79f81058e3d` (`CAPTURE402_ABI_COMMIT`) |
| Root `package-lock.json` | sha256 `8d9bf4aca75a9c74b1d89de6faf3a59dec42426f64e12e383bc67563d72f7ca2` |
| `singit-mcp/package-lock.json` | sha256 `a389e091c07f8a1f1019b69f091186519d71239427cdb86e260930f04ccf2fee` |
| Toolchain of this run | Node.js 24.12.0, npm 11.6.2, macOS arm64 |
| Environment profile | offline: MockBackend and FaultyBackend fixtures; no RPC, keys or chain transactions |

Re-run this gate on whatever revision is finally frozen. These results apply only to the SHA above.

### Historical offline gate results

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm --prefix singit-mcp run typecheck` | PASS |
| Build | `tsc -p singit-mcp` | PASS |
| MCP, backend and transport suites | `npm --prefix singit-mcp test` | PASS: 261 passed, 23 files |
| Devnet backend contract suite | `test/backend-contract.capture402.test.ts` (13 tests) | NOT RUN (skipped: needs devnet env, keys and RPC) |
| MCP E2E with Capture402Backend | `test/e2e.mcp.mock.test.ts`, devnet case | NOT RUN (skipped, same reason) |
| Dashboard suites | `npm --prefix demo-dashboard test` | PASS: 14 passed |
| CI | none configured for this repository | NOT AVAILABLE; this gate was run locally |

### Historical fault matrix

Coverage is PASS only where a named test exercises the case on the pinned SHA. The test files are in `singit-mcp/test/`.

| Risk (from #15) | Covered by | Status |
|---|---|---|
| Concurrent requests | `safety.mcp`: concurrent identical requests send once; `service.hardening`: C) concurrent holds sequential, h) concurrent capture + release | PASS |
| Lost HTTP response | `safety.mcp`: hold retried on an independent connection = one operation, one send; capture/release/refund replay after the state changed | PASS |
| Persistent crash boundaries | `accounting.atomic`: capture/refund/release crash between backend success and local commit, store failure before send; `runtime`: restored holds converge, unresolved outcomes stop startup | PASS for these boundaries. Crash between terminal outcome and audit: NOT COVERED |
| Disk, write or fsync failure | `safety.mcp`: durable-write failure closes admission before any send; `accounting.atomic`: pre-send store failure; `capture402`: failure to persist finalized observation keeps the latch | PASS (simulated write errors). Real fsync/ENOSPC on a host: NOT RUN |
| Journal corruption | `store`: truncated last line repaired, interior corruption throws (startup refuses, no empty store) | PASS. Blocked read-only safe mode: NOT IMPLEMENTED |
| Original finalized error | `capture402`: only finalized err is confirmed failure, finalized failure clears the latch, reported without resending | PASS |
| Missing history after expiry | `capture402`: missing history stays unresolved even after expiry; expiry and account absence do not erase UNKNOWN | PASS |
| Legacy record without wire | `capture402`: legacy service query without original wire stays pending after restart | PASS |
| Second process | `runtime`: state directory locked; MVP-04 second runtime on the same wallets refuses with another state directory | PASS on one host. Cross-host: NOT COVERED |
| Invalid deployment | `capture402`: invalid deployment (executable, owner, digest, slot, pointer); `runtime`: failed preflight prevents readiness | PASS at startup. Deployment change while running: NOT COVERED |
| Untrusted principals | `principals.mcp`: unauthenticated rejected, no agent mandate issuance, actor substitution and foreign ids refused with 0 sends, no MCP route to human authority | PASS |
| Signed-wire redaction | `capture402`: HTTP state hides the signed wire; `public-state` tests; `safety.mcp`: `get_operation` returns no evidence, salt or wire | PASS |
| Duplicate economic operation | `safety.mcp` replay tests; `runtime`: no second send after restart | PASS |
| Duplicate local accounting | `accounting.atomic`: reconcile x2 applies exactly once | PASS |
| Duplicate artifact delivery | merchant example in starPaw/capture402-solana#7 (separate repo, mock only, older SingIt baseline) | NOT ACCEPTED on this SHA |
| H=0 misread as repayment | `service.hardening`: fix3b | PASS |
| Live dispute and cleanup gating | `safety.mcp`: two-step dispute refund refused; `runtime`: no automatic cleanup in live mode | PASS |

### Historical dependency status

| Issue | State on this SHA |
|---|---|
| #9 MVP-01 trusted principals | Implemented (PR #17). Dashboard bridge per-role tokens and audited `PRINCIPAL_FORBIDDEN` added after this SHA (re-run the gate on the final SHA) |
| #10 MVP-02 idempotency | Implemented (PR #19); offline evidence above |
| #11 MVP-03 atomic accounting | Partial (PR #18, PR #19). Open: audit-crash recovery, legacy JSONL migration, blocked safe mode for corruption |
| #12 MVP-04 custody and readiness | Implemented on one host (PR #19). Open: cross-host custody, admission close on a deployment change, read-only inspection when startup refuses |
| #13 MVP-05 cleanup and recovery | Implemented server-side gating (PR #19). Open: accepted buyer reclaim route (documented only) |
| MVP-06 deployment and environment | Verified by the Capture402 side (starPaw/capture402-solana#6); evidence private |
| #14 MVP-07 real-agent devnet E2E | NOT RUN. The merchant example must be adapted to PR #17 and #19 (tokens, `/human/mandate`, `idempotencyKey`) |

### Historical demo disposition

| Decision | Verdict | Reason |
|---|---|---|
| Live devnet economic MVP | **NOT ACCEPTED** | P0 #14 has no accepted real-agent devnet E2E; permission for one test is a separate decision in the current table above |
| Contest demo on the mock backend | **GO**, labeled "MOCK" | All offline gates above pass on the pinned SHA |
| Historical devnet results | May be shown, labeled "historical" | They ran on older revisions (see #14), not on this SHA |

For the next candidate, first freeze/review the combined exact revisions and
complete `OFFLINE_READY`. Then record the private run fields in
[RUNBOOK.md](RUNBOOK.md) and obtain `ONE_RUN_AUTHORIZED`. Only after the bounded
E2E (#14) may operator and reviewer record `MVP_ACCEPTED`. UNKNOWN stops the run;
it never authorizes a repeat. Empty signature rows below grant no gate.

Limits in every case: experimental devnet only. This is not production software and has not been audited.

| Role | Name | Decision | Date |
|---|---|---|---|
| Operator | | | |
| Reviewer | | | |
