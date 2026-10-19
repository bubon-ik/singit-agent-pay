// Synthetic MVP-05/MVP-08 scenarios on the PR #23 journal/runtime contract.
// live:true selects the refusal policy; the only economic backend is an in-memory mock.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { issueApprovalToken } from "../src/approval.js";
import { MockBackend } from "../src/backend/mock.js";
import { DEVNET_USDC_MINT } from "../src/backend/types.js";
import { PaymentService } from "../src/service.js";
import { FileStateStore } from "../src/store.js";
import { FaultyBackend } from "./helpers/faulty-backend.js";

const now = () => 1_800_000_000;
const secret = "synthetic-offline-approval-secret";
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture(atomic = true) {
  const dir = mkdtempSync(join(tmpdir(), "singit-offline-recovery-"));
  directories.push(dir);
  const backend = new FaultyBackend(new MockBackend({ now, balances: { payer: 2_000_000n, merchant: 0n } }));
  const store = new FileStateStore(dir);
  const make = () => new PaymentService({ backend, now, approvalSecret: secret, live: true, store: new FileStateStore(dir) });
  const service = new PaymentService({ backend, now, approvalSecret: secret, live: true, store });
  const mandate = await service.createMandate({ actor: "human", payer: "payer", totalBudget: 1_000_000n,
    perTxCap: 1_000_000n, expiresAt: now() + 900, allowedCounterparties: ["merchant"] });
  const hold = await service.hold({ actor: "payer", mandateId: mandate.id, payee: "merchant", amount: 1_000_000n,
    captureDeadline: now() + 600, refundDeadline: now() + 4200, idempotencyKey: "report:synthetic:hold" });
  await service.capture({ actor: "merchant", holdId: hold.id, amount: 650_000n,
    releaseRemainder: atomic, idempotencyKey: "report:synthetic:capture" });
  const refund = { actor: "merchant", holdId: hold.id, amount: 100_000n, idempotencyKey: "agreed:synthetic:refund" };
  return { dir, file: join(dir, "state.jsonl"), backend, store, service, mandate, hold, refund, make };
}

function expectBudget(service: PaymentService, mandateId: string) {
  expect(service.getMandate(mandateId)).toMatchObject({ remaining: 350_000n, reserved: 0n,
    mandate: { committed: 650_000n, totalBudget: 1_000_000n } });
}

test("agreed merchant refund is separate from the purchase and never replenishes the mandate, including restart/replay", async () => {
  const f = await fixture();
  const first = await f.service.refundOp(f.refund);
  expect(first.hold).toMatchObject({ held: 0n, captured: 650_000n, refunded: 100_000n });
  expectBudget(f.service, f.mandate.id);
  const restored = f.make();
  expect(await restored.refundOp(f.refund)).toMatchObject({ replay: true, operationId: first.operationId, txSig: first.txSig, hold: first.hold });
  expectBudget(restored, f.mandate.id);
  expect(await f.backend.getStatus(f.hold.id)).toMatchObject({ held: 0n, refundable: 550_000n, maximum: 1_000_000n });
  expect([f.backend.holdCalls, f.backend.captureCalls, f.backend.releaseCalls, f.backend.refundCalls]).toEqual([1, 1, 0, 1]);
  await expect(restored.hold({ actor: "payer", mandateId: f.mandate.id, payee: "merchant", amount: 450_000n,
    idempotencyKey: "cannot-spend-the-refund" })).rejects.toMatchObject({ code: "OVER_BUDGET" });
  expect(f.backend.holdCalls).toBe(1);
});

test.each(["payer", "another-merchant"])("refund role %s refuses before invoking the backend", async actor => {
  const f = await fixture();
  await expect(f.service.refundOp({ ...f.refund, actor })).rejects.toMatchObject({ code: "NOT_PAYEE" });
  expect(f.backend.refundCalls).toBe(0);
  expect(f.service.getHold(f.hold.id).refunded).toBe(0n);
  expectBudget(f.service, f.mandate.id);
});

test("merchant liquidity shortage leaves refund, original escrow and mandate accounting unchanged", async () => {
  const f = await fixture();
  // The merchant spent its proceeds elsewhere. This separate payment does not change the report's F.
  await f.backend.inner.hold({ payer: "merchant", payee: "other-merchant", mint: DEVNET_USDC_MINT,
    maximum: 650_000n, captureDeadline: now() + 600, refundDeadline: now() + 4200, salt: "22".repeat(32) });
  const before = await f.backend.getStatus(f.hold.id);
  await expect(f.service.refundOp(f.refund)).rejects.toMatchObject({ code: "BACKEND_ERROR" });
  expect(f.backend.refundCalls).toBe(1);
  expect(f.backend.executedRefundCalls).toBe(0);
  expect(await f.backend.getStatus(f.hold.id)).toEqual(before);
  expect(f.make().getHold(f.hold.id)).toMatchObject({ captured: 650_000n, refunded: 0n });
  expectBudget(f.make(), f.mandate.id);
});

test("lost refund response recovers only the original operation and receipt; repeated reconciliation applies once", async () => {
  const f = await fixture();
  f.backend.queueRefundFault("ambiguous-after");
  await expect(f.service.refundOp(f.refund)).rejects.toMatchObject({ code: "OPERATION_UNKNOWN" });
  const original = structuredClone(f.service.listOperations().find(o => o.action === "refund")!);
  expect(original.state).toBe("unknown");
  expect(f.service.admissionStatus().open).toBe(false);
  const restored = f.make();
  await restored.reconcile(original.id, { readOnly: true });
  const bytes = readFileSync(f.file);
  await restored.reconcile(original.id, { readOnly: true });
  expect(readFileSync(f.file)).toEqual(bytes);
  const terminal = restored.getOperation(original.id);
  expect(terminal).toMatchObject({ state: "succeeded", prepared: original.prepared });
  expect(terminal.result?.txSig).toBe(original.prepared?.txSig);
  expect(restored.getHold(f.hold.id).txSigs.filter(s => s === original.prepared?.txSig)).toHaveLength(1);
  expect(restored.getHold(f.hold.id)).toMatchObject({ captured: 650_000n, refunded: 100_000n });
  expect(await restored.refundOp(f.refund)).toMatchObject({ replay: true, operationId: original.id, txSig: original.prepared?.txSig });
  expectBudget(restored, f.mandate.id);
  expect(f.backend.refundCalls).toBe(1);
});

test("H=0 with unresolved original refund evidence does not prove refund or enable another refund", async () => {
  const f = await fixture();
  f.backend.queueRefundFault("ambiguous-after");
  await expect(f.service.refundOp(f.refund)).rejects.toMatchObject({ code: "OPERATION_UNKNOWN" });
  const original = structuredClone(f.service.listOperations().find(o => o.action === "refund")!);
  // Capture402Backend maps missing/unavailable original history to pending, even after expiry.
  // Its wire-validation and RPC cases run in capture402.test.ts in the same offline command.
  const observe = vi.spyOn(f.backend, "getTxOutcome").mockResolvedValue({ status: "pending" });
  const restored = f.make();
  await restored.reconcilePending({ readOnly: true });
  await expect(restored.refundOp(f.refund)).rejects.toMatchObject({ code: "OPERATION_UNKNOWN" });
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ txSig: original.prepared?.txSig }));
  expect(restored.getOperation(original.id)).toMatchObject({ state: "unknown", prepared: original.prepared });
  expect(restored.getHold(f.hold.id)).toMatchObject({ held: 0n, captured: 650_000n, refunded: 0n });
  expectBudget(restored, f.mandate.id);
  expect(f.backend.refundCalls).toBe(1);
});

test("post-refund terminal storage failure closes admission and restart recovers accounting/audit once", async () => {
  const f = await fixture();
  const commit = f.store.putOpCommit.bind(f.store);
  vi.spyOn(f.store, "putOpCommit").mockImplementation(c => {
    if (c.op.action === "refund" && c.op.state === "succeeded") throw new Error("synthetic terminal fsync failure");
    commit(c);
  });
  await expect(f.service.refundOp(f.refund)).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
  expect(f.service.admissionStatus().open).toBe(false);
  expect(f.backend.executedRefundCalls).toBe(1);
  const restored = f.make(), original = restored.listOperations().find(o => o.action === "refund")!;
  expect(original.state).toBe("unknown");
  await restored.reconcile(original.id, { readOnly: true });
  await restored.reconcile(original.id, { readOnly: true });
  const terminal = f.make();
  expect(terminal.getHold(f.hold.id)).toMatchObject({ held: 0n, captured: 650_000n, refunded: 100_000n });
  expect(terminal.getOperation(original.id).state).toBe("succeeded");
  expect(terminal.listAuditLog().filter(e => e.action === "operation_outcome" && e.operationId === original.id)).toHaveLength(1);
  expectBudget(terminal, f.mandate.id);
  expect(f.backend.refundCalls).toBe(1);
});

test("multi-step live dispute remains refused after restart with no release or refund child", async () => {
  const f = await fixture(false);
  const dispute = await f.service.openDispute({ actor: "payer", holdId: f.hold.id, reason: "synthetic", evidence: [] });
  const decision = { disputeId: dispute.id, outcome: "refund" as const, refundAmount: 100_000n };
  const args = { actor: "human", ...decision, approvalToken: issueApprovalToken(secret, decision), idempotencyKey: "unaccepted-two-step" };
  await expect(f.service.resolveDispute(args)).rejects.toMatchObject({ code: "ACTION_DISABLED" });
  const restored = f.make();
  await expect(restored.resolveDispute(args)).rejects.toMatchObject({ code: "ACTION_DISABLED" });
  expect(restored.getDispute(dispute.id).status).toBe("open");
  expect(restored.getHold(f.hold.id)).toMatchObject({ held: 350_000n, captured: 650_000n, refunded: 0n });
  expect(restored.listOperations().filter(o => o.action.startsWith("resolve_"))).toHaveLength(0);
  expect([f.backend.releaseCalls, f.backend.refundCalls]).toEqual([0, 0]);
});
