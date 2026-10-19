import { appendFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { issueApprovalToken } from "../src/approval.js";
import { MockBackend } from "../src/backend/mock.js";
import { inspectState } from "../src/inspection.js";
import { createServiceRuntime } from "../src/runtime.js";
import { PaymentService, Refusal } from "../src/service.js";
import { FileStateStore } from "../src/store.js";
import { FaultyBackend, makeGate } from "./helpers/faulty-backend.js";

const now = () => 1_800_000_000, secret = "synthetic-review-human-secret";
const dirs: string[] = [];
const runtimes: Array<{ close: () => void }> = [];
function directory() { const dir = mkdtempSync(join(tmpdir(), "singit-review-")); dirs.push(dir); return dir; }
function backend() { return new FaultyBackend(new MockBackend({ now, balances: { payer: 10_000_000n, merchant: 10_000_000n } })); }
function mandate(service: PaymentService) {
  return service.createMandate({ actor: "human", payer: "payer", totalBudget: 1_000_000n, perTxCap: 1_000_000n,
    expiresAt: now() + 1000, allowedCounterparties: ["merchant"] });
}
async function fixture(amount = 1_000_000n) {
  const dir = directory(), b = backend();
  const make = () => new PaymentService({ backend: b, now, approvalSecret: secret, store: new FileStateStore(dir), live: true });
  const service = make(), m = await mandate(service);
  const h = await service.hold({ actor: "payer", mandateId: m.id, payee: "merchant", amount, idempotencyKey: "first-hold" });
  return { dir, file: join(dir, "state.jsonl"), backend: b, service, mandate: m, hold: h, make };
}
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a duplicate mandate statecommit cannot restore spent budget or authorize a second hold", async () => {
  const f = await fixture(), original = readFileSync(f.file, "utf8"), first = original.split("\n")[0];
  appendFileSync(f.file, first + "\n");
  const bytes = readFileSync(f.file), restored = f.make();
  expect(inspectState(f.dir)).toMatchObject({ complete: true, counts: { mandates: 1, holds: 1 } });
  expect(restored.getMandate(f.mandate.id).remaining).toBe(0n);
  expect(restored.listAuditLog()).toEqual(f.service.listAuditLog());
  expect(readFileSync(f.file)).toEqual(bytes);
  await expect(restored.hold({ actor: "payer", mandateId: f.mandate.id, payee: "merchant", amount: 1_000_000n, idempotencyKey: "second-hold" }))
    .rejects.toMatchObject({ code: "OVER_BUDGET" });
  expect(f.backend.holdCalls).toBe(1);
});

test("a reused statecommit audit identity with changed snapshots is corruption, not a new state write", async () => {
  const f = await fixture(), rec = JSON.parse(readFileSync(f.file, "utf8").split("\n")[0]);
  rec.data.mandate.totalBudget = "2000000";
  appendFileSync(f.file, JSON.stringify(rec) + "\n");
  const bytes = readFileSync(f.file);
  expect(() => f.make()).toThrow("JOURNAL_CORRUPT");
  expect(inspectState(f.dir)).toMatchObject({ complete: false, code: "JOURNAL_CORRUPT" });
  expect(readFileSync(f.file)).toEqual(bytes);
});

test("a duplicate dispute statecommit cannot reopen a resolved dispute or rewind its hold", async () => {
  const f = await fixture();
  const d = await f.service.openDispute({ actor: "payer", holdId: f.hold.id, reason: "synthetic", evidence: [] });
  const row = readFileSync(f.file, "utf8").trimEnd().split("\n").find(line => JSON.parse(line).data.audit?.action === "open_dispute")!;
  const decision = { disputeId: d.id, outcome: "reject" as const, refundAmount: 0n };
  await f.service.resolveDispute({ actor: "operator", ...decision, approvalToken: issueApprovalToken(secret, decision), idempotencyKey: "reject" });
  await f.service.capture({ actor: "merchant", holdId: f.hold.id, amount: 650_000n, releaseRemainder: true, idempotencyKey: "capture" });
  appendFileSync(f.file, row + "\n");
  const restored = f.make();
  expect(restored.getDispute(d.id).status).toBe("resolved");
  expect(restored.getHold(f.hold.id)).toMatchObject({ held: 0n, captured: 650_000n });
});

test.each(["missing-dispute", "missing-hold", "open-dispute", "wrong-amount", "wrong-mandate", "missing-receipt"])(
  "a malformed terminal human refund refuses startup/inspection without replay: %s", async fault => {
    const f = await fixture();
    await f.service.capture({ actor: "merchant", holdId: f.hold.id, amount: 650_000n, releaseRemainder: true, idempotencyKey: "capture" });
    const d = await f.service.openDispute({ actor: "payer", holdId: f.hold.id, reason: "synthetic", evidence: [] });
    const decision = { disputeId: d.id, outcome: "refund" as const, refundAmount: 100_000n };
    await f.service.resolveDispute({ actor: "operator", ...decision, approvalToken: issueApprovalToken(secret, decision), idempotencyKey: "refund" });
    const rows = readFileSync(f.file, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
    const end = rows.findIndex(r => r.t === "opcommit" && r.data.op.action === "resolve_refund" && r.data.op.state === "succeeded");
    const commit = rows[end].data;
    if (fault === "missing-dispute") delete commit.dispute;
    if (fault === "missing-hold") delete commit.hold;
    if (fault === "open-dispute") commit.dispute.status = "open";
    if (fault === "wrong-amount") commit.dispute.refundAmount = "200000";
    if (fault === "wrong-mandate") commit.dispute.mandateId = "m-unrelated";
    if (fault === "missing-receipt") commit.dispute.txSigs = [];
    writeFileSync(f.file, rows.slice(0, end + 1).map(r => JSON.stringify(r)).join("\n") + "\n");
    const bytes = readFileSync(f.file);
    expect(() => f.make()).toThrow("JOURNAL_CORRUPT");
    expect(inspectState(f.dir)).toMatchObject({ complete: false, code: "JOURNAL_CORRUPT" });
    expect(readFileSync(f.file)).toEqual(bytes);
    expect(f.backend.refundCalls).toBe(1);
  });

test.each([["opcommit"], ["statecommit"], { toString: "op" }, null, 1].map(tag => ({ tag })))("non-string journal tags are refused rather than silently ignored: %j", ({ tag }) => {
  const dir = directory(), file = join(dir, "state.jsonl"); new FileStateStore(dir);
  writeFileSync(file, JSON.stringify({ t: tag, v: 2, data: {} }) + "\n");
  const bytes = readFileSync(file);
  expect(inspectState(dir)).toMatchObject({ complete: false, code: "JOURNAL_UNSUPPORTED" });
  expect(() => new FileStateStore(dir).load()).toThrow("JOURNAL_UNSUPPORTED");
  expect(readFileSync(file)).toEqual(bytes);
});

test.each(["changed-result", "changed-prepared", "missing-history", "wrong-latest", "legacy-prepared"])(
  "terminal receipts must agree with the original prepared signature and hold history: %s", async fault => {
    const f = await fixture();
    await f.service.capture({ actor: "merchant", holdId: f.hold.id, amount: 650_000n, releaseRemainder: true, idempotencyKey: "capture" });
    const rows = readFileSync(f.file, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
    const end = rows.findIndex(r => r.t === "opcommit" && r.data.op.action === "capture" && r.data.op.state === "succeeded");
    const commit = rows[end].data, originalSig = commit.op.result.txSig;
    if (fault === "changed-result") {
      commit.op.result.txSig = "unrelated-synthetic-receipt";
      commit.audit.txSig = commit.op.result.txSig;
      commit.hold.txSigs = commit.hold.txSigs.map((s: string) => s === originalSig ? commit.op.result.txSig : s);
      commit.hold.lastTxSig = commit.op.result.txSig;
    }
    if (fault === "changed-prepared" || fault === "legacy-prepared") commit.op.prepared.txSig = "unrelated-synthetic-receipt";
    if (fault === "missing-history") commit.hold.txSigs = commit.hold.txSigs.filter((s: string) => s !== originalSig);
    if (fault === "wrong-latest") commit.hold.lastTxSig = commit.hold.txSigs[0];
    commit.op.result.hold = structuredClone(commit.hold);
    if (fault === "legacy-prepared") rows[end].v = 1;
    writeFileSync(f.file, rows.slice(0, end + 1).map(r => JSON.stringify(r)).join("\n") + "\n");
    const bytes = readFileSync(f.file), code = fault === "legacy-prepared" ? "LEGACY_REVIEW_REQUIRED" : "JOURNAL_CORRUPT";
    expect(() => f.make()).toThrow(code);
    expect(inspectState(f.dir)).toMatchObject({ complete: false, code });
    expect(readFileSync(f.file)).toEqual(bytes);
    expect(f.backend.captureCalls).toBe(1);
  });

test.each(["replace", "truncate", "rewrite", "append", "directory", "hardlink", "symlink"])(
  "retained journal continuity failure closes admission before another backend call: %s", async fault => {
    const f = await fixture(400_000n), original = readFileSync(f.file), retained = f.dir + "-retained";
    if (fault === "replace" || fault === "symlink") {
      renameSync(f.file, join(f.dir, "retained.jsonl"));
      if (fault === "replace") writeFileSync(f.file, "", { mode: 0o600 });
      else symlinkSync(join(f.dir, "retained.jsonl"), f.file);
    }
    if (fault === "truncate") writeFileSync(f.file, "");
    if (fault === "rewrite") writeFileSync(f.file, original.toString().replaceAll("merchant", "merchanz"));
    if (fault === "append") appendFileSync(f.file, "\n");
    if (fault === "directory") {
      renameSync(f.dir, retained); dirs.push(retained); mkdirSync(f.dir, { mode: 0o700 }); writeFileSync(f.file, "", { mode: 0o600 });
    }
    if (fault === "hardlink") linkSync(f.file, join(f.dir, "alias.jsonl"));
    const changed = readFileSync(f.file);
    const request = { actor: "payer", mandateId: f.mandate.id, payee: "merchant", amount: 400_000n, idempotencyKey: "second-hold" };
    await expect(f.service.hold(request)).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
    expect(f.service.admissionStatus().open).toBe(false);
    expect(f.service.getMandate(f.mandate.id).remaining).toBe(600_000n);
    expect(f.backend.holdCalls).toBe(1);
    await expect(f.service.hold(request)).rejects.toMatchObject({ code: "ADMISSION_CLOSED" });
    expect(readFileSync(f.file)).toEqual(changed);
    if (fault === "replace" || fault === "symlink") expect(readFileSync(join(f.dir, "retained.jsonl"))).toEqual(original);
    if (fault === "directory") expect(readFileSync(join(retained, "state.jsonl"))).toEqual(original);
  });

test.skipIf(process.platform === "win32")("a replacement FIFO refuses without blocking journal open or allowing a send", async () => {
  const f = await fixture(400_000n), original = readFileSync(f.file), retained = join(f.dir, "retained.jsonl");
  renameSync(f.file, retained);
  const fifo = spawnSync("mkfifo", [f.file], { timeout: 2000, encoding: "utf8" });
  expect(fifo.status, fifo.stderr).toBe(0);
  expect(() => new FileStateStore(f.dir)).toThrow("JOURNAL_CHANGED");
  await expect(f.service.hold({ actor: "payer", mandateId: f.mandate.id, payee: "merchant", amount: 400_000n, idempotencyKey: "fifo" }))
    .rejects.toMatchObject({ code: "STORAGE_FAILURE" });
  expect(f.backend.holdCalls).toBe(1);
  expect(readFileSync(retained)).toEqual(original);
});

test.each(["hold", "mandate"] as const)("shutdown retains both locks until an accepted %s call and its local commit drain", async kind => {
  const dir = directory(), locks = directory(), other = directory(), b = backend(), gate = makeGate();
  const env = { SINGIT_BACKEND: "capture402", SINGIT_PROGRAM_ID: "synthetic-program", SINGIT_PAYER_ADDRESS: "payer",
    SINGIT_MERCHANT_ADDRESS: "merchant", SINGIT_NAMESPACE_LOCK_DIR: locks };
  const first = await createServiceRuntime({ ...env, SINGIT_STATE_DIR: dir }, { backend: b, now }); runtimes.push(first);
  const m = await mandate(first.service);
  if (kind === "hold") b.setGate("hold", gate.promise);
  else {
    const original = b.createMandate.bind(b);
    b.createMandate = async terms => { await gate.promise; return original(terms); };
  }
  const pending = kind === "hold" ? first.service.hold({ actor: "payer", mandateId: m.id, payee: "merchant", amount: 400_000n, idempotencyKey: "accepted" })
    : mandate(first.service);
  await new Promise(resolve => setImmediate(resolve));
  first.close();
  try {
    await expect(createServiceRuntime({ ...env, SINGIT_STATE_DIR: dir }, { backend: b, now })).rejects.toMatchObject({ code: "STATE_STORE_LOCKED" });
    await expect(createServiceRuntime({ ...env, SINGIT_STATE_DIR: other }, { backend: b, now })).rejects.toMatchObject({ code: "NAMESPACE_LOCKED" });
  } finally { gate.release(); await pending; }
  const bytes = readFileSync(join(dir, "state.jsonl"));
  await expect(mandate(first.service)).rejects.toMatchObject({ code: "ADMISSION_CLOSED" });
  first.service.recordRefusal("hold", "payer", new Refusal("ADMISSION_CLOSED", "closed"), {});
  first.service.recordReset("human");
  expect(readFileSync(join(dir, "state.jsonl"))).toEqual(bytes);
  const second = await createServiceRuntime({ ...env, SINGIT_STATE_DIR: dir }, { backend: b, now }); runtimes.push(second);
  expect(second.service.admissionStatus().open).toBe(true);
  first.close();
  await expect(createServiceRuntime({ ...env, SINGIT_STATE_DIR: other }, { backend: b, now })).rejects.toMatchObject({ code: "NAMESPACE_LOCKED" });
});

test.each(["capture", "release", "refund"] as const)("recovered %s retains its original signature in hold history and replay exactly once", async action => {
  const f = await fixture();
  if (action === "refund") await f.service.capture({ actor: "merchant", holdId: f.hold.id, amount: 650_000n, releaseRemainder: true, idempotencyKey: "initial-capture" });
  const before = [...f.service.getHold(f.hold.id).txSigs];
  const request = { actor: "merchant", holdId: f.hold.id, idempotencyKey: "lost-response" };
  let pending: Promise<unknown>;
  if (action === "capture") { f.backend.queueCaptureFault("ambiguous-after"); pending = f.service.capture({ ...request, amount: 650_000n, releaseRemainder: true }); }
  else if (action === "release") { f.backend.queueReleaseFault("ambiguous-after"); pending = f.service.release(request); }
  else { f.backend.queueRefundFault("ambiguous-after"); pending = f.service.refund({ ...request, amount: 100_000n }); }
  await expect(pending).rejects.toMatchObject({ code: "OPERATION_UNKNOWN" });
  const restored = f.make(), op = restored.listOperations().find(o => o.key.endsWith(":lost-response"))!;
  await restored.reconcile(op.id, { readOnly: true });
  const signature = op.prepared!.txSig;
  expect(restored.getHold(f.hold.id).txSigs).toEqual([...before, signature]);
  expect(restored.getHold(f.hold.id).lastTxSig).toBe(signature);
  expect(restored.getOperation(op.id).result!.hold!.txSigs).toEqual([...before, signature]);
  const bytes = readFileSync(f.file);
  await restored.reconcile(op.id, { readOnly: true });
  expect(readFileSync(f.file)).toEqual(bytes);
});

test("durable mock cleanup retains its receipt and commits success without enabling live cleanup", async () => {
  const dir = directory(), b = backend(), store = new FileStateStore(dir);
  const service = new PaymentService({ backend: b, now, store });
  const m = await mandate(service);
  b.queueStatusFault("wrong-mint");
  await expect(service.hold({ actor: "payer", mandateId: m.id, payee: "merchant", amount: 1_000_000n, idempotencyKey: "wrong-mint" }))
    .rejects.toMatchObject({ code: "WRONG_MINT" });
  expect(service.admissionStatus().open).toBe(true);
  expect(service.getMandate(m.id).remaining).toBe(1_000_000n);
  const restored = new PaymentService({ backend: b, now, store: new FileStateStore(dir) });
  const op = restored.listOperations().find(op => op.action === "cleanup_release")!;
  expect(op.state).toBe("succeeded");
  expect(op.result!.hold!.lastTxSig).toBe(op.prepared!.txSig);
  expect(op.result!.hold!.txSigs.filter(sig => sig === op.prepared!.txSig)).toHaveLength(1);
  await restored.reconcile(op.id, { readOnly: true });
  expect(b.releaseCalls).toBe(1);
  expect(restored.getMandate(m.id).remaining).toBe(1_000_000n);
});
