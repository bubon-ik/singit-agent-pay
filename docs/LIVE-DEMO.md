# Run the MCP and dashboard on Solana devnet

Run this on the operator's machine that already holds the isolated devnet keypairs
and the approved Helius/QuickNode RPC configuration. Keep the keys there.
The deployment, source build and upgrade authority still require the acceptance
described in [CAPTURE402-DEVNET.md](CAPTURE402-DEVNET.md).

1. Install dependencies with `npm ci` at the repository root.
2. Copy `singit-mcp/.env.example` to a private file outside Git and set its mode to
   `600`. Fill the RPC endpoint, keypair paths and matching public addresses there.
   Keep the deployment identity pinned. Select an absolute `SINGIT_STATE_DIR`
   outside every checkout for the private journal. Generate and retain the two
   human secrets separately (`openssl rand -hex 32` for each).
3. Start both services:

   ```sh
   npm run live:all -- /absolute/path/to/private/devnet.env
   ```

4. Open `http://127.0.0.1:5173`. The badge must say **devnet**. The live launcher
   refuses to fall back to a mock server. Opening the page sends no payment.
5. **Run devnet story** asks for confirmation: it authorizes **7 test USDC** across
   two holds, captures 6.5, releases 0.5 and refunds 0.5 before the dispute. A
   separate human approval can refund another 4. Both dataset and GPU seller
   roles use the configured merchant wallet. Two payment/vault pairs incur SOL
   rent and transaction fees; see the direct-smoke estimates in the devnet guide.
   A failed/ambiguous run can leave escrow held. The story stops at the first
   unexpected result and does not attempt cleanup or automatically retry.

The direct `devnet:smoke` is a different, smaller 1-USDC backend exercise. Its
success does not establish the full browser/MCP story above. Live browser
acceptance must verify the finalized signatures, audit entries and resulting
balances on the actual operator host.

## Restarts and private state

The live backend spaces RPC requests by at least 100 ms within one instance.
Only read-side HTTP 429 responses retry, at most three times, using `Retry-After`
or bounded backoff within the original request deadline. This includes simulation
of the same signed bytes and observation of the original signature. Submission
uses one paced `sendTransaction` call with `maxRetries: 0`; a send-side error or
exhausted confirmation remains UNKNOWN, with its original wire and reservation.
An exhausted read reports its method and numeric HTTP status in stderr and state;
provider URLs, headers and messages are never logged. Pacing does not coordinate
other applications sharing the provider or establish its current quota.

The live MCP entrypoint requires `SINGIT_STATE_DIR`, creates a mode-700 directory
and mode-600 journal, and exclusively locks that directory while running. It
restores mandates, holds, disputes and private operation evidence. Before exposing
HTTP or stdio it reconciles pending records against their original transactions,
then performs a read-only network/deployment and canonical-wallet-account preflight.
This startup pass does not sign or resend, including cleanup transactions. Any
unresolved outcome stops startup with `STARTUP_RECONCILIATION_REQUIRED` and keeps
the journal and reservations intact. Inspect the original signatures and restart
only after their outcome can be established.

Graceful shutdown releases `.singit-mcp.lock`. After a forced termination, confirm
that the old process has stopped before manually removing that stale lock. Use
one runtime per set of wallets: a second runtime with the same program, payer and
merchant refuses with `NAMESPACE_LOCKED`, even with another state directory (one
host only). A failed journal write or an UNKNOWN outcome closes economic writes
until restart; `GET /ready` (human route secret) shows why. Live mode sends no
automatic cleanup and refuses two-step dispute refunds. These offline-tested
safeguards still need independent live acceptance. The default mock demo remains ephemeral and
does not support a durable operation journal without its ledger.

## Local preview

`npm run demo:all` runs the mock demo. The live command uses the external private
environment and requires a devnet MCP upstream. Public state excludes original
signed wires and idempotency keys. The browser receives neither wallet keys nor
the human route secret.

After a stopped run, restarting the dashboard restores its idle controls while
retaining the MCP journal and audit history. A new devnet story requires a new
confirmation and is blocked while any original operation is pending/UNKNOWN or
a dispute is open. It does not resume or reset the failed run. Investigate and
retain that run's original evidence before confirming any new economic actions.
