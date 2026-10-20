// SingIt demo dashboard UI — polls /api/state and renders. No framework, no build step.
import { opsView, renderOpsHtml, activeReservation, fmtUsdc, storyStartBlocker } from "./ops.mjs";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const B = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };
const fmt = (v, d = 2) => { const b = B(v); const n = Number(b) / 1e6; return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: 6 }); };
const pct = (a, t) => (B(t) === 0n ? 0 : Number((B(a) * 10000n) / B(t)) / 100);
const short = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(a ?? "")) ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a ?? "").replace(/^agent:/, "");
const time = (ts) => new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
const CLUSTER = "devnet"; // demo is Solana devnet only

// Devnet explorer slot: real base58 signatures become links; mock refs stay as badges.
function txLink(ref) {
  if (!ref) return "";
  return String(ref).split(",").map((r) => /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(r)
    ? `<a class="tx" target="_blank" href="https://explorer.solana.com/tx/${r}?cluster=${CLUSTER}">${r.slice(0, 8)}…↗</a>`
    : `<span class="tx" title="mock receipt — becomes a Solana Explorer link with Capture402Backend">${esc(r)}</span>`).join(" ");
}

function renderMandate(m, ops) {
  const el = $("mandateCard");
  if (!m) { el.innerHTML = `<div class="card-h"><h2>Mandate</h2></div><div class="empty">No mandate yet</div>`; return; }
  const total = B(m.totalBudget), remaining = B(m.remaining ?? total - B(m.committed));
  const holds = m.holds ?? [];
  const captured = holds.reduce((s, h) => s + B(h.captured), 0n), held = holds.reduce((s, h) => s + B(h.held), 0n);
  const refunded = holds.reduce((s, h) => s + B(h.refunded), 0n);
  const reservation = activeReservation(ops, m.id);
  const exp = new Date(Number(m.expiresAt) * 1000), mins = Math.max(0, Math.round((exp - Date.now()) / 60000));
  el.innerHTML = `
    <div class="card-h"><h2>Mandate ${esc(m.id)}</h2><span class="hint">${esc(m.note ?? "")}</span></div>
    <div class="big">${fmt(remaining)} <small>USDC left of ${fmt(total)}</small></div>
    <div class="meter"><i style="width:${pct(captured, total)}%;background:var(--green)"></i><i style="width:${pct(held, total)}%;background:var(--blue)"></i></div>
    <div class="legend"><span><i class="dot" style="background:var(--green)"></i>captured ${fmt(captured)}</span><span><i class="dot" style="background:var(--blue)"></i>in escrow ${fmt(held)}</span><span><i class="dot" style="background:var(--panel2);border:1px solid var(--line)"></i>free ${fmt(remaining)}</span></div>
    ${reservation > 0n ? `<div class="reserved">reserved ${esc(fmtUsdc(reservation))} (pending)</div>` : ""}
    <div class="kv">
      <div><span>Per-tx cap</span><b>${fmt(m.perTxCap)} USDC</b></div>
      <div><span>Expires</span><b>${exp.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</b><span>in ${mins} min</span></div>
      <div><span>Refunded (budget not restored)</span><b>${fmt(refunded)} USDC</b></div>
    </div>
    <div class="chips"><span class="chip" style="background:#a77bff1a;color:#cdb6ff;border-color:#a77bff33">payer: ${esc(short(m.payer))}</span>${(m.allowedCounterparties ?? []).map((c) => `<span class="chip">✓ ${esc(short(c))}</span>`).join("")}</div>`;
}

function renderHolds(mandates) {
  const holds = mandates.flatMap((m) => m.holds ?? []);
  if (!holds.length) { $("holds").innerHTML = `<div class="empty">No escrow holds yet</div>`; return; }
  $("holds").innerHTML = holds.map((h) => {
    const cap = B(h.captured) > 0n, rel = B(h.held) === 0n && B(h.captured) < B(h.maximum), ref = B(h.refunded) > 0n;
    return `<div class="hold"><div class="hold-h"><span><b>${esc(h.id)}</b> → ${esc(short(h.payee))} ${h.disputeId ? `<span class="status open">dispute ${esc(h.disputeId)}</span>` : ""}</span><span>${fmt(h.maximum)} USDC max · ${esc(h.status)}</span></div>
      <div class="steps"><div class="step on hold">HOLD ${fmt(h.maximum)}</div><div class="step ${cap ? "on capture" : ""}">CAPTURE ${cap ? fmt(h.captured) : "—"}</div>
      <div class="step ${rel ? "on release" : ""}">RELEASE ${rel ? fmt(B(h.maximum) - B(h.captured)) : "—"}</div><div class="step ${ref ? "on refund" : ""}">REFUND ${ref ? fmt(h.refunded) : "—"}</div></div>
      <div class="nums"><span>held <b>${fmt(h.held)}</b></span><span>captured <b>${fmt(h.captured)}</b></span><span>refunded <b>${fmt(h.refunded)}</b></span><span>capture by <b>${time(Number(h.captureDeadline) * 1000)}</b></span><span>refund by <b>${new Date(Number(h.refundDeadline) * 1000).toLocaleDateString("en-GB")}</b></span></div></div>`;
  }).join("");
}

const ICON = { mandate: "M", hold: "⏸", capture: "✓", release: "↩", refund: "$", blocked: "✕", dispute: "!", resolve: "⚖", reset: "↺", unknown: "?", pending: "…", reconcile: "⟳" };
const renderedTimelineKeys = new Set();
function renderTimeline(tl) {
  $("evCount").textContent = `${tl.length} events`;
  $("timeline").innerHTML = tl.slice().reverse().map((e, index) => {
    const key = e.key ?? `${e.ts}:${index}`;
    const isNew = !renderedTimelineKeys.has(key);
    renderedTimelineKeys.add(key);
    return `<li class="ev k-${e.kind}${isNew ? " new" : ""}"><div class="ic">${ICON[e.kind] ?? "•"}</div><div>
    <div class="ev-t">${esc(e.message)}</div>
    <div class="ev-m">${time(e.ts)}${e.amount ? ` · <code>${fmt(e.amount)} USDC</code>` : ""}${e.holdId ? ` · ${esc(e.holdId)}` : ""}${e.payee ? ` · to ${esc(short(e.payee))}` : ""} ${txLink(e.txRef)}</div>
    ${e.detail ? `<div class="ev-m">${esc(e.detail)}</div>` : ""}</div></li>`;
  }).join("") || `<li class="empty">Waiting for agents…</li>`;
}

function renderDispute(disputes) {
  const el = $("disputeCard");
  const currentRefund = $("refAmt");
  const preserveRefund = currentRefund && (document.activeElement === currentRefund || currentRefund.dataset.edited === "true");
  const refundValue = preserveRefund ? currentRefund.value : null;
  const d = disputes.find((x) => x.status === "open") ?? disputes[disputes.length - 1];
  if (!d) {
    el.innerHTML = `<div class="card-h"><h2>Disputes</h2><span class="hint">human in the loop</span></div><div class="empty">No disputes. Payers can dispute a hold and escalate to a human.</div>`;
    return;
  }
  const open = d.status === "open";
  const badge = open ? `<span class="status open">AWAITING HUMAN</span>` : d.outcome === "reject" ? `<span class="status rejected">REJECTED</span>` : `<span class="status resolved">REFUNDED ${fmt(d.refundAmount)} USDC</span>`;
  const refundTx = d.txSig ?? (d.txSigs ?? d.txRefs ?? []).at(-1);
  const decided = !open, refunded = decided && d.outcome === "refund";
  const st = (cls, n, title, sub) => `<div class="fstep ${cls}"><div class="fn">${n}</div><div><div class="ft">${title}</div><div class="fs">${sub}</div></div></div>`;
  const flow = `<div class="flow">
    ${st("done", 1, "Agent opens dispute", `${esc(short(d.openedBy))} disputes ${esc(d.holdId)}`)}
    ${st(decided ? (d.outcome === "reject" ? "bad" : "done") : "wait", 2, "Human approves / rejects", decided ? (d.outcome === "reject" ? "rejected" : "approved") : "waiting for a click")}
    ${st(refunded ? "done" : d.outcome === "reject" ? "skip" : "", 3, "MCP signs refund (server key)", refunded ? "signed for human-approved:kostiantyn" : d.outcome === "reject" ? "not needed" : "pending")}
    ${st(refunded ? "done" : d.outcome === "reject" ? "skip" : "", 4, "Refund tx", refunded ? `${fmt(d.refundAmount)} USDC · ${refundTx ? txLink(refundTx) : "—"}` : d.outcome === "reject" ? "none" : "pending")}
  </div><div class="note">No on-chain arbiter: MCP enforces human approval and signs the refund.</div>`;
  el.innerHTML = `<div class="card-h"><h2>Dispute ${esc(d.id)} · ${esc(d.holdId)}</h2>${badge}</div>
    <div class="reason">“${esc(d.reason)}”</div>
    <ul class="ev-list">${(d.evidence ?? []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    ${flow}
    ${open ? `<div class="btnrow"><input id="refAmt" class="refin" value="${fmt(d.suggestedRefund ?? 0)}" /> <span class="hint">USDC</span>
      <button class="btn approve" id="approve">Approve refund</button><button class="btn reject" id="reject">Reject</button></div>
      <div id="resolveError" class="err" aria-live="polite"></div>
      <div class="human">SingIt refuses captures on this hold (not an on-chain freeze). Approve/Reject uses the human resolution path; agents can never call it themselves.</div>` : ""}`;
  if (open) {
    const input = $("refAmt");
    if (preserveRefund) {
      input.value = refundValue;
      input.dataset.edited = "true";
    }
    input.addEventListener("input", () => { input.dataset.edited = "true"; });
    $("approve").onclick = () => resolve(d.id, "refund", Math.round(Number($("refAmt").value) * 1e6));
    $("reject").onclick = () => resolve(d.id, "reject");
  }
}

function renderAudit(a) {
  $("audit").innerHTML = a.slice().reverse().map((e) => {
    let outcome = e.outcome === "blocked" ? "BLOCKED" : e.outcome?.toUpperCase();
    let outcomeClass = `o-${e.outcome}`;
    if (/outcome_unknown/i.test(e.action ?? "") || e.code === "OPERATION_UNKNOWN") { outcome = "UNKNOWN"; outcomeClass = "o-unknown"; }
    else if (/reconcile/i.test(e.action ?? "")) { outcome = String(e.outcome ?? "").toUpperCase(); outcomeClass = "o-reconcile"; }
    else if (e.code === "OPERATION_PENDING") { outcome = "PENDING"; outcomeClass = "o-pending"; }
    return `<tr><td class="mono">${time(e.ts)}</td><td>${esc(short(e.actor))}</td><td class="mono">${e.action === "reset" ? `<span class="status reset-badge">reset</span>` : esc(e.action)}</td>
    <td class="mono">${esc([e.mandateId, e.holdId, e.disputeId].filter(Boolean).join(" "))}</td><td class="mono">${esc(e.amount == null ? "" : (typeof e.amount === "number" || typeof e.amount === "bigint" || /^\d+$/.test(e.amount)) ? `${fmt(e.amount)} USDC` : e.amount)}</td>
    <td class="${esc(outcomeClass)}">${esc(outcome)}</td><td>${esc(e.reason)}</td></tr>`;
  }).join("") || `<tr><td colspan="7" class="empty">Empty</td></tr>`;
}

async function resolve(disputeId, outcome, refundAmount) {
  const r = await fetch("/api/human/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ disputeId, outcome, refundAmount }) }).then((x) => x.json());
  if (!r.ok) { const err = $("resolveError"); if (err) err.textContent = `${r.code}: ${r.message ?? "Request failed"}`; return; }
  refresh();
}

const cardSignatures = new Map();
let S = null;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2200); }
const post = (p, b = {}) => fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());

async function refresh() {
  const s = (S = await fetch("/api/state").then((r) => r.json()));
  const st = s.story;
  const startBlocker = storyStartBlocker(s);
  // Header badge shows chain state; its tooltip identifies the selected backend mode.
  const b = $("backend"); b.textContent = `backend: ${s.chain}`; b.className = `pill ${s.chain}`;
  $("subtitle").textContent = s.chain === "unavailable" ? s.storyBlocker : `Programmable mandates · ${s.chain === "mock" ? "USDC escrow (mock; live runs use capture402 on Solana devnet)" : "USDC escrow on Solana devnet (capture402)"} · human-approved disputes`;
  const mode = s.backend === "mcp-http" ? "mcp-http" : s.backend === "local" ? "local" : "in-process";
  b.title = `${mode} — ${s.backendNote}${s.chain === "mock" ? " — tx refs are mock receipts" : s.chain === "devnet" ? " — real Solana devnet signatures" : ""}`;
  $("cluster").textContent = "explorer: solana devnet";
  $("stepNo").textContent = st.step; $("stepTotal").textContent = st.total || 13;
  $("storyFill").style.width = `${st.total ? (st.step / st.total) * 100 : 0}%`;
  $("storyLabel").textContent = st.state === "idle" ? (s.timeline.length ? "Manual actions" : "Ready") : st.label;
  $("storyCaption").textContent = st.state === "idle" ? (s.timeline.length ? (s.chain === "devnet" ? "History retained. A new confirmed story creates new payments." : "Results on screen — Reset to replay the story.") : "Press “Run demo story” (or →) to start.") : st.caption ?? "";
  $("countdown").textContent = st.state === "running" ? (st.paused ? "⏸ paused" : st.nextInMs == null ? "manual — press →" : `next in ${(st.nextInMs / 1000).toFixed(1)} s`)
    : st.state === "awaiting-human" ? "waiting for human" : st.state === "done" ? "✓ done" : "idle";
  $("pause").textContent = st.paused ? "▶ Resume" : "⏸ Pause";
  $("pause").disabled = st.state !== "running"; $("next").disabled = !!s.storyBlocker || !(st.state === "running" || !startBlocker);
  $("next").textContent = st.state === "idle" ? "Start ▶" : "Next step ▶";
  $("run").disabled = !!startBlocker;
  $("run").textContent = s.chain === "devnet" ? "▶ Run devnet story" : "▶ Run demo story";
  $("run").title = startBlocker ?? "";
  $("reset").disabled = s.chain === "devnet" || !!s.storyBlocker;
  const renderIfChanged = (name, data, render) => {
    const signature = JSON.stringify(data);
    if (cardSignatures.get(name) === signature) return;
    cardSignatures.set(name, signature);
    render();
  };
  const mandate = s.mandates.at(-1) ?? null;
  const reservation = activeReservation(s.ops, mandate?.id);
  renderIfChanged("mandate", { mandate, reservation: reservation.toString() }, () => renderMandate(mandate, s.ops));
  const opsCard = $("opsCard");
  if (Array.isArray(s.ops)) {
    opsCard.hidden = false;
    renderIfChanged("ops", { ops: opsView(s.ops), bucket: Math.floor(Date.now() / 5000) }, () => { $("ops").innerHTML = renderOpsHtml(opsView(s.ops)); });
  } else opsCard.hidden = true;
  renderIfChanged("holds", s.mandates.map((m) => m.holds ?? []), () => renderHolds(s.mandates));
  renderIfChanged("timeline", s.timeline, () => renderTimeline(s.timeline));
  const refundInput = $("refAmt");
  const preserveDisputePanel = refundInput && (document.activeElement === refundInput || refundInput.dataset.edited === "true");
  const openDisputeId = s.disputes.find((d) => d.status === "open")?.id;
  const disputeSignatureData = preserveDisputePanel
    ? { openDisputeId }
    : s.disputes;
  if (!preserveDisputePanel || cardSignatures.get("dispute") === JSON.stringify(disputeSignatureData)) {
    renderIfChanged("dispute", disputeSignatureData, () => renderDispute(s.disputes));
  }
  renderIfChanged("audit", s.audit, () => renderAudit(s.audit));
}

// Pace: ?delay=7|8.5|12|manual (seconds) or ?mode=fast; also the dropdown.
const q = new URLSearchParams(location.search);
if (q.get("mode") === "fast") $("pace").value = "fast";
else if (q.get("delay")) { const v = q.get("delay"); if (![...$("pace").options].some((o) => o.value === v)) $("pace").add(new Option(`Presenter · ${v} s/step`, v)); $("pace").value = v; }
const paceBody = () => { const v = $("pace").value; return v === "fast" ? { delay: 1100, mode: "auto" } : v === "manual" ? { delay: "manual", mode: "presenter" } : { delay: Math.round(Number(v) * 1000), mode: "presenter" }; };

async function start() {
  if (S?.storyBlocker) return toast(S.storyBlocker);
  const confirmedDevnet = S?.chain === "devnet";
  if (confirmedDevnet && !window.confirm("Run the Solana devnet story? It authorizes 7 test USDC across two holds, captures 6.5 and returns 0.5 before the dispute. A separate human click can refund another 4 USDC. SOL pays transaction fees and rent. Both seller roles use the configured merchant wallet.")) return;
  const r = await post("/api/story", { ...paceBody(), confirmedDevnet });
  if (r.ok === false) toast(r.message); refresh();
}
async function next() {
  if (!S) return;
  if (S.story.state === "idle") return storyStartBlocker(S) ? toast(storyStartBlocker(S)) : start();
  if (S.story.state === "awaiting-human") return toast("Waiting for the human: Approve (A) or Reject (R)");
  if (S.story.state === "done") return toast("Story complete — results stay until Reset");
  await post("/api/story/next"); refresh();
}
const openDispute = () => S?.disputes.find((d) => d.status === "open");

$("run").onclick = start;
$("next").onclick = next;
$("pause").onclick = async () => { await post("/api/story/pause"); refresh(); };
$("pace").onchange = async () => { if (S?.story.state === "running") await post("/api/story/pace", { delay: paceBody().delay }); };
$("reset").onclick = async () => {
  const r = await post("/api/reset");
  if (!r.ok) {
    toast(`Reset failed — ${r.code ?? "ERROR"}: ${r.message ?? "Request failed"}`);
    return;
  }
  cardSignatures.clear();
  renderedTimelineKeys.clear();
  refresh();
  toast("Reset — ready to replay");
};
document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input,select,textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === "ArrowRight" || k === " ") { e.preventDefault(); next(); }
  else if (k === "ArrowLeft") { e.preventDefault(); toast("No rewind — press Reset to replay the story"); }
  else if (k === "p" || k === "P") { if (S?.story.state === "running") post("/api/story/pause").then(refresh); }
  else if (k === "a" || k === "A") { const d = openDispute(); d ? $("approve")?.click() : toast("No open dispute"); }
  else if (k === "r" || k === "R") { const d = openDispute(); d ? $("reject")?.click() : toast("No open dispute"); }
});
refresh(); setInterval(refresh, 250);
