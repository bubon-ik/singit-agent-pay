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
one runtime and one state directory for these wallets; separate directories do
not coordinate custody. Post-send storage failures and dispute cleanup still
need independent live acceptance. The default mock demo remains ephemeral and
does not support a durable operation journal without its ledger.

## Local preview

`npm run demo:all` runs the mock demo. The live command uses the external private
environment and requires a devnet MCP upstream. Public state excludes original
signed wires and idempotency keys. The browser receives neither wallet keys nor
the human route secret.
