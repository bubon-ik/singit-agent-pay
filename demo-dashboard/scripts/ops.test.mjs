import test from "node:test";
import assert from "node:assert/strict";
import { activeReservation, fmtUsdc, opsView, renderOpsHtml } from "../public/ops.mjs";
import { deriveTimeline } from "../lib/derive.mjs";

test("operations formatting, reservation, and timeline reconciliation", () => {
  const now = Date.now();
  const sig = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz1234567890".slice(0, 88);
  const state = {
    mandates: [{ id: "m1", totalBudget: "10000000", perTxCap: "4000000", committed: "6000000", remaining: "4000000", holds: [] }],
    ops: [
      { id: "op1", action: "hold", mandateId: "m1", params: { amount: "2000000" }, prepared: { txSig: sig }, reservation: "2000000", state: "unknown", createdAt: now, updatedAt: now },
      { id: "op2", action: "capture", mandateId: "m1", params: { amount: "1000000" }, reservation: "0", state: "succeeded", createdAt: now - 60_000, updatedAt: now - 60_000 },
      { id: "op3", action: "hold", mandateId: "m1", params: { amount: "500000" }, reservation: "500000", state: "pending", createdAt: now, updatedAt: now },
    ],
    audit: [
      { ts: now, action: "OUTCOME_UNKNOWN", outcome: "blocked", code: "OPERATION_UNKNOWN", reason: "BLOCKED: signature not observed", amount: "2000000" },
      { ts: now, action: "reconcile_operation", outcome: "ok", reason: "settled", amount: "2000000" },
      { ts: now, action: "hold", outcome: "blocked", code: "OPERATION_PENDING", reason: "BLOCKED: operation already in flight" },
      { ts: now, action: "hold", outcome: "blocked", code: "OVER_BUDGET", reason: "BLOCKED: over budget" },
    ],
  };
  assert.equal(activeReservation(state.ops, "m1"), 2_500_000n);
  assert.equal(fmtUsdc(activeReservation(state.ops, "m1")), "2.50 USDC");
  const view = opsView(state.ops, now);
  assert.equal(view.active.length, 2);
  assert.equal(view.collapsed, 1);
  assert.match(view.active.find((op) => op.state === "unknown").label, /OUTCOME UNKNOWN/);
  assert.match(view.active.find((op) => op.state === "unknown").explorer, /\?cluster=devnet$/);
  const html = renderOpsHtml(view);
  assert.match(html, /OUTCOME UNKNOWN — funds reserved, reconciling/);
  assert.match(html, /op-unknown/);
  assert.match(html, /spin/);
  assert.ok(html.includes('href="https://explorer.solana.com/tx/'));
  assert.equal(opsView(undefined), null);
  assert.equal(opsView([{ ...state.ops[0], prepared: { txSig: "mock-tx-1" } }], now).active[0].explorer, null);
  assert.equal(fmtUsdc(4_000_000n), "4.00 USDC");
  assert.equal(fmtUsdc(2_500_100n), "2.5001 USDC");

  const timeline = deriveTimeline(state.audit, state.mandates);
  assert.deepEqual(timeline.map((event) => event.kind), ["unknown", "reconcile", "pending", "blocked"]);
  assert.equal(timeline[1].kind, "reconcile");
  assert.match(timeline[3].message, /^BLOCKED: over budget$/);
});

test("accepts unix-seconds timestamps from singit-mcp", () => {
  const ops = [
    { id: "s1", action: "hold", state: "succeeded", reservation: "3000000", params: { amount: "3000000" }, createdAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000) },
    { id: "s2", action: "hold", state: "succeeded", reservation: "0", params: {}, createdAt: Math.floor(Date.now() / 1000) - 120, updatedAt: Math.floor(Date.now() / 1000) - 120 },
    { id: "u1", action: "hold", state: "unknown", reservation: "2000000", params: { amount: "2000000" }, createdAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000) },
  ];
  const view = opsView(ops);
  assert.equal(view.recent.length, 1);
  assert.equal(view.collapsed, 1);
  assert.equal(view.active.length, 1);
  assert.equal(activeReservation(ops), 2_000_000n);
});


test("resolve_dispute titles follow singit-mcp reasons", () => {
  const audit = [
    { seq: 1, ts: 0, action: "resolve_dispute", outcome: "ok", reason: "dispute d-1 resolved: refunded 4.00 USDC", amount: "4000000" },
    { seq: 2, ts: 0, action: "resolve_dispute", outcome: "ok", reason: "dispute d-1 resolved: rejected", amount: null },
    { seq: 3, ts: 0, action: "resolve_dispute", outcome: "ok", reason: "dispute d-1 approved by human: refund 1.00 USDC", amount: "1000000" },
  ];
  const timeline = deriveTimeline(audit, []);
  assert.ok(timeline[0].message.startsWith("Human approved refund"));
  assert.match(timeline[0].message, /4\.00 USDC/);
  assert.equal(timeline[1].message, "Human rejected dispute");
  assert.ok(timeline[2].message.startsWith("Human approved refund"));
  assert.match(timeline[2].message, /1\.00 USDC/);

  const now = Date.now();
  const succeededOp = { id: "s1", action: "hold", state: "succeeded", reservation: "3000000", params: { amount: "3000000" }, createdAt: now - 1000, updatedAt: now - 1000 };
  const html = renderOpsHtml(opsView([succeededOp], now));
  assert.ok(!html.includes("reserved 3.00"));
});
