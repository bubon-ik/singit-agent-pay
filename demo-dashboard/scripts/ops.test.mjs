import test from "node:test";
import assert from "node:assert/strict";
import { activeReservation, fmtUsdc, opsView, renderOpsHtml, storyStartBlocker } from "../public/ops.mjs";
import { deriveTimeline } from "../lib/derive.mjs";
import { publicOperation } from "../lib/public-state.mjs";

test("atomic outcome and business receipt produce one charge card; orphan proof remains observable after a crash", () => {
  const proof = { seq: 1, action: "operation_outcome", operationId: "op-1", operationAction: "capture", operationState: "succeeded",
    outcome: "ok", code: null, txSig: "mock-tx-1", amount: "650000", reason: "Original capture outcome committed" };
  const business = { seq: 2, action: "capture", outcome: "ok", code: null, txSig: "mock-tx-1", amount: "650000" };
  const timeline = deriveTimeline([proof, business], []);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].kind, "capture");
  const recovered = deriveTimeline([proof], []);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].kind, "reconcile");
  assert.equal(recovered[0].message, "Original capture succeeded");
  assert.equal(recovered[0].txRef, "mock-tx-1");
});

test("restored live history allows an explicit new story without clearing prior records", () => {
  const s = { chain: "devnet", story: { state: "idle" }, timeline: [{ kind: "blocked" }], ops: [{ state: "failed" }], disputes: [] };
  const before = JSON.stringify(s);
  assert.equal(storyStartBlocker(s), null);
  assert.equal(JSON.stringify(s), before);
  assert.ok(storyStartBlocker({ ...s, chain: "mock" }));
  assert.ok(storyStartBlocker({ ...s, story: { state: "error" } }));
  assert.ok(storyStartBlocker({ ...s, ops: undefined }));
  assert.ok(storyStartBlocker({ ...s, disputes: [{ status: "open" }] }));
});
for (const state of ["pending", "unknown"]) test(`an original ${state} operation blocks a fresh live story`, () => {
  assert.ok(storyStartBlocker({ chain: "devnet", story: { state: "idle" }, ops: [{ state }] }));
});

for (const state of ["pending", "unknown", "succeeded", "failed"]) {
  test(`dashboard ${state} operations redact upstream and in-process evidence without mutation`, () => {
    const wire = "private-synthetic-wire";
    const prepared = Object.freeze({
      txSig: "mock-tx-1", holdId: "payment", lastValidBlockHeight: 100,
      evidence: { signedTransaction: wire }, signedTransaction: wire,
    });
    const original = Object.freeze({
      id: "op-1", action: "hold", state, reservation: 1_000_000n,
      createdAt: 1800000000, updatedAt: 1800000000,
      params: { amount: "1000000", evidence: wire }, prepared,
      result: { txSig: "mock-tx-1", evidence: wire },
      error: { code: "synthetic_error", message: "Synthetic failure", evidence: wire },
      salt: "private-salt", futurePrivateField: wire,
    });
    const projected = publicOperation(original);
    assert.equal(JSON.stringify(projected).includes(wire), false);
    assert.deepEqual(projected.prepared, { txSig: "mock-tx-1", holdId: "payment", lastValidBlockHeight: 100 });
    assert.deepEqual(projected.params, { amount: "1000000" });
    assert.deepEqual(projected.result, { txSig: "mock-tx-1" });
    assert.deepEqual(projected.error, { code: "synthetic_error", message: "Synthetic failure" });
    assert.equal(projected.salt, undefined);
    assert.equal(projected.futurePrivateField, undefined);
    assert.equal(original.prepared, prepared);
    assert.equal(original.prepared.evidence.signedTransaction, wire);
    assert.notEqual(projected.prepared, prepared);
    const view = opsView([projected], 1800000000000);
    const item = [...view.active, ...view.recent][0];
    assert.equal(item.txSig, "mock-tx-1");
    assert.equal(item.amount, "1.00 USDC");
  });
}

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
