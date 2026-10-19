// Dashboard bridge: auto uses singit-mcp's in-process service when importable,
// local uses the spec-compatible adapter, and mcp-http uses the remote MCP server.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { publicOperation } from "./lib/public-state.mjs";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as local from "./adapter/local-service.mjs";
import { deriveTimeline } from "./lib/derive.mjs";
import { storyStartBlocker } from "./public/ops.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5173);
const CLUSTER = "devnet";
const SECRET = process.env.SINGIT_HUMAN_APPROVAL_SECRET ?? randomBytes(24).toString("hex");
process.env.SINGIT_HUMAN_APPROVAL_SECRET = SECRET;
const U = 1_000_000n;
const backendMode = process.env.SINGIT_BACKEND ?? (process.env.SINGIT_MCP_URL ? "mcp-http" : "auto");
const requireDevnet = process.env.SINGIT_REQUIRE_DEVNET === "1";
if (requireDevnet && backendMode !== "mcp-http") throw Error("Live dashboard requires SINGIT_BACKEND=mcp-http");
const fallback = { kind: "local", mod: local, issue: local.issueApprovalToken, MockBackend: local.LocalMockBackend, PaymentService: local.LocalPaymentService };
let impl = fallback, backendNote = "local adapter (adapter/local-service.mjs)", mcpClient = null, remoteCache = { mandates: [], disputes: [], audit: [] };
let backendConnecting = false;
let backendFailure = null;

async function loadInProcess() {
  try {
    const base = new URL("../singit-mcp/src/", import.meta.url);
    const [svc, mock, appr] = await Promise.all([
      import(new URL("service.ts", base).href), import(new URL("backend/mock.ts", base).href), import(new URL("approval.ts", base).href),
    ]);
    if (svc.PaymentService && mock.MockBackend && appr.issueApprovalToken) {
      impl = { kind: "in-process", issue: appr.issueApprovalToken, MockBackend: mock.MockBackend, PaymentService: svc.PaymentService };
      backendNote = "singit-mcp PaymentService + MockBackend (in-process)";
      return true;
    }
    return false;
  } catch (e) { backendNote = `local adapter — in-process import unavailable: ${String(e.message).split("\n")[0]}`; return false; }
}

async function connectMcpHttp() {
  const base = (process.env.SINGIT_MCP_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  const waitMs = Number(process.env.SINGIT_MCP_WAIT_MS ?? 20000);
  const deadline = Date.now() + (Number.isFinite(waitMs) ? Math.max(0, waitMs) : 20000);
  let lastReason = "connection timed out";
  backendConnecting = true;
  backendNote = `connecting to singit-mcp at ${base}`;
  console.log(`[dashboard] waiting for singit-mcp at ${base}...`);
  let Client, StreamableHTTPClientTransport;
  try {
    const sdk = new URL("../singit-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/", import.meta.url);
    [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
      import(new URL("client/index.js", sdk).href), import(new URL("client/streamableHttp.js", sdk).href),
    ]);
  } catch (e) {
    lastReason = safeStartupReason(e);
  }
  if (Client && StreamableHTTPClientTransport) {
    do {
      let client;
      try {
        client = new Client({ name: "singit-demo-dashboard", version: "1.0.0" });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
        const stateResponse = await fetch(`${base}/api/state`);
        if (!stateResponse.ok) throw new Error(`/api/state HTTP ${stateResponse.status}`);
        const state = await stateResponse.json();
        if (requireDevnet && state.backend !== "devnet") throw Error("upstream is not devnet");
        remoteCache = normalizeRemoteState(state);
        mcpClient = client;
        impl = { kind: "mcp-http" };
        backendNote = `MCP HTTP at ${base}`;
        backendConnecting = false;
        backendFailure = null;
        console.log(`[dashboard] backend: mcp-http (${base})`);
        pollRemoteState(base);
        return;
      } catch (e) {
        lastReason = safeStartupReason(e);
        try { await client?.close(); } catch { /* ignore an incomplete MCP handshake */ }
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now()))));
    } while (Date.now() <= deadline);
  }
  backendConnecting = false;
  if (requireDevnet) {
    impl = { kind: "mcp-http" };
    backendFailure = "Devnet MCP unavailable; check its startup output and configuration";
    backendNote = backendFailure;
    console.error(`[dashboard] ${backendFailure}`);
    return;
  }
  impl = fallback;
  await loadInProcess();
  backendNote = `mcp-http unavailable (${lastReason}); fell back to ${impl.kind === "in-process" ? "in-process" : "local"} mode`;
  console.log(`[dashboard] ${backendNote}`);
}
function safeStartupReason(error) {
  const message = String(error?.message ?? error ?? "connection failed").split("\n")[0];
  const http = message.match(/(?:GET )?\/?api\/state(?: returned)? HTTP (\d{3})/i);
  if (http) return `/api/state HTTP ${http[1]}`;
  const connect = message.match(/\b(connect ECONNREFUSED|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH)\b/);
  if (connect) return connect[1].startsWith("connect " ) ? connect[1] : connect[1];
  if (/timed out/i.test(message)) return "connection timed out";
  return "connection failed";
}
if (backendMode === "mcp-http") void connectMcpHttp();
else {
  if (backendMode !== "local") await loadInProcess();
  console.log(`[dashboard] backend: ${backendNote}`);
}

// Confirmed /api/state shape from singit-mcp http.ts at f539ed8.
const normalizeRemoteHold = (h) => ({ ...h, held: h?.held == null ? h?.held : String(h.held), refundable: h?.refundable == null ? h?.refundable : String(h.refundable), captured: h?.captured == null ? h?.captured : String(h.captured), refunded: h?.refunded == null ? h?.refunded : String(h.refunded), maximum: h?.maximum == null ? h?.maximum : String(h.maximum), txSigs: Array.isArray(h?.txSigs) ? h.txSigs : [], txRef: h?.lastTxSig ?? h?.txRef });
function normalizeRemoteState(s = {}) {
  const raw = Array.isArray(s.mandates) ? s.mandates : [];
  const mandates = raw.map((x) => {
    const m = x?.mandate ? { ...x.mandate, remaining: x.remaining, holds: x.holds } : x;
    const normalized = { ...m, totalBudget: String(m.totalBudget), perTxCap: String(m.perTxCap), remaining: m.remaining == null ? m.remaining : String(m.remaining), committed: m.committed == null ? m.committed : String(m.committed), holds: (m?.holds ?? []).map(normalizeRemoteHold) };
    return normalized;
  });
  if (Array.isArray(s.holds)) {
    const byId = new Map(mandates.map((m) => [m.id, m]));
    for (const h of s.holds) { const m = byId.get(h.mandateId); if (m && !m.holds.some((x) => x.id === h.id)) m.holds.push(normalizeRemoteHold(h)); }
  }
  const ops = Array.isArray(s.ops) ? s.ops.map(publicOperation) : undefined;
  return { backend: s.backend, mandates, holds: Array.isArray(s.holds) ? s.holds.map(normalizeRemoteHold) : [], disputes: Array.isArray(s.disputes) ? s.disputes.map((d) => ({ ...d, refundAmount: d.refundAmount == null ? d.refundAmount : String(d.refundAmount), txRefs: d.txSigs ?? d.txRefs ?? [] })) : [], audit: Array.isArray(s.audit) ? s.audit : [], ...(ops ? { ops } : {}) };
}
async function refreshRemoteState(base) {
  try {
    const r = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw Error("state unavailable");
    const state = await r.json();
    if (requireDevnet && state.backend !== "devnet") throw Error("upstream is not devnet");
    remoteCache = normalizeRemoteState(state);
    backendFailure = null;
  } catch {
    if (requireDevnet) backendFailure = "Devnet MCP state unavailable; writes paused";
  }
}
async function pollRemoteState(base) {
  for (;;) {
    await refreshRemoteState(base);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// ---------- state ----------
const MOCK_AGENTS = { payer: "agent:research-bot", vendor: "agent:data-vendor", gpu: "agent:gpu-broker", rogue: "agent:unknown-seller" };
function liveAgents() {
  const payer = process.env.SINGIT_PAYER_ADDRESS, merchant = process.env.SINGIT_MERCHANT_ADDRESS;
  const valid = value => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value ?? "");
  return valid(payer) && valid(merchant) && payer !== merchant
    ? { payer, vendor: merchant, gpu: merchant, rogue: MOCK_AGENTS.rogue }
    : null;
}
let svc, mandateIds, disputes, story;
let storyGen = 0;
function reset() {
  storyGen++;
  if (impl.kind !== "mcp-http") {
    const backend = new impl.MockBackend({ balances: { [MOCK_AGENTS.payer]: 100n * U, [MOCK_AGENTS.vendor]: 20n * U, [MOCK_AGENTS.gpu]: 20n * U } });
    svc = new impl.PaymentService({ backend, approvalSecret: SECRET });
    mandateIds = []; disputes = new Map();
  }
  story = { state: "idle", step: 0, total: 0, label: "", caption: "" };
}
async function resetRemote() {
  const secret = process.env.SINGIT_HUMAN_ROUTE_SECRET;
  if (!secret) {
    return { ok: false, code: "HUMAN_ROUTE_SECRET_UNSET", message: "SINGIT_HUMAN_ROUTE_SECRET is not set on the dashboard bridge" };
  }
  const base = (process.env.SINGIT_MCP_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  try {
    const r = await fetch(`${base}/human/reset`, {
      method: "POST",
      headers: { "x-singit-human-secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ actor: "human" }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const code = data.code ?? "HUMAN_ROUTE_ERROR";
      const message = r.status === 409
        ? data.reason ?? data.message ?? code
        : r.status === 403
          ? "singit-mcp human route disabled: set SINGIT_HUMAN_ROUTE_SECRET (>=16 chars) on the MCP server"
          : r.status === 401
            ? "wrong human route secret"
            : data.reason ?? data.message ?? "human route returned an HTTP error";
      return { ok: false, code, message };
    }
    await refreshRemoteState(base);
    reset();
    return { ok: true };
  } catch {
    return { ok: false, code: "HUMAN_ROUTE_ERROR", message: "could not reach singit-mcp human reset route" };
  }
}
reset();

const pickTx = (r) => r?.txSig ?? r?.hold?.lastTxSig ?? r?.hold?.txRef ?? r?.lastTxSig ?? r?.txRef ?? (Array.isArray(r?.dispute?.txSigs) ? r.dispute.txSigs.at(-1) : undefined) ?? (Array.isArray(r?.txSigs) ? r.txSigs.at(-1) : undefined) ?? (Array.isArray(r?.txRefs) ? r.txRefs.at(-1) : undefined);
const pickHoldId = (r) => r?.hold?.id ?? r?.hold?.holdId ?? r?.holdId ?? r?.id;
const normalizeHold = (h) => ({ ...h, status: h.status ?? (BigInt(h.held ?? 0) > 0n ? "held" : "settled"), held: h.held == null ? h.held : String(h.held), captured: h.captured == null ? h.captured : String(h.captured), refunded: h.refunded == null ? h.refunded : String(h.refunded), maximum: h.maximum == null ? h.maximum : String(h.maximum), txRef: h.lastTxSig ?? h.txRef });
const normalizeMandate = (r) => { const m = r?.mandate ? { ...r.mandate, remaining: r.remaining, holds: r.holds } : r; return m && { ...m, totalBudget: String(m.totalBudget), perTxCap: String(m.perTxCap), remaining: m.remaining == null ? m.remaining : String(m.remaining), committed: m.committed == null ? m.committed : String(m.committed), holds: (m.holds ?? []).map(normalizeHold) }; };
function getAudit() { return impl.kind === "mcp-http" ? remoteCache.audit : svc.listAuditLog({}); }
// ---------- tool surface ----------
const localTools = {
  async create_mandate(a) { const m = await svc.createMandate({ actor: a.actor ?? a.payer, payer: a.payer, totalBudget: BigInt(a.totalBudget), perTxCap: BigInt(a.perTxCap), expiresAt: Number(a.expiresAt), allowedCounterparties: a.allowedCounterparties, note: a.note }); mandateIds.push(m?.id ?? m?.mandate?.id); return m; },
  async hold(a) { return svc.hold({ actor: a.actor, mandateId: a.mandateId, payee: a.payee, amount: BigInt(a.amount), captureDeadline: a.captureDeadline, refundDeadline: a.refundDeadline }); },
  async capture(a) { return svc.capture({ actor: a.actor, holdId: a.holdId, amount: BigInt(a.amount), releaseRemainder: !!a.releaseRemainder }); },
  async release(a) { return svc.release({ actor: a.actor, holdId: a.holdId }); },
  async refund(a) { return svc.refund({ actor: a.actor, holdId: a.holdId, amount: BigInt(a.amount) }); },
  async open_dispute(a) { const d = await svc.openDispute({ actor: a.actor, holdId: a.holdId, reason: a.reason, evidence: a.evidence ?? [] }); disputes.set(d.id, d); return d; },
  async resolve_dispute(a) { return svc.resolveDispute({ actor: a.actor, disputeId: a.disputeId, outcome: a.outcome, refundAmount: a.refundAmount == null ? undefined : BigInt(a.refundAmount), approvalToken: a.approvalToken }); },
  async list_audit_log(a = {}) { return svc.listAuditLog({ mandateId: a.mandateId, limit: a.limit }); },
};
async function callTool(name, args = {}) {
  if (backendFailure || backendConnecting) return { ok: false, code: "BACKEND_UNAVAILABLE", message: backendFailure ?? "MCP is connecting" };
  if (impl.kind === "mcp-http") {
    if (!["create_mandate", "hold", "capture", "release", "refund", "open_dispute", "resolve_dispute", "list_audit_log"].includes(name)) return { ok: false, code: "INVALID_INPUT", message: `unknown tool ${name}` };
    try {
      // Live MCP requires one idempotencyKey per economic intent (MVP-02). Each story step is its own
      // intent and the bridge never retries a step, so a fresh key per call is the honest choice.
      const keyed = ["hold", "capture", "release", "refund"].includes(name) && !args.idempotencyKey ? { ...args, idempotencyKey: `dash-${randomBytes(12).toString("hex")}` } : args;
      const { structuredContent } = await mcpClient.callTool({ name, arguments: keyed });
      await refreshRemoteState((process.env.SINGIT_MCP_URL ?? "http://127.0.0.1:8787").replace(/\/$/, ""));
      if (structuredContent?.ok === false) return { ok: false, code: structuredContent.code ?? "ERROR", message: structuredContent.reason ?? "MCP tool failed" };
      if (structuredContent?.ok !== true) return { ok: false, code: "ERROR", message: "MCP tool returned no structured result" };
      if (name === "list_audit_log") return { ok: true, result: structuredContent.entries ?? [] };
      return { ok: true, result: structuredContent };
    } catch (e) { return { ok: false, code: e.code ?? "ERROR", message: e.message }; }
  }
  if (!localTools[name]) return { ok: false, code: "INVALID_INPUT", message: `unknown tool ${name}` };
  try { return { ok: true, result: await localTools[name](args) }; }
  catch (e) { return { ok: false, code: e.code ?? "ERROR", message: e.message }; }
}
async function humanResolve({ disputeId, outcome, refundAmount, human = "kostiantyn" }) {
  if (backendFailure || backendConnecting) return { ok: false, code: "BACKEND_UNAVAILABLE", message: backendFailure ?? "MCP is connecting" };
  if (impl.kind === "mcp-http") {
    const secret = process.env.SINGIT_HUMAN_ROUTE_SECRET;
    if (!secret) return { ok: false, code: "HUMAN_ROUTE_SECRET_UNSET", message: "SINGIT_HUMAN_ROUTE_SECRET is not set on the dashboard bridge" };
    const base = (process.env.SINGIT_MCP_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
    // Matches the committed human route in singit-mcp http.ts at f539ed8.
    try {
      const body = { disputeId, outcome, ...(outcome === "refund" ? { refundAmount: String(refundAmount ?? 0) } : {}), actor: "human:kostiantyn" };
      const r = await fetch(base + "/human/resolve", { method: "POST", headers: { "x-singit-human-secret": secret, "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      await refreshRemoteState(base);
      if (r.status === 403 && data.code === "HUMAN_ROUTE_DISABLED") return { ok: false, code: data.code, message: "singit-mcp human route disabled: set SINGIT_HUMAN_ROUTE_SECRET (>=16 chars) on the MCP server" };
      if (r.status === 401 && data.code === "HUMAN_AUTH_REQUIRED") return { ok: false, code: data.code, message: "wrong human route secret" };
      if (r.status === 409 || r.status === 400) return { ok: false, code: data.code ?? "HUMAN_ROUTE_ERROR", message: data.reason ?? data.message ?? "human route refused the request" };
      if (!r.ok) return { ok: false, code: data.code ?? "HUMAN_ROUTE_ERROR", message: data.reason ?? data.message ?? "human route returned an HTTP error" };
      return { ok: true, result: { dispute: data.dispute, txSig: data.txSig } };
    } catch (e) { return { ok: false, code: "HUMAN_ROUTE_ERROR", message: e.message }; }
  }
  const amt = outcome === "refund" ? BigInt(refundAmount ?? 0) : 0n;
  const serviceOutcome = outcome === "refund" ? "refund" : "reject";
  const approvalToken = impl.issue(SECRET, { disputeId, outcome: serviceOutcome, refundAmount: amt.toString() });
  try {
    const r = await svc.resolveDispute({ actor: human, disputeId, outcome: serviceOutcome, refundAmount: outcome === "refund" ? amt : undefined, approvalToken });
    disputes.set(disputeId, { ...disputes.get(disputeId), ...r, status: "resolved", outcome: serviceOutcome });
    return { ok: true, result: r };
  } catch (e) { return { ok: false, code: e.code ?? "ERROR", message: e.message }; }
}
function snapshot() {
  const mandates = (impl.kind === "mcp-http" ? remoteCache.mandates : (typeof svc.listMandates === "function" ? svc.listMandates() : mandateIds.map((id) => svc.getMandate(id)))).map(normalizeMandate);
  const listedDisputes = impl.kind === "mcp-http" ? remoteCache.disputes : (typeof svc.listDisputes === "function" ? svc.listDisputes() : [...disputes.values()]);
  const holdById = new Map(mandates.flatMap((m) => (m.holds ?? []).map((h) => [h.id, h])));
  const normalizedDisputes = listedDisputes.map((d) => {
    const hold = holdById.get(d.holdId);
    const suggestedRefund = hold
      ? (BigInt(hold.captured ?? 0) - BigInt(hold.refunded ?? 0)).toString()
      : (d.suggestedRefund == null ? d.suggestedRefund : String(d.suggestedRefund));
    return { ...d, suggestedRefund, refundAmount: d.refundAmount == null ? d.refundAmount : String(d.refundAmount), txRefs: d.txSigs ?? d.txRefs ?? [] };
  });
  const audit = getAudit(), timeline = deriveTimeline(audit, mandates);
  const ops = impl.kind === "mcp-http" ? remoteCache.ops : (typeof svc.listOperations === "function" ? svc.listOperations() : typeof svc.listOps === "function" ? svc.listOps() : undefined);
  const sigPattern = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
  const realSig = audit.some((a) => sigPattern.test(String(a.txSig ?? ""))) || mandates.some((m) => m.holds?.some((h) => [h.lastTxSig, ...(h.txSigs ?? [])].some((r) => sigPattern.test(String(r ?? ""))))) || normalizedDisputes.some((d) => [...(d.txRefs ?? []), ...(d.txSigs ?? [])].some((r) => sigPattern.test(String(r))));
  const chain = backendFailure ? "unavailable" : impl.kind === "mcp-http" ? (remoteCache.backend === "devnet" ? "devnet" : "mock") : realSig ? "devnet" : "mock";
  const storyBlocker = backendFailure ?? (backendConnecting ? "Waiting for MCP" : chain === "devnet" && !liveAgents() ? "Set the payer and merchant public addresses on the dashboard bridge" : null);
  const escrow = chain === "mock" ? "escrow (mock)" : "on-chain escrow";
  return { backend: backendConnecting ? "connecting" : impl.kind, chain, backendNote, storyBlocker, cluster: CLUSTER, mandates, disputes: normalizedDisputes, timeline, audit, ...(Array.isArray(ops) ? { ops: ops.map(publicOperation) } : {}), story: { ...story, caption: story.caption.replaceAll("{escrow}", escrow) } };
}

// ---------- demo story ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_DELAY_MS = 7000;
async function waitForNext(gen) {
  let remaining = story.delayMs ?? Infinity, last = Date.now();
  while (gen === storyGen) { if (story.nextReq) { story.nextReq = false; break; } const now = Date.now(); if (!story.paused) remaining -= now - last; last = now; story.nextInMs = Number.isFinite(remaining) ? Math.max(0, remaining) : null; if (remaining <= 0) break; await sleep(80); }
  story.nextInMs = null; return gen === storyGen;
}
async function runStory({ delay = DEFAULT_DELAY_MS, autoApprove = false, mode = "presenter" } = {}) {
  if (storyStartBlocker(snapshot())) return { ok: false, code: "NOT_IDLE", message: "The current state does not allow a new story" };
  const gen = storyGen, now = Math.floor(Date.now() / 1000); let mandateId, h1, h2, disputeId;
  const AGENTS = snapshot().chain === "devnet" ? liveAgents() : MOCK_AGENTS;
  if (!AGENTS) throw Error("Live story requires payer and merchant public addresses");
  const steps = [
    ["Mandate: 10 USDC, 4 USDC/tx, 2 h", snapshot().chain === "devnet" ? "One payer wallet and one merchant wallet; the merchant supplies both dataset and GPU roles." : "A human gives research-bot a spending mandate — budget, per-tx cap, expiry, allowed sellers.", async () => { const r = await callTool("create_mandate", { actor: "human:kostiantyn", payer: AGENTS.payer, totalBudget: (10n * U).toString(), perTxCap: (4n * U).toString(), expiresAt: now + 7200, allowedCounterparties: [...new Set([AGENTS.vendor, AGENTS.gpu])], note: "Market research sprint" }); if (!r.ok) throw Error(r.message); mandateId = r.result.mandate?.id ?? r.result.id; }],
    ["Hold 3 USDC for data-vendor", "The agent buys a dataset: 3 USDC goes into {escrow}, not straight to the seller.", async () => { const r = await callTool("hold", { actor: AGENTS.payer, mandateId, payee: AGENTS.vendor, amount: (3n * U).toString() }); if (!r.ok) throw Error(`${r.code}: ${r.message}`); h1 = pickHoldId(r.result); if (!h1) throw Error("Hold returned no payment ID"); }],
    ["Data-vendor captures 2.5 USDC", "The seller delivers and captures only what the job actually cost.", async () => callTool("capture", { actor: AGENTS.vendor, holdId: h1, amount: "2500000" })],
    ["0.5 USDC released to payer", "The unused remainder goes back to the payer — and back into the budget.", async () => callTool("release", { actor: AGENTS.vendor, holdId: h1 })],
    ["Hold 4 USDC for gpu-broker", "Second purchase: a GPU job, held at exactly the per-transaction cap.", async () => { const r = await callTool("hold", { actor: AGENTS.payer, mandateId, payee: AGENTS.gpu, amount: (4n * U).toString() }); if (!r.ok) throw Error(`${r.code}: ${r.message}`); h2 = pickHoldId(r.result); if (!h2) throw Error("Hold returned no payment ID"); }],
    ["GPU-broker captures 4 USDC", "The GPU seller captures the full 4 USDC.", async () => callTool("capture", { actor: AGENTS.gpu, holdId: h2, amount: (4n * U).toString() })],
    ["5 USDC hold → BLOCKED: over per-tx cap", "A single 5 USDC hold breaks the 4 USDC per-transaction cap — refused before any money moves.", async () => callTool("hold", { actor: AGENTS.payer, mandateId, payee: AGENTS.vendor, amount: "5000000" }), "OVER_PER_TX_CAP"],
    ["Unknown seller → BLOCKED", "The agent tries to hold for a seller that isn't on the mandate — refused before any money moves.", async () => callTool("hold", { actor: AGENTS.payer, mandateId, payee: AGENTS.rogue, amount: "1000000" }), "COUNTERPARTY_NOT_ALLOWED"],
    ["4 USDC more → BLOCKED: over budget", "Only 3.5 USDC is left, so a 4 USDC hold is blocked — and written to the audit log.", async () => callTool("hold", { actor: AGENTS.payer, mandateId, payee: AGENTS.vendor, amount: (4n * U).toString() }), "OVER_BUDGET"],
    ["Data-vendor refunds 0.5 USDC", "A goodwill refund from the seller. Refunds never re-open the budget.", async () => callTool("refund", { actor: AGENTS.vendor, holdId: h1, amount: "500000" })],
    ["Research-bot opens a dispute", "The GPU job came back empty: the agent disputes it, and SingIt stops captures on the hold pending a human decision.", async () => { const r = await callTool("open_dispute", { actor: AGENTS.payer, holdId: h2, reason: "GPU job returned empty results", evidence: ["job-7f3a: output.parquet 0 rows", "SLA: non-empty dataset"] }); if (!r.ok) throw Error(`${r.code}: ${r.message}`); disputeId = r.result.dispute?.id ?? r.result.id; if (!disputeId) throw Error("Dispute returned no ID"); }],
    ["Agent tries to settle its own dispute → BLOCKED", "The agent tries to approve its own refund — no token, then a forged token. Both refused: only a human can approve.", async () => {
      for (const approvalToken of ["", "f".repeat(64)]) {
        const r = await callTool("resolve_dispute", { actor: AGENTS.payer, disputeId, outcome: "refund", refundAmount: "4000000", approvalToken });
        if (r.ok || r.code !== "HUMAN_APPROVAL_REQUIRED") throw Error(`expected human approval refusal, received ${r.code ?? "success"}`);
      }
    }],
  ];
  story = { state: "running", step: 0, total: steps.length + 1, label: "", caption: "", mode, delayMs: delay, paused: false, nextReq: false, nextInMs: null };
  for (const [label, caption, fn, expectedCode] of steps) {
    if (gen !== storyGen) return;
    story.step++; story.label = label; story.caption = caption;
    const result = await fn();
    if (expectedCode && (result?.ok !== false || result.code !== expectedCode)) throw Error(`Expected ${expectedCode}; received ${result?.code ?? "success"}`);
    if (!expectedCode && result?.ok === false) throw Error(`${result.code}: ${result.message}`);
    if (!(await waitForNext(gen))) return;
  }
  story.step++; story.state = "awaiting-human"; story.label = `Human decision on dispute ${disputeId}`; story.caption = "No agent can settle this. A human approves or rejects through the human route.";
  if (autoApprove) { await sleep(Number.isFinite(delay) ? delay : 0); if (gen === storyGen) { const result = await humanResolve({ disputeId, outcome: "refund", refundAmount: (4n * U).toString() }); if (!result.ok) throw Error(`${result.code}: ${result.message}`); markDone(); } }
}
function markDone() { if (story.state === "awaiting-human") { story.state = "done"; story.label = "Story complete"; story.caption = "Every step, including blocked attempts, is in the audit log."; } }
const parseDelay = (v) => (v === null || v === "manual" ? Infinity : v === undefined ? DEFAULT_DELAY_MS : Number(v));

// ---------- HTTP ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v === Infinity ? null : v))); };
const readBody = async (req) => { let s = ""; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; };
createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, snapshot());
    if (req.method === "POST" && url.pathname === "/api/reset") {
      if (impl.kind === "mcp-http") {
        const r = await resetRemote();
        return json(res, r.ok ? 200 : r.code === "RESET_MOCK_ONLY" ? 409 : r.code === "HUMAN_AUTH_REQUIRED" ? 401 : r.code === "HUMAN_ROUTE_DISABLED" ? 403 : r.code === "HUMAN_ROUTE_SECRET_UNSET" ? 500 : 502, r);
      }
      reset();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/story") {
      const b = await readBody(req), current = snapshot();
      if (current.storyBlocker) return json(res, 503, { ok: false, code: "BACKEND_UNAVAILABLE", message: current.storyBlocker });
      if (current.chain === "devnet" && (b.confirmedDevnet !== true || b.autoApprove)) return json(res, 409, { ok: false, code: "DEVNET_CONFIRMATION_REQUIRED", message: "Confirm the 7 USDC gross devnet story; dispute resolution requires a separate human click" });
      const blocker = storyStartBlocker(current);
      if (blocker) return json(res, 409, { ok: false, code: "NOT_IDLE", message: blocker });
      runStory({ delay: parseDelay(b.delay), autoApprove: !!b.autoApprove, mode: b.mode ?? "presenter" }).catch((e) => { story.state = "error"; story.label = e.message; });
      return json(res, 202, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/story/next") { if (story.state !== "running") return json(res, 200, { ok: false, code: story.state === "awaiting-human" ? "AWAITING_HUMAN" : "NOT_RUNNING" }); story.nextReq = true; return json(res, 200, { ok: true }); }
    if (req.method === "POST" && url.pathname === "/api/story/pause") { const b = await readBody(req); story.paused = b.paused ?? !story.paused; return json(res, 200, { ok: true, paused: story.paused }); }
    if (req.method === "POST" && url.pathname === "/api/story/pace") { const b = await readBody(req); story.delayMs = parseDelay(b.delay); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && url.pathname === "/api/human/resolve") { const r = await humanResolve(await readBody(req)); if (r.ok) markDone(); return json(res, 200, r); }
    const m = url.pathname.match(/^\/api\/tool\/([a-z_]+)$/);
    if (req.method === "POST" && m) { if (m[1] === "resolve_dispute") return json(res, 403, { ok: false, code: "HUMAN_ONLY", message: "use the human console (/api/human/resolve)" }); const r = await callTool(m[1], await readBody(req)); return json(res, 200, r.ok ? r : { ...r, message: r.message ?? r.reason }); }
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1); if (file.includes("..")) return json(res, 400, { error: "bad path" }); const data = await readFile(join(ROOT, "public", file)); res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }); res.end(data);
  } catch (e) { if (e.code === "ENOENT") return json(res, 404, { error: "not found" }); json(res, 500, { error: e.message }); }
}).listen(PORT, "127.0.0.1", () => console.log(`[dashboard] http://127.0.0.1:${PORT}`));
