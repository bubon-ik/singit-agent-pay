# Bounded Bedrock Converse buyer

This copy is adapted from Capture402 PR #10 at
`a570ddee8063b2d560b7177195670b74d21c2884`. It runs from `singit-agent-pay` using
the payment service in this same checkout. Upstream real-model evidence does
not establish acceptance of this port. See [README.md](README.md) for installation
and the repository-root `bedrock:mock`, `bedrock:buyer` and `test:bedrock` commands.

This isolated example adds an opt-in AWS SDK v3 `ConverseCommand` loop over the
existing buyer MCP. The normal entrypoints remain `buyer.mjs`, `codex-buyer.mjs`
and the Codex default of `mock-llm.mjs`. No payment service, ABI, MCP version,
journal or installed runtime changes are required.

Implementation and offline tests do not establish real Bedrock acceptance.
Every command below that contacts AWS needs separate operator authorization.
No RPC, signing, funding, deployment, hosted Actions or publication is authorized
by this document. An accepted historical Codex devnet run is not Bedrock evidence.

## Offline development

Use Node >=22. New direct dependencies are pinned to
`@aws-sdk/client-bedrock-runtime@3.1153.0` and
`@aws-sdk/credential-providers@3.1153.0`, both requiring Node >=20. The example
lockfile pins their transitive graph; the MCP SDK remains `1.32.1`.

From this example directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node --test test/bedrock.test.mjs test/codex-boundary.test.mjs test/profile.test.mjs
npm test
```

The first test command needs no AWS credentials, network or Codex login. It
injects Converse responses; the SDK retry test uses synthetic credentials and
an injected HTTP handler without connecting to AWS.

By default, `npm test` uses the payment service in this repository. It runs the
unmodified authenticated mock entrypoint bound to `127.0.0.1`, actual buyer and
merchant stdio MCP, and actual Streamable HTTP MCP. `bedrock-transport.test.mjs`
adds happy-path and post-capture AWS/MCP/storage-failure scenarios. All seven
transport tests run against this checkout by default; `SINGIT_CHECKOUT` can
explicitly select another installed checkout for compatibility checks.
A sandbox `listen EPERM` is an environment refusal,
not a passing test. `node mock-llm.mjs` runs a real Codex model and is not an
offline verification command.

## Trusted boundaries and evidence

The model can request only `quote_report({})`, `hold_report({})`,
`purchase_report({})`, `get_report({})`, once each in that order. The runner
discovers and validates all four empty MCP schemas. It sends locally owned
descriptions, validates the entire response before executing anything, rejects
multiple tool uses, and never substitutes scripted calls for missing model calls.
Only a valid `tool_use` stop reason permits an MCP invocation. Truncation,
refusal, unknown content/stop reasons, early final answers, MCP `isError` or
semantic `ok:false` stop the run. A valid final `end_turn` needs all four calls,
the actual artifact bytes and digest, matching retrieval, profile and JSON answer.

For rejected tool fields, the private `response_invalid` event also records a
structural diagnostic: fixed own-field flags, value-kind labels, a fixed type
classification and an unknown-field count. It never records unknown field names
or raw values, and it does not permit any extra field. This distinguishes a
provider-format incompatibility from speculation without exposing rejected data.
An ordinary client call may omit `toolUse.type` or use exactly `"tool_use"`, as
observed from Converse. The marker is preserved in the assistant message and
grants no authority. Every other explicit type, including `server_tool_use` and
`mcp_tool_use`, and every unknown field refuses before any MCP invocation.
The pinned SDK and API-reference enum currently list only `server_tool_use`;
the narrow client-marker compatibility rule is covered by real SDK decoder and
transport regressions rather than treating arbitrary enum values as supported.

Assistant messages are preserved, including their `toolUse`, and followed by a
user message containing the matching `toolResult.toolUseId`. The AWS `toolUseId`
contract is `[A-Za-z0-9_.:-]{1,64}`. These IDs serve only as protocol correlation
and never become payment keys. Existing `BuyerSession`, merchant and SingIt own
the immutable intent, human mandate, roles, amounts, stable keys and state.

Only the final inference, after all four tools have completed, requests Converse
structured output through `outputConfig.textFormat`. Its JSON schema permits
exactly `summary`, `artifactSha256` and `profile`, with the verified digest and
profile fixed by single-value enums. The schema is serialized as a string in
`structure.jsonSchema.schema`. Tool-selection requests do not carry this format.
Local validation still requires strict JSON, all three exact fields, an 80–8192
character summary, and the verified digest/profile. Markdown fences, prose,
missing or extra fields and mismatched values refuse; the runner does not strip
or repair them. A private `report_invalid` event records only a fixed reason
(`json_parse`, `answer_shape`, `summary_shape`, `artifact_digest` or
`profile_mismatch`), without the rejected text or values.

AWS structured output supports a subset of JSON Schema; string `minLength` and
`maxLength` are enforced locally rather than sent as unsupported schema keywords.
First use of a schema may require compilation that exceeds the existing
30-second request timeout. Such a timeout remains a stopped model response, with
available usage retained; there is no automatic timeout increase or retry.

The SDK resolves the explicit profile locally through the selected
`credentialProvider`: `sso` uses `fromSSO`, while `console-login` uses
`fromLoginCredentials` for an `aws login` profile with `login_session`.
Omitting the setting preserves the existing `sso` default. The runner never
automatically changes credential providers or falls back to a default credential
chain. A profile/provider mismatch is not evidence of an expired session.
The application does not extract or log AWS credentials. It refuses inherited
`AWS_*` settings except matching `AWS_PROFILE`, `AWS_REGION` and
`AWS_DEFAULT_REGION`. Remove conflicting
access keys, session/bearer tokens, credential file overrides, retry settings and
endpoint overrides from the launch environment; do not print their values.
SSO client endpoint overrides are disabled. The effective Bedrock HTTPS hostname
must match the operator-selected region before an inference request can reach
the HTTP handler. Production offers no custom endpoint option; tests inject SDK
senders/handlers instead. SSO's region comes from the SSO profile and can differ
from the Bedrock region.

Child processes receive allowlisted environment variables. The buyer gets a
fresh private HOME; the merchant gets only its own role token. The MCP SDK's
standard inherited environment is accounted for by explicit HOME/PATH overrides.
No AWS keys, human route secret, `NODE_OPTIONS` or raw parent environment is
passed to a tool. This is not OS isolation or independent wallet custody: code
running as the same OS user can still access files available to that user.

Only verified result projections enter Converse: report terms, stage, amounts,
artifact bytes/digest and the mock profile name. Full operational receipts,
identities, payment IDs, private paths and raw errors are excluded. Original
business receipts remain in the existing private stores. Treat report text and
tool descriptions as untrusted data. The report price of 0.65 mock USDC is not
Bedrock cost; expense amounts use caller-supplied integer units.

Private configurations must be regular owner-only files outside Git, with no
symlink or hardlink. Use 0600 files and 0700 directories. Evidence and admission
parents must already be private, canonical absolute directories; avoid symlink
aliases such as a platform's `/tmp` alias. Evidence directories are created
exclusively. Old runs are never overwritten, reused or deleted by the runner.
Evidence append/fsync and file/directory identity checks fail closed.
The new evidence directory is fsynced into its checked parent before SDK or
buyer MCP startup. A failed parent fsync stops admission and preserves the new
directory for diagnosis; it does not delete or reuse that directory.
The Bedrock harness uses the same check for its new run root before starting
the disposable mock or issuing its synthetic mandate.

`model-tool-trace.jsonl` records provider/model/region, inference mode (`aws` or
`injected`), request attempts, safe request context, AWS request IDs and usage
when available, stop reasons, actual tool requests/results and artifact digest.
Allowlisted response metadata is saved before assistant-content validation, so
malformed/truncated responses and an unexpected SDK retry count retain available
usage/request IDs without retaining their raw content. A sanitized
`response_invalid` event records a fixed diagnostic reason enum without raw
unvalidated responses, tool arguments or model text. Missing usage is `null`,
not proof of zero cost. `answer.json` contains structurally validated final JSON;
`status.json` separates response completion, report review and payment observation.
Payment observations are local evidence, not a replacement payment journal.
For a buyer, `modelOutcome=response_complete` and `reportReview=pending` mean the
four tool steps, JSON shape, profile and digest were checked. Free-form summary
claims still require the separate report-review gate below. The fixed-string
protocol smoke can record `modelOutcome=complete`; it has no expense analysis.

A successful capture followed by a model error leaves `paymentObservation`
`succeeded` and `modelOutcome` `incomplete`. A lost MCP response can leave the
runner's observation `unverified` while the existing stores retain a completed
original. Neither case permits another purchase. Failed post-call evidence
writes preserve known payment observations and original stores. Inspect those
originals through the existing recovery procedures; do not infer or resend.

## Limits and one-run admission

Settings require an explicit operator profile, region and model/inference-profile
ID. The optional `credentialProvider` setting accepts only `sso` or
`console-login`, defaults to `sso`, and must match the profile's authentication
type. Existing settings without this field keep the SSO path. The operator's
private buyer configuration selects `PAYMENT_PROFILE=mock` or an explicitly
validated `devnet` profile; the model cannot select or change it. Default ceilings are
8 Converse attempts per run, 1024 output tokens per call, 65536 serialized request
body bytes, 30 seconds per Converse call, 180 seconds per MCP phase and 240 seconds
per run. Operators can lower these limits, not raise them in configuration.
Both the request object and actual SDK serialized body are bounded. SDK
`maxAttempts=1` disables inference retries; there is no provider fallback.

An append-only inference admission file binds profile/region/model and a deadline
(at most 24 hours ahead) to 12 total attempts, including smoke and failed/no-response
attempts. A lock permits one active process. Attempts are durably reserved before
SDK dispatch and may conservatively include an attempt that never reached AWS.
The file permits one buyer-run; starting a new subprocess does not reset it.
The buyer refuses before MCP startup unless its entire configured call allowance
still fits inside the shared budget.
Any run failure poisons that admission, and an existing or partial file is never
reinitialized or repaired. This counter is not an economic journal or a dollar
ceiling. A timeout does not prove no AWS charge or no MCP side effect.

A stopped admission remains immutable: no automatic resume, reinitialization or
state reset is permitted. An explicit owner-authorized repair may use an
independently reviewed private successor carryover script only when no buyer has
previously started. Preserve the original admission, traces and all state. The
script must create an exclusive, durable one-successor claim at a fixed path
relative to the predecessor, then seed every prior reserved attempt into the
successor under its admission lock before any SDK startup. The carried attempts
consume the same cumulative 12-attempt ceiling; the successor is not a fresh
budget or permission for another buyer. Preserve the original deadline, or
record an explicitly authorized deadline renewal in the private disposition.

Native admission checks enforce each file separately; they do not enforce
cross-file ancestry or prevent forks between successor files. The reviewed
private carryover procedure and independent validation must enforce the single
successor, bind predecessor/successor and source hashes, and verify the cumulative
attempt count before execution. An existing claim or evidence of an interrupted
carryover preparation stops this procedure without automatic repair, deletion
or another successor.

## Authentication preparation and separately authorized smoke

These are future operator steps, not part of offline testing. First obtain an
exact-candidate source review and explicit authorization for the named account,
profile/region/model, evidence location, one mock purchase and at most 12 Converse
attempts including smoke. Console-login or SSO/MFA is performed by the owner
locally. Do not transfer login/SSO caches or session tokens. Account/role
verification stays private. Choose only the authentication procedure matching
the selected credential provider; a failure does not authorize another provider.

For the `hackathon-console` profile configured with `login_session`, explicitly
set `credentialProvider` to `console-login`. The owner's local login command is:

```sh
umask 077
aws login --profile hackathon-console
aws sts get-caller-identity --profile hackathon-console > "$PRIVATE_IDENTITY_FILE"
```

For a separately selected IAM Identity Center profile, retain
`credentialProvider: "sso"` (or omit it) and the existing SSO procedure:

```sh
umask 077
aws sso login --profile "$SSO_PROFILE"
aws sts get-caller-identity --profile "$SSO_PROFILE" > "$PRIVATE_IDENTITY_FILE"
```

Before continuing, verify the account/role locally and check current model access.
A browser-only AWS Console session does not configure this machine's SDK.
Do not use debug logging or paste the identity file into chat. No new IAM users/access keys
or IAM/SCP changes are part of this procedure.

Create a new private parent outside all Git checkouts. Prepare the following JSON
as a mode-600 settings file. Replace the synthetic absolute path and set
`deadlineMs` to an explicit future Unix time in milliseconds, at most 24 hours
ahead (for example, obtain a 30-minute value with
`node -p 'Date.now() + 30 * 60 * 1000'`). Zero below intentionally refuses startup.

```json
{
  "schema": 1,
  "awsProfile": "hackathon-console",
  "credentialProvider": "console-login",
  "region": "eu-central-1",
  "modelId": "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "admissionPath": "/absolute/private/bedrock01/inference-admission.jsonl",
  "deadlineMs": 0,
  "limits": {
    "maxCalls": 8,
    "maxTokens": 1024,
    "maxRequestBytes": 65536,
    "requestTimeoutMs": 30000,
    "mcpTimeoutMs": 180000,
    "runTimeoutMs": 240000
  }
}
```

The model ID is an operator choice, not a fallback or account-access guarantee.
Initialize the admission exactly once (local filesystem only). Then, only under
the inference authorization, run the harmless two-attempt tool-protocol smoke:

```sh
node bedrock-buyer.mjs --init-admission "$PRIVATE_BEDROCK_SETTINGS"
node bedrock-buyer.mjs --smoke "$PRIVATE_BEDROCK_SETTINGS" "$NEW_PRIVATE_SMOKE_DIR"
```

The smoke calls only local `bedrock_ping({})`, with no MCP/payment access, then
requires `BEDROCK_OK`. Both attempts consume the shared 12-attempt allowance.
Do not add uncounted CLI Converse calls. On failure stop and preserve admission
and evidence; do not create another file or purchase to bypass the stop.

## One separately authorized real Bedrock / mock-payment run

Use the same admission file after a successful smoke. The run directory must
not exist, and its parent must be private. From this example directory:

```sh
node mock-bedrock.mjs "$NEW_PRIVATE_RUN_DIR" "$PRIVATE_BEDROCK_SETTINGS"
```

Only the trusted harness creates the synthetic mandate using its human route
secret. It starts a disposable loopback mock, records both source HEADs and
dependency lockfile digests, and gives the model only buyer MCP. It checks:

- Four actual model-requested tool calls, exactly one hold and one capture,
  both successful: hold 1000000, capture 650000, atomic remainder release 350000.
- Held/refunded/unresolved reservations 0, committed 650000, remaining 350000;
  negative budget/role cases add no operations.
- Exact durable artifact bytes/digest: total 2800, compute 1200, data 1600,
  duplicate `invoice-2`, three rows and two unique IDs; duplicates remain in totals.
- Correct final JSON/profile/digest and no role/human credential leak in trace.

The harness retains a private last-observable mock ledger on failure before
stopping that disposable service. A restarted MockBackend is not restored
economic history. Preserve both stores, logs, admission and traces after failure.
Never point a new mock run at an interrupted ledger's state directories.

An independently prepared run can invoke `node bedrock-buyer.mjs "$PRIVATE_RUN_JSON"`.
Its schema-1 config is the existing Codex run-config shape plus a top-level
`bedrock` object containing the settings above. `environment` keeps the same buyer
allowlist; AWS settings and human secrets do not belong there. The operator must
issue the mandate separately; the runner cannot create one.

The harness writes `acceptance.json` only after its transport/accounting/artifact
checks. Injected SDK runs are marked `OFFLINE_TESTED`; the actual AWS path records
`REAL_BEDROCK_MOCK_PENDING_REPORT_REVIEW`. Both have `accepted=false` and
`reportReview=pending`. A digest-valid summary with incorrect totals, duplicate
claims or units remains unreviewed. The harness never automatically records
`REAL_BEDROCK_MOCK_ACCEPTED`. Report `IMPLEMENTED`, `OFFLINE_TESTED` and
`REAL_BEDROCK_NOT_RUN` separately when no authorized AWS run occurred.

### Report-review gate

Review the saved `model/answer.json` against the exact retrieved artifact and
private tool/payment evidence, without another inference or purchase:

- Require total 2800, compute 1200, data 1600, duplicate ID `invoice-2`, three rows
  and two unique IDs. Both duplicate rows remain in the totals.
- Require caller-supplied integer expense units, distinct from the 0.65 mock USDC
  report price and actual Bedrock cost. Reject contradictory or unsupported prose.
- Check the matching artifact digest/profile and the original accounting outcome.
- Inspect actual attempts, available usage and request IDs; unknown usage does
  not establish zero cost. Obtain the operator/reviewer disposition required by
  the specific live authorization.

Preserve the original answer, trace, admission and stores. Record acceptance or
rejection in a new 0600 private disposition file outside Git, binding it to the
answer/trace SHA-256, artifact digest and exact source candidate. Do not rewrite
`status.json` or `acceptance.json`. Only a separately recorded accepted review
and operator disposition can establish `REAL_BEDROCK_MOCK_ACCEPTED`; neither
model text nor a run-config field can grant it. A wrong or pending summary does
not reopen admission or authorize another purchase, new intent or state reset.

If capture and retrieval succeeded but the final response failed, preserve the
original `paymentObservation=succeeded` and `modelOutcome=incomplete`. Explicit
owner authorization may permit a separate report-only finalization using the
saved, validated final-request context and exact original artifact. This is a
new inference with its attempts and usage accounted for; it must have no MCP
connection, tool execution, mandate creation or purchase path. It is not an
automatic retry or a way to restart a stopped buyer. Independently review any
private finalization helper before use. Bind its new answer and trace to the
original tool trace, accounting, artifact bytes and both source candidates, and
record the result as a composite report completion. Leave the original failed
status intact. A useful, valid final answer still needs the same separate
semantic review and operator disposition; no payment uncertainty may be bypassed.

## Devnet is a separate gate

The buyer can use the existing devnet payment path only through an explicit
private configuration. Set `environment.PAYMENT_PROFILE` to `devnet`, supply
`PAYMENT_PROFILE_FILE` as an absolute path to a regular owner-only 0600 file
outside Git, and bind distinct `REPORT_PAYER` and `REPORT_MERCHANT` to that file.
The existing profile validator requires the exact devnet genesis/network, ABI,
mint, token program, deployment identity and role fields. The existing buyer,
merchant, runtime-profile checks and finalized-operation proof validation remain
responsible for payment authority and delivery; Bedrock receives only verified
projections. Invalid or incomplete profiles refuse before model or MCP startup.
This runner selection does not itself authorize a live operation.

Before a live run, obtain separate exact-candidate review and owner authorization
naming existing deployment/source pins, approved RPC, wallets, original journal
continuity, deadlines, USDC/SOL/attempt caps and stop/go roles. Follow SingIt's
`MVP-SCENARIO.md`, `RELEASE-GATE.md` and existing private operational procedures.
Use the independently prepared private buyer configuration with
`node bedrock-buyer.mjs "$PRIVATE_RUN_JSON"`; `mock-llm.mjs --bedrock` continues
to create only a disposable mock backend and cannot launch a devnet service.

Preserve completed mock runs and their terminal capture records. A devnet run is
a separately authorized scenario, never a retry or reset of an earlier mock
purchase. Do not reuse historical Codex authorization, create a new wallet
namespace, reset journals, redeploy, fund or sign merely to make a run pass.
Retain `BEDROCK_DEVNET_NOT_RUN` until actual separately authorized Bedrock devnet
evidence exists and its payment, artifact and report have been reviewed.

## API references

- [Converse API and stop reasons](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html)
- [Converse structured output](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html)
- [Claude structured output support and JSON Schema subset](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-structured-outputs.html)
- [Claude Sonnet 4.5 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4-5.html)
- [Client-side tool use and message correlation](https://docs.aws.amazon.com/bedrock/latest/userguide/tool-use-client-side.html)
- [Tool-use ID contract and optional server-tool type](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolUseBlock.html)
- [AWS SDK v3 Bedrock examples](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_bedrock-runtime_code_examples.html)
- [Explicit SSO credential provider](https://github.com/aws/aws-sdk-js-v3/tree/main/packages/credential-providers#fromsso)
- [Console-login credentials and login_session](https://docs.aws.amazon.com/sdkref/latest/guide/feature-login-credentials.html)
- [Explicit login credential provider](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)
- [Retry attempt semantics](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html)
- [SSO and service regions](https://docs.aws.amazon.com/sdkref/latest/guide/feature-sso-credentials.html)
