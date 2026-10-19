#!/usr/bin/env bash
# Headless screenshots via the installed Google Chrome (no Playwright needed).
# Starts its own server on a spare port and walks the story in presenter mode using the Next endpoint.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-5199}; export PORT; U="http://127.0.0.1:$PORT"
CHROME=${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser)}
mkdir -p screenshots
LOG="$(mktemp "${TMPDIR:-/tmp}/singit-dashboard-shot.XXXXXX.log")"
# Pass SINGIT_MCP_URL and SINGIT_HUMAN_ROUTE_SECRET through so the same script works
# in mcp-http mode against a running singit-mcp HTTP server.
export SINGIT_MCP_URL SINGIT_HUMAN_ROUTE_SECRET
node ../singit-mcp/node_modules/tsx/dist/cli.mjs server.mjs >"$LOG" 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null' EXIT
for i in $(seq 1 50); do curl -sf "$U/api/state" >/dev/null && break; sleep 0.2; done
post() { curl -sf -X POST -H 'content-type: application/json' -d "${2:-{\}}" "$U$1" >/dev/null; }
step() { curl -sf "$U/api/state" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.story.step+" "+j.story.state)})'; }
until_step() { for i in $(seq 1 100); do read n st < <(step); [ "$n" -ge "$1" ] && return; sleep 0.1; done; }
shot() { "$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --window-size=1600,1500 \
  --virtual-time-budget=1500 --screenshot="$PWD/screenshots/$1" "$U/" >/dev/null 2>&1; echo "saved screenshots/$1"; }
shot 01-empty.png
post /api/story '{"delay":8500,"mode":"presenter"}'          # presenter pacing, advanced with Next
until_step 1
post /api/story/next; until_step 2
post /api/story/next; until_step 3
post /api/story/next; until_step 4
post /api/story/next; until_step 5
post /api/story/next; until_step 6
post /api/story/next; until_step 7
post /api/story/next; until_step 8
shot 02-mid-story-step8.png                                  # step counter, caption, countdown, Next button, BLOCKED event
post /api/story/next; until_step 9
shot 02b-step9-over-budget.png
post /api/story/next; until_step 10
post /api/story/next; until_step 11
post /api/story/next; until_step 12
shot 03b-step12-agent-self-approve-blocked.png
post /api/story/next; until_step 13
shot 03-dispute-pending.png                                  # step 13 = awaiting human
post /api/human/resolve '{"disputeId":"d-1","outcome":"refund","refundAmount":"4000000"}'
sleep 0.5
shot 04-dispute-approved.png                                 # results stay on screen after the story completes
head -1 "$LOG"
