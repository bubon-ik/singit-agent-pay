#!/usr/bin/env bash
# Run on the VPS (local) or from anywhere with BASE overrides.
set -u
MCP="${MCP_BASE:-http://127.0.0.1:18787}"; DASH="${DASH_BASE:-http://127.0.0.1:15173}"
curl -fsS "$MCP/health" && echo "  <- mcp health"
curl -fsS -o /dev/null -w "%{http_code}  <- mcp tools/list\n" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -X POST "$MCP/mcp" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -fsS -o /dev/null -w "%{http_code}  <- dashboard /api/state\n" "$DASH/api/state"
