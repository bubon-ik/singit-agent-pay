// Local stand-in for singit-mcp's PaymentService + MockBackend.
// Same method names, refusal codes, audit v1, and budget semantics:
//   committed = held + captured over the mandate's holds; release lowers it,
//   refund does NOT (capture402 refunds never restore the authorization budget).
// Amounts are USDC base units (6 decimals) as bigint.
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";

export class Refusal extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const formatUsdc = (b) => {
  const neg = b < 0n; const v = neg ? -b : b;
  let frac = (v % 1_000_000n).toString().padStart(6, "0");
  while (frac.length > 2 && frac.endsWith("0")) frac = frac.slice(0, -1);
  return `${neg ? "-" : ""}${v / 1_000_000n}.${frac} USDC`;
};

export function issueApprovalToken(secret, { disputeId, outcome, refundAmount }) {
  return createHmac("sha256", secret).update(`singit-dispute-v1|${disputeId}|${outcome}|${refundAmount ?? "0"}`).digest("hex");
}
function verifyApprovalToken(secret, decision, token) {
  const want = Buffer.from(issueApprovalToken(secret, decision), "hex");
  const got = Buffer.from(String(token ?? ""), "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** In-memory escrow mirroring capture402 checks (authorize/capture/void/refund). */
export class LocalMockBackend {
  name = "mock";
  #n = 0; #tx = 0; #holds = new Map();
  constructor({ now = () => Math.floor(Date.now() / 1000), balances = {} } = {}) {
    this.now = now; this.balances = new Map(Object.entries(balances));
  }
  #bal(a) { return this.balances.get(a) ?? 0n; }
  #err(code, msg) { const e = new Error(msg); e.code = code; return e; }
  #guard(h, eh, er) { if (h.held !== eh || h.refundable !== er) throw this.#err("unexpected_payment_state", "expectedHeld/expectedRefundable mismatch"); }
  async createMandate() { return {}; }
  async hold({ payer, payee, maximum, captureDeadline, refundDeadline }) {
    const now = this.now();
    if (payer === payee) throw this.#err("payer_is_payee", "payer == payee");
    if (maximum <= 0n) throw this.#err("amount", "maximum must be > 0");
    if (!(now < captureDeadline && captureDeadline <= refundDeadline)) throw this.#err("deadlines", "bad deadlines");
    if (this.#bal(payer) < maximum) throw this.#err("insufficient_funds", "payer balance too low");
    this.balances.set(payer, this.#bal(payer) - maximum);
    const holdId = `mock-hold-${++this.#n}`;
    this.#holds.set(holdId, { holdId, payer, payee, maximum, held: maximum, refundable: 0n, captureDeadline, refundDeadline });
    return { holdId, txRef: `mock-tx-${++this.#tx}` };
  }
  async capture({ holdId, amount, releaseRemainder, expectedHeld, expectedRefundable }) {
    const h = this.#holds.get(holdId); this.#guard(h, expectedHeld, expectedRefundable);
    if (this.now() >= h.captureDeadline) throw this.#err("capture_deadline_expired", "capture deadline passed");
    if (amount <= 0n || amount > h.held) throw this.#err("amount", "bad capture amount");
    h.held -= amount; h.refundable += amount;
    this.balances.set(h.payee, this.#bal(h.payee) + amount);
    if (releaseRemainder) { this.balances.set(h.payer, this.#bal(h.payer) + h.held); h.held = 0n; }
    return { txRef: `mock-tx-${++this.#tx}` };
  }
  async release({ holdId, expectedHeld, expectedRefundable }) {
    const h = this.#holds.get(holdId); this.#guard(h, expectedHeld, expectedRefundable);
    if (h.held === 0n) throw this.#err("amount", "nothing held");
    this.balances.set(h.payer, this.#bal(h.payer) + h.held); h.held = 0n;
    return { txRef: `mock-tx-${++this.#tx}` };
  }
  async refund({ holdId, amount, expectedHeld, expectedRefundable }) {
    const h = this.#holds.get(holdId); this.#guard(h, expectedHeld, expectedRefundable);
    if (this.now() >= h.refundDeadline) throw this.#err("refund_deadline_expired", "refund deadline passed");
    if (amount <= 0n || amount > h.refundable) throw this.#err("amount", "bad refund amount");
    if (this.#bal(h.payee) < amount) throw this.#err("insufficient_funds", "merchant ATA too low");
    this.balances.set(h.payee, this.#bal(h.payee) - amount); this.balances.set(h.payer, this.#bal(h.payer) + amount);
    h.refundable -= amount;
    return { txRef: `mock-tx-${++this.#tx}` };
  }
  async getStatus(holdId) { const h = this.#holds.get(holdId); return h ? { ...h } : null; }
}

export class LocalPaymentService {
  #m = new Map(); #h = new Map(); #d = new Map(); #audit = []; #mn = 0; #dn = 0; #seq = 0;
  constructor({ backend, now = () => Math.floor(Date.now() / 1000), approvalSecret } = {}) {
    this.backend = backend; this.now = now; this.approvalSecret = approvalSecret;
  }
  #log(e) {
    const units = (v) => v == null ? null : (typeof v === "bigint" || typeof v === "number" ? String(v) : v);
    this.#audit.push({ v: 1, seq: ++this.#seq, ts: new Date(this.now() * 1000).toISOString(), actor: e.actor, action: e.action,
      outcome: e.outcome, code: e.code ?? null, reason: e.reason ?? "", mandateId: e.mandateId ?? null, holdId: e.holdId ?? null,
      disputeId: e.disputeId ?? null, amount: units(e.amount), txSig: e.txSig ?? null, held: units(e.held), refundable: units(e.refundable) });
  }
  async #run(base, fn) {
    try { const r = await fn(); return r; }
    catch (err) {
      const refusal = err instanceof Refusal ? err : new Refusal("BACKEND_ERROR", `Backend error (${err.code ?? "unknown"}): ${err.message}`);
      this.#log({ ...base, outcome: refusal.code === "BACKEND_ERROR" ? "error" : "blocked", code: refusal.code, reason: refusal.message });
      throw refusal;
    }
  }
  #mandate(id) { const m = this.#m.get(id); if (!m) throw new Refusal("MANDATE_NOT_FOUND", `Mandate ${id} not found`); return m; }
  #hold(id) { const h = this.#h.get(id); if (!h) throw new Refusal("HOLD_NOT_FOUND", `Hold ${id} not found`); return h; }
  #auditBase({ actor, action, mandateId, holdId, disputeId, amount }, outcome, code, reason, more = {}) { return { actor, action, mandateId, holdId, disputeId, amount, outcome, code, reason, ...more }; }

  async createMandate({ actor, payer, totalBudget, perTxCap, expiresAt, allowedCounterparties, note }) {
    return this.#run(this.#auditBase({ actor, action: "create_mandate", amount: totalBudget }, null, null, ""), async () => {
      if (perTxCap <= 0n || perTxCap > totalBudget) throw new Refusal("INVALID_INPUT", "perTxCap must be > 0 and <= totalBudget");
      if (expiresAt <= this.now()) throw new Refusal("INVALID_INPUT", "expiresAt must be in the future");
      if (!allowedCounterparties?.length) throw new Refusal("INVALID_INPUT", "allowedCounterparties must be non-empty");
      const m = { id: `m-${++this.#mn}`, payer, totalBudget, perTxCap, expiresAt, allowedCounterparties, committed: 0n, createdAt: this.now(), note };
      await this.backend.createMandate(m);
      this.#m.set(m.id, m);
      this.#log(this.#auditBase({ actor, action: "create_mandate", mandateId: m.id, amount: totalBudget }, "ok", null, `budget ${formatUsdc(totalBudget)}, per-tx cap ${formatUsdc(perTxCap)}`));
      return m;
    });
  }
  getMandate(id) {
    const m = this.#mandate(id);
    return { mandate: m, remaining: m.totalBudget - m.committed, holds: [...this.#h.values()].filter((h) => h.mandateId === id) };
  }
  listMandates() { return [...this.#m.keys()].map((id) => this.getMandate(id)); }
  listDisputes() { return [...this.#d.values()]; }
  async hold({ actor, mandateId, payee, amount, captureDeadline, refundDeadline }) {
    return this.#run(this.#auditBase({ actor, action: "hold", mandateId, amount }, null, null, ""), async () => {
      const m = this.#mandate(mandateId);
      if (actor !== m.payer) throw new Refusal("NOT_PAYER", `${actor} is not the payer of mandate ${m.id}`);
      if (this.now() >= m.expiresAt) throw new Refusal("MANDATE_EXPIRED", `Mandate ${m.id} expired`);
      if (!m.allowedCounterparties.includes(payee)) throw new Refusal("COUNTERPARTY_NOT_ALLOWED", `${payee} is not an allowed counterparty on mandate ${m.id}`);
      if (amount <= 0n) throw new Refusal("INVALID_INPUT", "amount must be > 0");
      if (amount > m.perTxCap) throw new Refusal("OVER_PER_TX_CAP", `over per-tx cap: ${formatUsdc(amount)} exceeds ${formatUsdc(m.perTxCap)} on mandate ${m.id}`);
      const remaining = m.totalBudget - m.committed;
      if (amount > remaining) throw new Refusal("OVER_BUDGET", `over budget: hold ${formatUsdc(amount)} but only ${formatUsdc(remaining)} of ${formatUsdc(m.totalBudget)} of mandate ${m.id} remains`);
      const cd = captureDeadline ?? m.expiresAt; const rd = refundDeadline ?? cd + 7 * 86400;
      if (cd > m.expiresAt || cd <= this.now()) throw new Refusal("INVALID_INPUT", "captureDeadline must be in (now, mandate.expiresAt]");
      const r = await this.backend.hold({ payer: m.payer, payee, maximum: amount, captureDeadline: cd, refundDeadline: rd, salt: randomBytes(32).toString("hex") });
      const txSig = r.txSig ?? r.txRef;
      const h = { id: r.holdId, mandateId, payer: m.payer, payee, maximum: amount, held: amount, captured: 0n, refunded: 0n, captureDeadline: cd, refundDeadline: rd, status: "held", txRef: txSig, lastTxSig: txSig, txSigs: [txSig] };
      this.#h.set(h.id, h); m.committed += amount;
      this.#log(this.#auditBase({ actor, action: "hold", mandateId, holdId: h.id, amount }, "ok", null, `escrow hold for ${payee} (tx ${txSig})`, { txSig, held: h.held, refundable: h.captured - h.refunded }));
      return { ...h };
    });
  }
  async capture({ actor, holdId, amount, releaseRemainder = false }) {
    return this.#run(this.#auditBase({ actor, action: "capture", holdId, amount }, null, null, ""), async () => {
      const h = this.#hold(holdId); const m = this.#m.get(h.mandateId);
      if (actor !== h.payee) throw new Refusal("NOT_PAYEE", `${actor} is not the payee of ${holdId}`);
      if (h.disputeId && this.#d.get(h.disputeId)?.status === "open") throw new Refusal("DISPUTE_OPEN", `Hold ${holdId} has an open dispute`);
      if (this.now() >= h.captureDeadline) throw new Refusal("CAPTURE_DEADLINE_PASSED", "capture deadline passed");
      if (amount <= 0n || amount > h.held) throw new Refusal("CAPTURE_EXCEEDS_HOLD", `Capture ${formatUsdc(amount)} exceeds held ${formatUsdc(h.held)}`);
      const r = await this.backend.capture({ holdId, amount, releaseRemainder, expectedHeld: h.held, expectedRefundable: h.captured - h.refunded });
      const released = releaseRemainder ? h.held - amount : 0n;
      h.held -= amount + released; h.captured += amount; m.committed -= released;
      if (h.held === 0n) h.status = "settled";
      const txSig = r.txSig ?? r.txRef; h.txRef = txSig; h.lastTxSig = txSig; h.txSigs.push(txSig);
      this.#log(this.#auditBase({ actor, action: "capture", mandateId: m.id, holdId, amount }, "ok", null, `captured (tx ${txSig})`, { txSig, held: h.held, refundable: h.captured - h.refunded }));
      return { ...h, txRef: txSig };
    });
  }
  async release({ actor, holdId }) {
    return this.#run(this.#auditBase({ actor, action: "release", holdId }, null, null, ""), async () => {
      const h = this.#hold(holdId); const m = this.#m.get(h.mandateId);
      if (actor !== h.payee && !actor.startsWith("human-approved:")) throw new Refusal("NOT_PAYEE", `${actor} is not the payee of ${holdId}`);
      if (h.held === 0n) throw new Refusal("NOTHING_HELD", `Nothing held on ${holdId}`);
      const r = await this.backend.release({ holdId, expectedHeld: h.held, expectedRefundable: h.captured - h.refunded });
      const amt = h.held; m.committed -= amt; h.held = 0n; h.status = "settled";
      const txSig = r.txSig ?? r.txRef; h.txRef = txSig; h.lastTxSig = txSig; h.txSigs.push(txSig);
      this.#log(this.#auditBase({ actor, action: "release", mandateId: m.id, holdId, amount: amt }, "ok", null, `remainder returned to payer (tx ${txSig})`, { txSig, held: h.held, refundable: h.captured - h.refunded }));
      return { ...h, released: amt, txRef: txSig };
    });
  }
  async refund({ actor, holdId, amount }) {
    return this.#run(this.#auditBase({ actor, action: "refund", holdId, amount }, null, null, ""), async () => {
      const h = this.#hold(holdId);
      if (actor !== h.payee && !actor.startsWith("human-approved:")) throw new Refusal("NOT_PAYEE", `${actor} is not the payee of ${holdId}`);
      if (this.now() >= h.refundDeadline) throw new Refusal("REFUND_DEADLINE_PASSED", "refund deadline passed");
      if (amount <= 0n || amount > h.captured - h.refunded) throw new Refusal("REFUND_EXCEEDS_CAPTURED", `Refund ${formatUsdc(amount)} exceeds refundable ${formatUsdc(h.captured - h.refunded)}`);
      const r = await this.backend.refund({ holdId, amount, expectedHeld: h.held, expectedRefundable: h.captured - h.refunded });
      h.refunded += amount;
      const txSig = r.txSig ?? r.txRef; h.txRef = txSig; h.lastTxSig = txSig; h.txSigs.push(txSig);
      this.#log(this.#auditBase({ actor, action: "refund", mandateId: h.mandateId, holdId, amount }, "ok", null, `refunded from merchant (tx ${txSig}); budget not restored`, { txSig, held: h.held, refundable: h.captured - h.refunded }));
      return { ...h, txRef: txSig };
    });
  }
  async openDispute({ actor, holdId, reason, evidence = [] }) {
    return this.#run(this.#auditBase({ actor, action: "open_dispute", holdId }, null, null, ""), async () => {
      const h = this.#hold(holdId);
      if (actor !== h.payer) throw new Refusal("NOT_PAYER", `${actor} is not the payer of ${holdId}`);
      if (h.disputeId && this.#d.get(h.disputeId)?.status === "open") throw new Refusal("DISPUTE_OPEN", `Hold ${holdId} already has an open dispute`);
      const d = { id: `d-${++this.#dn}`, holdId, mandateId: h.mandateId, openedBy: actor, reason, evidence, status: "open" };
      this.#d.set(d.id, d); h.disputeId = d.id;
      this.#log(this.#auditBase({ actor, action: "open_dispute", mandateId: h.mandateId, holdId, disputeId: d.id }, "ok", null, reason, { held: h.held, refundable: h.captured - h.refunded }));
      return { ...d };
    });
  }
  async resolveDispute({ actor, disputeId, outcome, refundAmount, approvalToken }) {
    return this.#run(this.#auditBase({ actor: `human-approved:${actor}`, action: "resolve_dispute", disputeId }, null, null, ""), async () => {
      if (!approvalToken) throw new Refusal("HUMAN_APPROVAL_REQUIRED", "a human approval token is required to resolve a dispute");
      if (!this.approvalSecret || this.approvalSecret.length < 16) throw new Refusal("HUMAN_APPROVAL_REQUIRED", "invalid human approval token");
      const d = this.#d.get(disputeId); if (!d) throw new Refusal("DISPUTE_NOT_FOUND", `Dispute ${disputeId} not found`);
      if (d.status !== "open") throw new Refusal("DISPUTE_ALREADY_RESOLVED", `Dispute ${disputeId} already resolved`);
      const amt = outcome === "refund" ? (refundAmount ?? 0n) : 0n;
      if (!verifyApprovalToken(this.approvalSecret, { disputeId, outcome, refundAmount: amt.toString() }, approvalToken)) throw new Refusal("HUMAN_APPROVAL_REQUIRED", "invalid human approval token");
      const who = `human-approved:${actor}`; const txRefs = [];
      if (outcome === "refund") {
        const h = this.#h.get(d.holdId);
        d.status = "resolving";
        if (h.held > 0n) txRefs.push((await this.release({ actor: who, holdId: h.id })).txRef);
        if (amt > 0n) txRefs.push((await this.refund({ actor: who, holdId: h.id, amount: amt })).txRef);
      }
      Object.assign(d, { status: "resolved", outcome, refundAmount: amt, resolvedAt: this.now() });
      const hold = this.#h.get(d.holdId);
      d.txSigs = txRefs;
      this.#log(this.#auditBase({ actor: who, action: "resolve_dispute", mandateId: d.mandateId, holdId: d.holdId, disputeId, amount: amt }, "ok", null, `human ${outcome === "refund" ? "approved refund" : "rejected dispute"}`, { txSig: hold?.lastTxSig ?? null, held: hold?.held ?? null, refundable: hold ? hold.captured - hold.refunded : null }));
      return { ...d, txRefs };
    });
  }
  listAuditLog({ mandateId, limit } = {}) {
    let a = this.#audit.filter((e) => !mandateId || e.mandateId === mandateId);
    if (limit) a = a.slice(-limit);
    return a;
  }
}
