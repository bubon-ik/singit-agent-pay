# SingIt Amazon Bedrock buyer and merchant example

Adapted from [Capture402 PR #10](https://github.com/starPaw/capture402-solana/pull/10),
source revision `a570ddee8063b2d560b7177195670b74d21c2884`, including the existing
buyer/merchant adapters and regression suite. See the repository NOTICE.
The buyer and merchant source is confined to this folder and uses this
SingIt checkout. Auth, mandate authority and economic idempotency remain in the
existing payment service. No operator installation is modified by these examples.

The merchant sells an expense-quality report: exact integer totals by category,
duplicate invoice IDs, an input digest and the purchased artifact digest. Amounts
are caller-supplied integer units, not assumed to be USDC. Duplicate rows remain
in the totals and are explicitly flagged. The bundled input is synthetic.

The buyer talks to a separate merchant process over MCP stdio. Both use SingIt's
actual streamable HTTP MCP surface for payment operations. A human/operator
creates the mandate beforehand through `POST /human/mandate`. The buyer never
creates or expands a mandate. Payment clients send separate buyer and merchant
bearer tokens; the merchant alone calls capture using its authenticated role.

The quote authorizes a maximum of **1 mock USDC**. The merchant captures **0.65**
with `releaseRemainder: true`, releasing **0.35 in the same instruction**. A
separate refund/dispute flow is deliberately outside this example. Purchased
bytes are persisted before capture and delivered only after a known successful
outcome and durable completion. Identical completed requests replay those bytes.

## Bedrock quickstart

From the repository root, with Node.js 22 or later and the payment service's
dependencies installed through the normal root `npm ci`:

```sh
npm run bedrock:install
npm run test:bedrock
```

All transport tests use this checkout by default, injected model responses and
disposable authenticated mock payments. No AWS credentials or wallets are needed.
AWS dependencies stay in this example's lockfile, outside the payment server.
For a separately authorized real model run, follow [BEDROCK.md](BEDROCK.md) to
prepare private settings and admission, then use a new private run directory:

```sh
npm run bedrock:mock -- "$NEW_PRIVATE_RUN_DIR" "$PRIVATE_BEDROCK_SETTINGS"
```

This launcher selects Bedrock explicitly and starts this checkout's disposable
mock payment service. Real inference can incur AWS charges. The port's local
checks and upstream real-model evidence do not establish new devnet acceptance.
`source-baseline.json` records the local harness and payment-service revisions
as `harness` and `singit`; it does not label this checkout as Capture402 source.

## Current boundary

**Mock remains the normal development profile.** The separate `devnet` opt-in
requires an independently pinned private identity file and the matching SingIt
runtime profile. A missing profile, another deployment/network/mint or different
payer/merchant refuses before a payment call. The profile is rechecked before
each payment-service tool call. Complete the source, custody, recovery and
operational gates in the SingIt release gate before any live startup.
Every `hold`, `capture` and `release` call requires a stable `idempotencyKey`.
The purchase uses `report:<orderId>:hold` and `report:<orderId>:capture`; the
atomic remainder release belongs to that capture intent. Upstream deduplication
does not enable automatic retries: interrupted local attempts still block new
purchases and retain their original state.

The deterministic buyer remains available. `buyer-mcp.mjs` exposes four
argument-free steps to a real LLM: quote, hold, purchase and retrieval.
`codex-buyer.mjs` runs the authenticated Codex CLI with those tools, a read-only
sandbox and disabled shell, apps, plugins, browser and memory. The trusted adapter
holds the immutable intent/mandate/roles/input/deadlines and supplies stable keys;
the model cannot select them or issue a mandate. The separate merchant process
receives only its merchant token. Wallet keys, RPC credentials and human secrets
stay in the separate operator/payment runtime. CLI authentication stays with the
CLI; no OpenAI API key is passed to a buyer or merchant tool.

A real model mock run is still mock evidence. Devnet acceptance requires the
separately authorized bounded run, original finalized outcomes, token effects,
durable artifact digest and explicit operator/reviewer acceptance.

## Local use

Use Node.js 22 or later and install the locked dependencies here with `npm ci`.
Start an explicitly mock SingIt HTTP entrypoint separately. It must bind to
`127.0.0.1`, use `SINGIT_BACKEND=mock`, and configure distinct
`SINGIT_BUYER_TOKEN`, `SINGIT_MERCHANT_TOKEN` and `SINGIT_HUMAN_ROUTE_SECRET`.
Set its `SINGIT_PAYER_ADDRESS=buyer-agent` and
`SINGIT_MERCHANT_ADDRESS=seller-agent` to match the synthetic roles below.
Load token values from private local configuration; never include them in tool
arguments, source, logs or URLs. Set the following buyer variables locally:

```sh
export PAYMENT_PROFILE=mock
export PAYMENT_MCP_URL=http://127.0.0.1:8787/mcp
export REPORT_PAYER=buyer-agent
export REPORT_MERCHANT=seller-agent
export MERCHANT_STATE_DIR="$PRIVATE_TEST_ROOT/merchant"
export BUYER_STATE_DIR="$PRIVATE_TEST_ROOT/buyer"
# Load SINGIT_BUYER_TOKEN and SINGIT_MERCHANT_TOKEN from private configuration.
node buyer.mjs sample.json "$HUMAN_ISSUED_MANDATE_ID" synthetic-report-intent-0001
```

`PRIVATE_TEST_ROOT` must be a private, dedicated absolute directory outside every
Git checkout. The buyer's stdio child receives its merchant token, the mock
endpoint, role names and merchant state path; buyer and human credentials are
excluded. The local launcher holds both agent tokens so it can start that child;
this is not independent wallet custody. An MCP client can also start
`node merchant.mjs` with only `SINGIT_MERCHANT_TOKEN` and the common mock settings,
then use `quote_report`, `purchase_report` and read-only `get_report`.

Before starting the buyer, the human/operator issues one mandate in a separate
session through `POST http://127.0.0.1:8787/human/mandate`. Send
`content-type: application/json` and `x-singit-human-secret` from the private
operator configuration. The JSON body contains `payer: "buyer-agent"`,
`totalBudget: "1000000"`, `perTxCap: "1000000"`, a future Unix-seconds
`expiresAt`, and `allowedCounterparties: ["seller-agent"]`. Use the returned
`mandate.id` as `HUMAN_ISSUED_MANDATE_ID`. Issue once; after a lost response,
observe the original mandate instead of issuing another. Authenticated agents
cannot use MCP `create_mandate`, and an agent token cannot authorize the human
HTTP route. Keep `SINGIT_HUMAN_ROUTE_SECRET` outside the buyer environment.

Keep the original intent and both stores after failure. There is no automatic
resume, retry, compensation, state reset or provider fallback. Read `get_report`
to observe delivery. A known completed buyer record can be replayed without any
payment call. An unresolved operation blocks new purchases even after restart.
Locks are never removed because of their age; establish that the owner process
has stopped before any manual lock repair. The application lock is not a global
wallet-custody solution; that remains MVP-04. Mock payment state is ephemeral:
do not treat a restarted MockBackend as a restored economic ledger.

Overlapping buyer calls sharing one store refuse before another payment attempt.
Completion writes retain the original pending record until the replacement is
durable. Failed completion candidates never authorize delivery, including after
restart; preserve both the pending record and candidate bytes. A crash during
pending-record cleanup may conservatively leave an order unresolved.

## Verification

Run a real CLI buyer against a disposable mock payment service, using the
existing CLI login and a new private directory outside Git:

```sh
node mock-llm.mjs "$PUBLIC_SINGIT_CHECKOUT" "$NEW_PRIVATE_RUN_DIR"
```

The operator launcher alone issues the mock mandate. It saves the four real
model/tool calls, provider usage, useful final answer and mock accounting privately.
Budget and buyer-role refusals must leave the original two operations unchanged.
No run directory or interrupted ledger is reused or silently reset.

For an independently prepared run, `node codex-buyer.mjs "$PRIVATE_RUN_JSON"`
reads a mode-600 file outside Git with `schema: 1`, `environment`, `inputPath`,
`mandateId`, `intent` and `evidenceDir`. Its environment accepts only the buyer and
merchant role tokens, local payment URL, profile selection/file, public roles,
application state paths and optional fixed capture/refund deadlines. The four
bounded tools are preapproved for this operator-authorized intent; this is not
permission for arbitrary model tools. Output paths are exclusive, preserving
earlier traces. A model answer without the four successful calls is rejected.

The opt-in [Bedrock Converse buyer](BEDROCK.md) uses the same buyer MCP and private
run configuration, with a separate bounded provider loop. Codex remains the default
for `mock-llm.mjs`; `--bedrock` explicitly selects the new runner. Offline tests
inject the SDK and require no AWS credentials. Real Bedrock inference needs its
own authorization, including when the payment backend is mock.

The `devnet` identity JSON contains exactly `schema`, `name`, `network`,
`genesisHash`, `programId`, `programDataAddress`, `executableSha256`,
`deploymentSlot`, `upgradeAuthority`, `abiCommit`, `mint`, `tokenProgram`, `payer`
and `merchant`. See `profile.mjs` for strict types. Derive the pins from the
independently accepted existing deployment, not an arbitrary observed account.
SingIt must configure `SINGIT_UPGRADE_AUTHORITY` (the accepted address or `none`)
and return the same profile. Its executable hash includes ProgramData padding;
the Capture402 deployment record hashes the source-sized slice and separately
checks zero padding, as described in [recovery documentation](../../docs/RECOVERY-OFFLINE.md).

Devnet receipts bind both original operation IDs/signatures, the full profile,
H=0/gross capture=650000/release=350000, and the artifact digest. The service's
`expected` operation field is its post-state; it is not an on-chain precondition.
Delivery follows original successful outcomes and durable completion. A response
loss or completion storage failure preserves the original and prevents recapture,
including further calls in the same model session.

```sh
npm test
SINGIT_CHECKOUT="$PUBLIC_SINGIT_CHECKOUT" npm test
```

Both commands launch the unmodified SingIt entrypoint with a
curated mock-only environment, synthetic wallets and ephemeral role/human
credentials. It exercises real authenticated HTTP and stdio MCP transports,
human-only mandate issuance, role and invalid-token refusals, exactly one
hold/capture per report, atomic remainder release, artifact delivery and known
successful idempotency replay. A separate synthetic hold/release contract check
verifies release-key replay without adding a release step to the report purchase.
The default source is this checkout; `SINGIT_CHECKOUT` can explicitly select a
different installed SingIt checkout for compatibility checks. Fault tests
cover overlap, lost responses, completion flush failures and restart. None sends
an RPC request or signs a wallet transaction.

MCP SDK v1 APIs: [client](https://ts.sdk.modelcontextprotocol.io/client),
[server](https://ts.sdk.modelcontextprotocol.io/server). This client intentionally
matches the v1 SDK used by SingIt; it does not silently migrate protocol versions.

Codex client configuration: [MCP](https://learn.chatgpt.com/docs/extend/mcp),
[non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).
