export const isRealSig = (s) => /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(String(s ?? ""));

/** A new live story keeps history and requires a fresh confirmation; it never resets a run. */
export function storyStartBlocker(s) {
  if (s.storyBlocker) return s.storyBlocker;
  if (s.story?.state !== "idle") return "The current story must finish before another can start";
  if (s.chain !== "devnet") return s.timeline?.length ? "Results stay on screen — press Reset to replay" : null;
  if (!Array.isArray(s.ops)) return "Operation journal unavailable; check the MCP state";
  if (s.ops.some(op => op.state === "pending" || op.state === "unknown")) return "Resolve the original pending or UNKNOWN operation before a new story";
  if (s.disputes?.some(d => d.status === "open")) return "Decide the existing dispute before a new story";
  return null;
}

export function fmtUsdc(baseUnits) {
  let value;
  try { value = BigInt(baseUnits); } catch { return null; }
  const negative = value < 0n;
  if (negative) value = -value;
  const whole = value / 1_000_000n;
  const fraction = String(value % 1_000_000n).padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""} USDC`;
}

export function activeReservation(ops, mandateId) {
  if (!Array.isArray(ops)) return 0n;
  return ops.reduce((sum, op) => {
    if ((op?.state !== "pending" && op?.state !== "unknown") || (mandateId !== undefined && op?.mandateId !== mandateId)) return sum;
    try { return sum + BigInt(op.reservation); } catch { return sum; }
  }, 0n);
}

const timeValue = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value.trim() !== "" && /^\d+$/.test(value)) {
    const n = Number(value);
    return n < 1e12 ? n * 1000 : n;
  }
  return Date.parse(value);
};

export function opsView(ops, now = Date.now()) {
  if (!Array.isArray(ops)) return null;
  const active = [], recent = [];
  let collapsed = 0;
  const settled = [];
  for (const op of ops) {
    if (op?.state === "pending" || op?.state === "unknown") active.push(op);
    else if (op?.state === "succeeded" || op?.state === "failed") {
      const timestamp = timeValue(op.updatedAt ?? op.createdAt);
      (Number.isFinite(timestamp) && now - timestamp <= 30_000 && now >= timestamp ? recent : settled).push(op);
    }
  }
  const newest = (a, b) => timeValue(b.updatedAt ?? b.createdAt) - timeValue(a.updatedAt ?? a.createdAt);
  active.sort(newest);
  recent.sort(newest);
  collapsed = settled.length;
  const mapItem = (op) => {
    const action = String(op.action ?? "");
    const state = op.state;
    const errorCode = op.error?.refusalCode ?? op.error?.code;
    const labels = { pending: "PENDING", unknown: "OUTCOME UNKNOWN — funds reserved, reconciling", succeeded: "SUCCEEDED", failed: `FAILED${errorCode ? ` · ${errorCode}` : ""}` };
    const params = op.params ?? {};
    // expected.held is the hold's balance AFTER the op, not its amount (always 0 after a release), so it is never shown.
    const rawAmount = params.amount ?? params.refundAmount;
    const txSig = op.prepared?.txSig ?? op.result?.txSig ?? null;
    return {
      id: op.id, action, state,
      cls: ({ pending: "op-pending", unknown: "op-unknown", succeeded: "op-ok", failed: "op-failed" })[state],
      label: labels[state], amount: rawAmount == null ? null : fmtUsdc(rawAmount),
      reservation: fmtUsdc(op.reservation), txSig,
      explorer: isRealSig(txSig) ? `https://explorer.solana.com/tx/${txSig}?cluster=devnet` : null,
      error: op.error?.message ?? null,
    };
  };
  return { active: active.map(mapItem), recent: recent.map(mapItem), collapsed };
}

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);

export function renderOpsHtml(view) {
  if (!view || (!view.active.length && !view.recent.length)) return `<div class="empty">No in-flight operations</div>`;
  const rows = [...view.active, ...view.recent].map((op) => {
    const isActive = op.state === "pending" || op.state === "unknown";
    return `<div class="op ${esc(op.cls)}"><span class="op-label">${op.state === "pending" ? `<span class="spin"></span>` : ""}${esc(op.label)}</span><span class="op-action">${esc(op.action)}</span>${op.amount != null ? `<span>${esc(op.amount)}</span>` : ""}${isActive && op.reservation && op.reservation !== "0 USDC" ? `<span>reserved ${esc(op.reservation)}</span>` : ""}${op.txSig ? op.explorer ? `<a class="tx" target="_blank" rel="noopener noreferrer" href="${esc(op.explorer)}">${esc(op.txSig.slice(0, 8))}…↗</a>` : `<span class="tx">${esc(op.txSig)}</span>` : ""}${op.error ? `<span>${esc(op.error)}</span>` : ""}</div>`;
  }).join("");
  return `${rows}${view.collapsed > 0 ? `<div class="ops-muted">+${view.collapsed} older settled ops hidden</div>` : ""}`;
}
