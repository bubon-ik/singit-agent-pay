#!/usr/bin/env bash
# Start the devnet MCP and its dashboard using an operator-owned private environment.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DASH="$(cd "$ROOT/.." && pwd)/demo-dashboard"
die() { echo "live:all: $*" >&2; exit 1; }
ENV_FILE="${1:-}"
case "$ENV_FILE" in /*) ;; *) die "usage: npm run live:all -- /absolute/path/to/private/devnet.env" ;; esac
[ -f "$ENV_FILE" ] || die "private environment file not found"
set -a
. "$ENV_FILE"
set +a
[ "${SINGIT_BACKEND:-}" = capture402 ] || die "SINGIT_BACKEND must be capture402"
[ -n "${SINGIT_STATE_DIR:-}" ] || die "SINGIT_STATE_DIR is required"
[ -n "${SINGIT_PAYER_ADDRESS:-}" ] && [ -n "${SINGIT_MERCHANT_ADDRESS:-}" ] || die "payer and merchant public addresses are required"
[ -n "${SINGIT_HUMAN_APPROVAL_SECRET:-}" ] && [ -n "${SINGIT_HUMAN_ROUTE_SECRET:-}" ] || die "both human secrets are required"
[ "${#SINGIT_HUMAN_APPROVAL_SECRET}" -ge 16 ] && [ "${#SINGIT_HUMAN_ROUTE_SECRET}" -ge 16 ] || die "both human secrets must contain at least 16 characters"
[ -f "$ROOT/node_modules/tsx/dist/loader.mjs" ] || die "run npm ci at the repository root first"
MCP_PORT="${MCP_PORT:-8787}"
DASH_PORT="${DASH_PORT:-5173}"
port_busy() { node -e 'const s=require("net").createServer();s.once("error",()=>process.exit(0));s.listen(+process.argv[1],"127.0.0.1",()=>s.close(()=>process.exit(1)))' "$1"; }
if port_busy "$MCP_PORT"; then die "MCP port is already in use; set MCP_PORT to a free port"; fi
if port_busy "$DASH_PORT"; then die "dashboard port is already in use; set DASH_PORT to a free port"; fi
PIDS=""
cleanup() {
  trap - INT TERM EXIT
  for pid in $PIDS; do kill -TERM "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT
# MVP-01: with both agent tokens the server enforces per-role principals and the dashboard bridge uses
# them; the single trusted-operator mode is only the fallback when no tokens are configured.
if [ -n "${SINGIT_BUYER_TOKEN:-}" ] && [ -n "${SINGIT_MERCHANT_TOKEN:-}" ]; then TRUSTED_DEFAULT=0; else TRUSTED_DEFAULT=1; fi
(cd "$ROOT" && PORT="$MCP_PORT" SINGIT_MCP_TRUSTED_OPERATOR="${SINGIT_MCP_TRUSTED_OPERATOR:-$TRUSTED_DEFAULT}" exec node --import tsx src/index.ts --http) &
MCP_PID="$!"
PIDS="$MCP_PID"
deadline=$((SECONDS + 45))
while ! node -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(1000)}).then(r=>r.json()).then(s=>process.exit(s.backend==="devnet"?0:1),()=>process.exit(1))' "http://127.0.0.1:$MCP_PORT/api/state" 2>/dev/null; do
  kill -0 "$MCP_PID" 2>/dev/null || die "MCP startup failed; review the error above"
  (( SECONDS < deadline )) || die "MCP did not become ready within 45 seconds"
  sleep 0.25
done
(
  cd "$DASH"
  # The bridge receives public wallet identities and the human route secret, not custody config.
  unset SINGIT_RPC_URL SINGIT_PAYER_KEYPAIR SINGIT_MERCHANT_KEYPAIR SINGIT_HUMAN_APPROVAL_SECRET SINGIT_STATE_DIR SINGIT_EVIDENCE_DIR
  PORT="$DASH_PORT" SINGIT_BACKEND=mcp-http SINGIT_REQUIRE_DEVNET=1 SINGIT_MCP_URL="http://127.0.0.1:$MCP_PORT" exec node server.mjs
) &
DASH_PID="$!"
PIDS="$PIDS $DASH_PID"
echo "Devnet MCP: http://127.0.0.1:$MCP_PORT/mcp" >&2
echo "Dashboard: http://127.0.0.1:$DASH_PORT" >&2
echo "Ready. Starting the browser story requires a click and confirmation (7 test USDC gross). Ctrl-C stops both services." >&2
while kill -0 "$MCP_PID" 2>/dev/null && kill -0 "$DASH_PID" 2>/dev/null; do sleep 1; done
die "a service stopped; shutting down the other service"
