import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { issueApprovalToken } from "../src/approval.js";
import { MockBackend } from "../src/backend/mock.js";
import { PaymentService } from "../src/service.js";
import { FileStateStore, type OpCommit, type StateStore } from "../src/store.js";
import { FaultyBackend, makeGate } from "./helpers/faulty-backend.js";

const now = () => 1_800_000_000, secret = "synthetic-human-approval-0001";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function wrap(inner: StateStore, method: keyof StateStore, replacement: (...args: any[]) => any): StateStore {
  return new Proxy(inner, { get(target, key) {
    if (key === method) return replacement;
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "singit-journal-")); dirs.push(dir);
  const backend = new FaultyBackend(new MockBackend({ now, balances: { payer: 10_000_000n, merchant: 10_000_000n } }));
  const make = (store: StateStore = new FileStateStore(dir)) => new PaymentService({ backend, now, approvalSecret: secret, store, live: true });
  const service = make();
  const mandate = await service.createMandate({ actor: "human", payer: "payer", totalBudget: 1_000_000n,
    perTxCap: 1_000_000n, expiresAt: now() + 1000, allowedCounterparties: ["merchant"] });
  const hold = async (svc = service) => svc.hold({ actor: "payer", mandateId: mandate.id, payee: "merchant", amount: 1_000_000n, idempotencyKey: "original-hold" });
  return { dir, backend, service, mandate, make, hold };
}

test.each(["hold", "capture", "release", "refund"] as const)("%s: crash after the durable terminal commit preserves accounting and its audit proof exactly once", async action => {
  const f = await fixture();
  const originalHold = action === "hold" ? null : await f.hold();
  if (action === "refund") await f.service.capture({ actor: "merchant", holdId: originalHold!.id, amount: 650_000n, releaseRemainder: true, idempotencyKey: "initial-capture" });
  const inner = new FileStateStore(f.dir);
  const crashed = f.make(wrap(inner, "putOpCommit", (commit: OpCommit) => {
    inner.putOpCommit(commit);
    if (commit.op.action === action && commit.op.state === "succeeded") throw Error("synthetic crash after durable commit");
  }));
  const execute = () => action === "hold" ? f.hold(crashed) : action === "capture"
    ? crashed.capture({ actor: "merchant", holdId: originalHold!.id, amount: 650_000n, releaseRemainder: true, idempotencyKey: "final-capture" })
    : action === "release" ? crashed.release({ actor: "merchant", holdId: originalHold!.id, idempotencyKey: "final-release" })
    : crashed.refund({ actor: "merchant", holdId: originalHold!.id, amount: 100_000n, idempotencyKey: "final-refund" });
  await expect(execute()).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
  expect(crashed.admissionStatus().open).toBe(false);
  expect(crashed.listOperations().filter(op => op.action === action).at(-1)!.state).toBe("pending");
  const calls = [f.backend.holdCalls, f.backend.captureCalls, f.backend.releaseCalls, f.backend.refundCalls];
  const bytes = readFileSync(join(f.dir, "state.jsonl"));
  await expect(execute()).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
  expect(readFileSync(join(f.dir, "state.jsonl"))).toEqual(bytes);
  const restored = f.make(), op = restored.listOperations().filter(op => op.action === action).at(-1)!;
  expect(op.state).toBe("succeeded");
  const before = new FileStateStore(f.dir).load();
  await restored.reconcilePending({ readOnly: true });
  await restored.reconcile(op.id);
  expect(new FileStateStore(f.dir).load()).toEqual(before);
  expect([f.backend.holdCalls, f.backend.captureCalls, f.backend.releaseCalls, f.backend.refundCalls]).toEqual(calls);
  expect(restored.listAuditLog().filter(e => e.operationId === op.id)).toHaveLength(1);
  expect(f.make().listAuditLog().filter(e => e.operationId === op.id)).toHaveLength(1);
  const hold = restored.getMandate(f.mandate.id).holds[0];
  expect([hold.held, hold.captured, hold.refunded]).toEqual(action === "hold" ? [1_000_000n, 0n, 0n]
    : action === "capture" ? [0n, 650_000n, 0n] : action === "release" ? [0n, 0n, 0n] : [0n, 650_000n, 100_000n]);
  expect(restored.getMandate(f.mandate.id).remaining).toBe(action === "hold" ? 0n : action === "release" ? 1_000_000n : 350_000n);
});

test("business audit failure after capture leaves the atomic proof durable and closes admission", async () => {
  const f = await fixture(), hold = await f.hold(), inner = new FileStateStore(f.dir);
  const service = f.make(wrap(inner, "appendAudit", () => { throw Error("synthetic audit fsync failure"); }));
  await service.capture({ actor: "merchant", holdId: hold.id, amount: 650_000n, releaseRemainder: true, idempotencyKey: "capture" });
  expect(service.admissionStatus()).toMatchObject({ open: false, code: "STORAGE_FAILURE" });
  const restored = f.make(), op = restored.listOperations().find(op => op.action === "capture")!;
  expect(restored.listAuditLog().filter(e => e.operationId === op.id)).toMatchObject([{ operationState: "succeeded", txSig: op.result!.txSig }]);
  expect(restored.getMandate(f.mandate.id).remaining).toBe(350_000n);
  expect(f.backend.captureCalls).toBe(1);
  const bytes = readFileSync(join(f.dir, "state.jsonl"));
  const replay = await service.captureOp({ actor: "merchant", holdId: hold.id, amount: 650_000n, releaseRemainder: true, idempotencyKey: "capture" });
  expect(replay.replay).toBe(true);
  expect(service.getMandate(f.mandate.id).remaining).toBe(350_000n);
  expect(service.listAuditLog()).toEqual(restored.listAuditLog());
  expect(readFileSync(join(f.dir, "state.jsonl"))).toEqual(bytes);
  expect(f.backend.captureCalls).toBe(1);
});

test("a failed terminal append cannot expose or replay uncommitted success in the same process", async () => {
  const f = await fixture(), hold = await f.hold(), inner = new FileStateStore(f.dir);
  const service = f.make(wrap(inner, "putOpCommit", (commit: OpCommit) => {
    if (commit.op.action === "capture" && commit.op.state === "succeeded") throw Error("synthetic failure before terminal append");
    inner.putOpCommit(commit);
  }));
  const request = { actor: "merchant", holdId: hold.id, amount: 650_000n, releaseRemainder: true, idempotencyKey: "capture" };
  await expect(service.capture(request)).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
  const op = service.listOperations().find(op => op.action === "capture")!;
  expect(op.state).toBe("pending");
  expect(op.result).toBeUndefined();
  expect(service.getHold(hold.id)).toMatchObject({ held: 1_000_000n, captured: 0n });
  expect(service.getMandate(f.mandate.id).remaining).toBe(0n);
  expect(service.listAuditLog().some(e => e.operationId === op.id)).toBe(false);
  const bytes = readFileSync(join(f.dir, "state.jsonl"));
  await expect(service.capture(request)).rejects.toMatchObject({ code: "STORAGE_FAILURE", operationId: op.id });
  await expect(service.reconcile(op.id)).rejects.toMatchObject({ code: "STORAGE_FAILURE", operationId: op.id });
  expect(readFileSync(join(f.dir, "state.jsonl"))).toEqual(bytes);
  expect(f.backend.captureCalls).toBe(1);
  const restored = f.make();
  await restored.reconcile(op.id, { readOnly: true });
  expect(restored.getHold(hold.id)).toMatchObject({ held: 0n, captured: 650_000n });
  expect(restored.getMandate(f.mandate.id).remaining).toBe(350_000n);
  expect(restored.listAuditLog().filter(e => e.operationId === op.id)).toHaveLength(1);
  expect(f.backend.captureCalls).toBe(1);
});

test("a failed failure-commit keeps its original hold reservation until durable reconciliation", async () => {
  const f = await fixture(), inner = new FileStateStore(f.dir);
  const service = f.make(wrap(inner, "putOpCommit", (commit: OpCommit) => {
    if (commit.op.state === "failed") throw Error("synthetic failure committing known backend failure");
    inner.putOpCommit(commit);
  }));
  f.backend.queueHoldFault("definite-before");
  await expect(f.hold(service)).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
  expect(service.listOperations()).toMatchObject([{ state: "pending", reservation: "1000000" }]);
  expect(service.getMandate(f.mandate.id)).toMatchObject({ remaining: 0n, reserved: 1_000_000n });
  await expect(f.hold(service)).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
  expect(f.backend.holdCalls).toBe(1);
});

test("a failed state commit restores the previous dispute link and audit in memory", async () => {
  const f = await fixture(), hold = await f.hold(), inner = new FileStateStore(f.dir);
  const service = f.make(wrap(inner, "putStateCommit", () => { throw Error("synthetic state-commit failure"); }));
  const audit = service.listAuditLog();
  const bytes = readFileSync(join(f.dir, "state.jsonl"));
  await expect(service.openDispute({ actor: "payer", holdId: hold.id, reason: "synthetic mismatch", evidence: [] }))
    .rejects.toMatchObject({ code: "STORAGE_FAILURE" });
  expect(service.getHold(hold.id).disputeId).toBeUndefined();
  expect(service.listDisputes()).toEqual([]);
  expect(service.listAuditLog()).toEqual(audit);
  expect(readFileSync(join(f.dir, "state.jsonl"))).toEqual(bytes);
});

test("definite hold failure frees its reservation atomically and replay/restart never frees twice", async () => {
  const f = await fixture();
  f.backend.queueHoldFault("definite-before");
  await expect(f.hold()).rejects.toMatchObject({ code: "BACKEND_ERROR" });
  expect(f.service.getMandate(f.mandate.id).remaining).toBe(1_000_000n);
  const restored = f.make(), [op] = restored.listOperations();
  expect(op).toMatchObject({ state: "failed", reservation: "0" });
  await restored.reconcile(op.id);
  await expect(f.hold(restored)).rejects.toMatchObject({ code: "BACKEND_ERROR" });
  expect(restored.getMandate(f.mandate.id).remaining).toBe(1_000_000n);
  expect(restored.listAuditLog().filter(e => e.operationId === op.id)).toHaveLength(1);
  expect(f.backend.holdCalls).toBe(1);
});

test("a queued economic call rechecks closed admission before entering the backend", async () => {
  const f = await fixture(), gate = makeGate();
  f.backend.setGate("hold", gate.promise);
  const request = { actor: "payer", mandateId: f.mandate.id, payee: "merchant", amount: 400_000n };
  const first = f.service.hold({ ...request, idempotencyKey: "first" });
  const second = f.service.hold({ ...request, idempotencyKey: "queued" });
  const results = Promise.allSettled([first, second]);
  await new Promise(resolve => setImmediate(resolve));
  expect(f.backend.holdCalls).toBe(1);
  f.service.closeAdmission("ADMISSION_CLOSED", "synthetic identity mismatch while a call is in flight");
  gate.release();
  const [completed, refused] = await results;
  expect(completed.status).toBe("fulfilled");
  expect(refused).toMatchObject({ status: "rejected", reason: { code: "ADMISSION_CLOSED" } });
  expect(f.backend.holdCalls).toBe(1);
  expect(f.service.getMandate(f.mandate.id).remaining).toBe(600_000n);
  expect(f.service.listOperations().find(op => op.key.endsWith(":queued"))).toMatchObject({ state: "failed", reservation: "0" });
});

test("refund resolution and its human decision survive a crash at the economic commit", async () => {
  const f = await fixture(), hold = await f.hold();
  await f.service.capture({ actor: "merchant", holdId: hold.id, amount: 650_000n, releaseRemainder: true, idempotencyKey: "capture" });
  const dispute = await f.service.openDispute({ actor: "payer", holdId: hold.id, reason: "synthetic mismatch", evidence: [] });
  const inner = new FileStateStore(f.dir), crashed = f.make(wrap(inner, "putOpCommit", (c: OpCommit) => {
    inner.putOpCommit(c);
    if (c.op.action === "resolve_refund" && c.op.state === "succeeded") throw Error("synthetic crash");
  }));
  const decision = { disputeId: dispute.id, outcome: "refund" as const, refundAmount: 100_000n };
  const request = { actor: "operator", ...decision, approvalToken: issueApprovalToken(secret, decision), idempotencyKey: "human-refund" };
  await expect(crashed.resolveDispute(request)).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
  const restored = f.make();
  expect(restored.getDispute(dispute.id)).toMatchObject({ status: "resolved", outcome: "refund", refundAmount: 100_000n });
  expect((await restored.resolveDispute(request)).txSigs).toHaveLength(1);
  expect(restored.getHold(hold.id).refunded).toBe(100_000n);
  expect(f.backend.refundCalls).toBe(1);
});

test("an open dispute, its hold link and audit are one durable record", async () => {
  const f = await fixture(), hold = await f.hold(), inner = new FileStateStore(f.dir);
  const crashed = f.make(wrap(inner, "putStateCommit", c => {
    inner.putStateCommit(c);
    if (c.dispute) throw Error("synthetic crash after opening dispute");
  }));
  await expect(crashed.openDispute({ actor: "payer", holdId: hold.id, reason: "synthetic mismatch", evidence: [] })).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
  const restored = f.make(), [dispute] = restored.listDisputes();
  expect(restored.getHold(hold.id).disputeId).toBe(dispute.id);
  expect(restored.listAuditLog().some(e => e.action === "open_dispute" && e.outcome === "ok")).toBe(true);
  await expect(restored.capture({ actor: "merchant", holdId: hold.id, amount: 1n, idempotencyKey: "refused" })).rejects.toMatchObject({ code: "DISPUTE_OPEN" });
  expect(f.backend.captureCalls).toBe(0);
});

test("compatible v1 atomic records gain only missing audit proofs; original bytes and accounting remain intact", async () => {
  const f = await fixture(), hold = await f.hold();
  await f.service.capture({ actor: "merchant", holdId: hold.id, amount: 650_000n, releaseRemainder: true, idempotencyKey: "capture" });
  const file = join(f.dir, "state.jsonl"), original = readFileSync(file, "utf8");
  const rows = original.trimEnd().split("\n").flatMap(line => {
    const rec = JSON.parse(line); rec.v = 1;
    if (rec.t === "statecommit") return ["mandate", "hold", "dispute", "audit"].filter(t => rec.data[t]).map(t => JSON.stringify({ t, v: 1, data: rec.data[t] }));
    if (rec.t === "opcommit") delete rec.data.audit;
    return [JSON.stringify(rec)];
  });
  const legacy = rows.join("\n") + "\n"; writeFileSync(file, legacy);
  const restored = f.make();
  expect(readFileSync(file, "utf8").startsWith(legacy)).toBe(true);
  expect(restored.getMandate(f.mandate.id).remaining).toBe(350_000n);
  expect(restored.getHold(hold.id).captured).toBe(650_000n);
  const proofs = restored.listAuditLog().filter(e => e.action === "operation_outcome");
  expect(proofs).toHaveLength(2);
  expect(proofs.every(e => e.recovered)).toBe(true);
  const bytes = readFileSync(file);
  f.make();
  expect(readFileSync(file)).toEqual(bytes);
  expect(f.backend.holdCalls).toBe(1); expect(f.backend.captureCalls).toBe(1);
});

test("ambiguous v1 terminal accounting refuses startup without rewriting or replaying anything", async () => {
  const f = await fixture(), hold = await f.hold(), file = join(f.dir, "state.jsonl");
  const [op] = f.service.listOperations();
  writeFileSync(file, JSON.stringify({ t: "op", v: 1, data: op }) + "\n");
  const bytes = readFileSync(file);
  expect(() => f.make()).toThrow("LEGACY_REVIEW_REQUIRED");
  expect(readFileSync(file)).toEqual(bytes);
  expect(f.backend.holdCalls).toBe(1);
  expect(hold.held).toBe(1_000_000n);
});

test("a duplicate terminal record after a later operation cannot rewind accounting or duplicate audit", async () => {
  const f = await fixture(), hold = await f.hold(), file = join(f.dir, "state.jsonl");
  const holdCommit = readFileSync(file, "utf8").trimEnd().split("\n").find(line => {
    const rec = JSON.parse(line); return rec.t === "opcommit" && rec.data.op.action === "hold" && rec.data.op.state === "succeeded";
  })!;
  await f.service.capture({ actor: "merchant", holdId: hold.id, amount: 650_000n, releaseRemainder: true, idempotencyKey: "capture" });
  const before = new FileStateStore(f.dir).load();
  writeFileSync(file, readFileSync(file, "utf8") + holdCommit + "\n");
  expect(new FileStateStore(f.dir).load()).toEqual(before);
  expect(f.make().getHold(hold.id)).toMatchObject({ held: 0n, captured: 650_000n });
  expect(f.backend.holdCalls).toBe(1); expect(f.backend.captureCalls).toBe(1);
});

test.each(["proof", "version", "record", "terminal-regression"])("incompatible or inconsistent journal data refuses without changing bytes: %s", async fault => {
  const f = await fixture(); await f.hold();
  const file = join(f.dir, "state.jsonl"), rows = readFileSync(file, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  const terminal = rows.find(rec => rec.t === "opcommit" && rec.data.op.state === "succeeded");
  if (fault === "proof") terminal.data.audit.txSig = "synthetic-unrelated-signature";
  if (fault === "version") terminal.v = 999;
  if (fault === "record") terminal.t = "future-record";
  if (fault === "terminal-regression") rows.push({ t: "op", v: 2, data: { ...terminal.data.op, state: "pending" } });
  writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const bytes = readFileSync(file);
  expect(() => f.make()).toThrow(/JOURNAL_(CORRUPT|UNSUPPORTED)/);
  expect(readFileSync(file)).toEqual(bytes);
  expect(f.backend.holdCalls).toBe(1);
});
