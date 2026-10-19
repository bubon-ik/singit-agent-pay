# SingIt demo dashboard

Local demo UI for singit-mcp. It shows mandate budgets, escrow holds, audit events, and a human dispute console. It uses plain Node 20 and static HTML/JS.

## Fresh clone

```sh
git clone <repo-url> singit && cd singit   # repo root holds singit-mcp/ and demo-dashboard/ side by side
(cd singit-mcp && npm ci)   # the dashboard has no deps of its own; it reuses singit-mcp's tsx
cd demo-dashboard
npm run test:e2e   # in-process: imports ../singit-mcp/src
SINGIT_BACKEND=local npm run test:e2e   # local adapter
npm start   # http://127.0.0.1:5173
```

## Run

- `npm start`: auto mode; uses singit-mcp TypeScript through tsx when importable
- `npm run start:local`: force the local in-memory adapter
- `SINGIT_BACKEND=mcp-http npm start`: connect to a running singit-mcp HTTP server
- `npm run demo:all` in `../singit-mcp`: starts the bridge with `SINGIT_MCP_URL` set, so the dashboard selects `mcp-http` automatically
- `npm run story`
- `node scripts/story.mjs --presenter|--delay=N|--fast [--auto-approve] [--reset]` (`--presenter` uses 7 s per step)
- `node scripts/mcp-smoke.mjs`
- `npm run test:e2e`

`PORT` defaults to 5173. `SINGIT_HUMAN_APPROVAL_SECRET` is used by in-process/local modes and is generated ephemerally when unset. Never expose it to the browser.

## Backend modes

Set `SINGIT_BACKEND` to choose a mode:

- `auto` (default when `SINGIT_MCP_URL` is unset): try importing `../singit-mcp/src/service.ts`, its `MockBackend`, and approval helper. If those imports fail, use the local adapter. When `SINGIT_MCP_URL` is set and `SINGIT_BACKEND` is unset, `mcp-http` is selected automatically. Explicit `SINGIT_BACKEND=auto`, `local`, or `mcp-http` takes precedence.
- `local`: use `adapter/local-service.mjs` directly.
- `mcp-http`: connect to the MCP Streamable HTTP endpoint at `SINGIT_MCP_URL` (default `http://127.0.0.1:8787`) plus `/mcp`, and poll `/api/state` about once per second. At startup, an MCP connection failure or a non-200 state response logs one reason and falls back to in-process mode (or local if the in-process imports are unavailable).

In `mcp-http` mode human resolve posts a decision to `/human/resolve` with the server-side `x-singit-human-secret` header. Reset posts `{actor: "human"}` to `/human/reset` with the same server-side secret. Remote reset is supported by singit-mcp mock mode only: it clears remote mandates, holds, disputes, and audit, restores default balances, and records one reset audit row. On devnet the route returns 409 and the dashboard shows the server’s reason. If the bridge secret is unset, reset fails without changing state. The secret is never sent to the browser. In-process and local resets clear their local story state. Run is allowed when the story state is `idle` in `mcp-http` mode.

To run against a local singit-mcp HTTP server, use two random secrets and start both services:

```sh
cd ../singit-mcp && SINGIT_HUMAN_ROUTE_SECRET=<random> SINGIT_HUMAN_APPROVAL_SECRET=<random> npm run start:http
SINGIT_BACKEND=mcp-http SINGIT_HUMAN_ROUTE_SECRET=<same> npm start
```

Generate each secret with `openssl rand -hex 24`, use the same route secret on the MCP server and dashboard bridge, and never commit the secrets. `SINGIT_MOCK_BALANCES` is no longer needed; singit-mcp provides the default balances for the story agents.

The `/api/state` shape is confirmed by singit-mcp `http.ts` at commit `f539ed8`: `{v:1, backend:"mock"|..., mandates:[{mandate, remaining, holds}], holds:[...], disputes:[...], audit:[AuditEntry v1]}`. The bridge normalizes decimal bigint strings, nested mandate data, top-level holds, disputes, and audit entries. In `mcp-http` mode, the badge uses the server's `backend` field (`devnet` only when reported; other values show `mock`).

## Tool and state API

Tool names and audit actions are the same. Use `hold` for escrow authorization. Amounts are USDC base-unit decimal strings (`2500000` = 2.5 USDC).

| HTTP | MCP tool | Service method |
|---|---|---|
| `POST /api/tool/create_mandate` | `create_mandate` | `createMandate` |
| `POST /api/tool/hold` | `hold` | `hold` (capture402 authorize, tag 0) |
| `POST /api/tool/capture`, `release`, `refund` | `capture`, `release`, `refund` | capture / void / refund |
| `POST /api/tool/open_dispute` | `open_dispute` | `openDispute` |
| `POST /api/tool/list_audit_log` | `list_audit_log` | audit read |
| `POST /api/human/resolve` | human-only resolution | in-process approval token or mcp-http human route |
| `GET /api/state` | - | normalized mandates, disputes, audit-derived timeline, audit, and story progress |

`POST /api/tool/resolve_dispute` returns 403. Agents cannot resolve disputes. Audit v1 is the sole event source: each entry includes version, sequence, timestamp, actor, action, outcome, code, reason, ids, base-unit amount, tx signature, held, and refundable. Timeline entries are derived from those rows.

## Story

1. Create a 10 USDC mandate with a 4 USDC per-hold cap and two allowed sellers.
2. Hold 3 USDC for data-vendor, capture 2.5, then release 0.5.
3. Hold and capture 4 USDC for gpu-broker.
4. Try a 5 USDC hold over the per-transaction cap, try an unknown seller, then exceed the remaining budget; all appear as blocked audit/timeline events.
5. Refund 0.5 USDC (the budget is not restored).
6. Open a dispute, watch the agent fail to resolve it with a missing and forged token, then let a human approve a refund or reject it.

`node scripts/mcp-smoke.mjs` connects to MCP, lists tools, calls `list_mandates`, creates a smoke mandate, attempts a 500000-unit hold, and reports the `/api/state` HTTP status. It exits successfully when the MCP calls work.

Real Solana signatures are linked to the devnet explorer. Mock transaction references remain plain badges.

## Operations (ops) — upcoming singit-mcp hardening

The Operations card appears only when `/api/state` includes an `ops` array. Pending operations show an amber spinner; unknown outcomes show orange “OUTCOME UNKNOWN — funds reserved, reconciling”. Mandates show “reserved X USDC (pending)” for active reservations, which are already included in `committed`. Refusal codes `OPERATION_UNKNOWN` / `OPERATION_PENDING` and `OUTCOME_UNKNOWN` / reconcile audit rows use amber or orange styling instead of red. Run `npm run test:unit` for the offline unit tests.

Operations are public status projections for both in-process and remote sources. Prepared metadata includes only `txSig`, `holdId` and `lastValidBlockHeight`; full prepared evidence and signed wires remain in the service's private journal. The bridge redacts older upstream records before caching them and projects every operation again when serving a snapshot.

## Screenshots

`scripts/screenshot.sh` boots the bridge on a spare port and walks the full 13-step story in presenter mode, capturing:

- `screenshots/01-empty.png` — dashboard before `Run demo story`
- `screenshots/02-mid-story-step8.png` — mid-story, step 8 (unknown seller blocked)
- `screenshots/02b-step9-over-budget.png` — step 9 (over-budget hold blocked)
- `screenshots/03b-step12-agent-self-approve-blocked.png` — step 12 (agent's own resolve attempt refused)
- `screenshots/03-dispute-pending.png` — step 13, awaiting human decision
- `screenshots/04-dispute-approved.png` — after the human approves the refund through the bridge

`SINGIT_MCP_URL` and `SINGIT_HUMAN_ROUTE_SECRET` are passed through from the caller's environment, so the same script works against a running singit-mcp HTTP server (`mcp-http` mode).

## Backup recording

The 13-step story recording lives in `backup/demo.mp4` (with a `backup/demo.gif` GIF version). It is **not in git** — the files are kept out of the repo and published as a GitHub release asset instead, so a fresh clone won’t have them locally.

If `backup/demo.mp4` is missing, download the media from the latest GitHub release assets into `backup/`:

```sh
gh release download --repo <repo-org>/<repo> --pattern 'demo.mp4' --dir backup/
gh release download --repo <repo-org>/<repo> --pattern 'demo.gif' --dir backup/   # optional GIF
```

(or use the release page’s asset links). Then open the playback page with `npm run backup`, or play the file directly with `xdg-open backup/demo.mp4`. The recording is paced for presenters.

