#!/usr/bin/env bash
# One-command local demo: singit-mcp streamable HTTP (:8787) + demo dashboard (:5173).
# Uses MockBackend unless SINGIT_BACKEND=capture402. The secret below is a demo-only default.
set -euo pipefail
cd "$(dirname "$0")/.."
export SINGIT_HUMAN_APPROVAL_SECRET="${SINGIT_HUMAN_APPROVAL_SECRET:-demo-only-human-secret-0123456789}"
MCP_PORT="${MCP_PORT:-8787}"
DASH_PORT="${DASH_PORT:-5173}"

PORT="$MCP_PORT" npx tsx src/index.ts --http &
MCP_PID=$!
trap 'kill $MCP_PID 2>/dev/null || true' EXIT INT TERM

if [ ! -f ../demo-dashboard/package.json ]; then
  echo "demo-dashboard not found next to singit-mcp; MCP only: http://127.0.0.1:$MCP_PORT/mcp" >&2
  wait $MCP_PID
fi
echo "MCP:       http://127.0.0.1:$MCP_PORT/mcp" >&2
echo "Dashboard: http://127.0.0.1:$DASH_PORT" >&2
PORT="$DASH_PORT" npm --prefix ../demo-dashboard start
