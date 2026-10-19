#!/usr/bin/env bash
# One-command local demo (macOS/Linux): singit-mcp HTTP (:8787) + demo dashboard (:5173).
# Mock backend, synthetic data, local dev secrets only. Ctrl-C stops both.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DASH="$(cd "$ROOT/.." && pwd)/demo-dashboard"
MCP_PORT="${MCP_PORT:-8787}"
DASH_PORT="${DASH_PORT:-5173}"
die() { echo "demo:all: $*" >&2; exit 1; }

# 1. Node version
command -v node >/dev/null || die "Node.js not found. Install Node 22 (or 20): https://nodejs.org or 'nvm install 22'."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
case "$NODE_MAJOR" in
  20|22|24) ;;
  *) die "Node $(node -v) is not supported. Use Node 22 or 20 (e.g. 'nvm use' in singit-mcp/, .nvmrc = 22)." ;;
esac

# 2. Dependencies (install only if missing)
if [ ! -x "$ROOT/node_modules/.bin/tsx" ]; then
  echo "demo:all: installing singit-mcp dependencies (npm ci)..." >&2
  (cd "$ROOT" && npm ci --no-audit --no-fund) || die "npm ci failed in singit-mcp"
fi
HAVE_DASH=0
if [ -f "$DASH/package.json" ]; then
  HAVE_DASH=1
  if node -e 'const p=require(process.argv[1]);process.exit(Object.keys({...p.dependencies,...p.devDependencies}).length?0:1)' "$DASH/package.json" \
     && [ ! -d "$DASH/node_modules" ]; then
    echo "demo:all: installing demo-dashboard dependencies..." >&2
    if [ -f "$DASH/package-lock.json" ]; then (cd "$DASH" && npm ci --no-audit --no-fund); else (cd "$DASH" && npm install --no-audit --no-fund); fi \
      || die "dependency install failed in demo-dashboard"
  fi
else
  echo "demo:all: ../demo-dashboard not found next to singit-mcp; starting MCP only." >&2
fi

# 3. Local dev secrets (gitignored .env.local, generated once)
ENV_FILE="$ROOT/.env.local"
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  node -e 'const r=()=>require("crypto").randomBytes(32).toString("hex");console.log("# local dev secrets for npm run demo:all (gitignored, demo only)\nSINGIT_HUMAN_APPROVAL_SECRET="+r()+"\nSINGIT_HUMAN_ROUTE_SECRET="+r())' > "$ENV_FILE"
  echo "demo:all: created $ENV_FILE with fresh local dev secrets" >&2
fi
set -a; . "$ENV_FILE"; set +a

# 4. Ports free?
port_busy() { node -e 'const s=require("net").createServer();s.once("error",()=>process.exit(0));s.listen(+process.argv[1],"127.0.0.1",()=>s.close(()=>process.exit(1)))' "$1"; }
port_busy "$MCP_PORT" && die "port $MCP_PORT is in use (MCP). Free it or run: MCP_PORT=8788 npm run demo:all"
if [ "$HAVE_DASH" = 1 ]; then
  port_busy "$DASH_PORT" && die "port $DASH_PORT is in use (dashboard). Free it or run: DASH_PORT=5174 npm run demo:all"
fi

# 5. Start both; Ctrl-C / exit stops both
PIDS=""
killtree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill -TERM "$1" 2>/dev/null || true; }
cleanup() { trap - INT TERM EXIT; for p in $PIDS; do killtree "$p"; done; wait 2>/dev/null || true; echo "demo:all: stopped." >&2; }
trap cleanup INT TERM EXIT

(cd "$ROOT" && PORT="$MCP_PORT" exec ./node_modules/.bin/tsx src/index.ts --http) &
PIDS="$!"
if [ "$HAVE_DASH" = 1 ]; then
  (cd "$DASH" && PORT="$DASH_PORT" SINGIT_MCP_URL="http://127.0.0.1:$MCP_PORT" exec npm start --silent) &
  PIDS="$PIDS $!"
fi

# wait for health
for _ in $(seq 1 40); do
  node -e 'fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))' "http://127.0.0.1:$MCP_PORT/health" && break
  sleep 0.25
done
echo "" >&2
echo "  MCP (streamable HTTP): http://127.0.0.1:$MCP_PORT/mcp" >&2
echo "  State (JSON):          http://127.0.0.1:$MCP_PORT/api/state" >&2
[ "$HAVE_DASH" = 1 ] && echo "  Dashboard:             http://127.0.0.1:$DASH_PORT" >&2
echo "  Ctrl-C to stop." >&2
echo "" >&2

# exit when either process exits
while :; do
  for p in $PIDS; do kill -0 "$p" 2>/dev/null || { echo "demo:all: a process exited; stopping." >&2; exit 1; }; done
  sleep 1
done
