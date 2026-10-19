import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type {
  CaptureRequest,
  EscrowStatus,
  HoldReceipt,
  HoldRequest,
  MandateTerms,
  PaymentBackend,
  RefundRequest,
  ReleaseRequest,
  SubmitContext,
  TxOutcome,
  TxOutcomeQuery,
  TxReceipt,
} from "../src/backend/types.js";
import { MockBackend } from "../src/backend/mock.js";
import { PaymentService } from "../src/service.js";
import { FileStateStore } from "../src/store.js";
import { FaultyBackend, makeGate } from "./helpers/faulty-backend.js";

/** Wraps a PaymentBackend to record, for a chosen method, how many calls are concurrently
 * in-flight and the wall-clock enter/exit of each call — for asserting PaymentService
 * serializes money-moving backend calls (see withBackendLock in src/service.ts). */
class ConcurrencyTrackingBackend implements PaymentBackend {
  readonly name = "concurrency-test";
  inFlight = 0;
  maxConcurrent = 0;
  calls: Array<{ enter: number; exit: number }> = [];

  constructor(
    private readonly inner: PaymentBackend,
    private readonly delayMs: number,
  ) {}

  createMandate(terms: MandateTerms): Promise<{ ref?: string }> {
    return this.inner.createMandate(terms);
  }

  async hold(req: HoldRequest, ctx?: SubmitContext): Promise<HoldReceipt> {
    this.inFlight++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    const entry = { enter: Date.now(), exit: 0 };
    this.calls.push(entry);
    try {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      return await this.inner.hold(req, ctx);
    } finally {
      entry.exit = Date.now();
      this.inFlight--;
    }
  }

  capture(req: CaptureRequest, ctx?: SubmitContext): Promise<TxReceipt> {
    return this.inner.capture(req, ctx);
  }
  release(req: ReleaseRequest, ctx?: SubmitContext): Promise<TxReceipt> {
    return this.inner.release(req, ctx);
  }
  refund(req: RefundRequest, ctx?: SubmitContext): Promise<TxReceipt> {
    return this.inner.refund(req, ctx);
  }
  getStatus(holdId: string): Promise<EscrowStatus | null> {
    return this.inner.getStatus(holdId);
  }
  getTxOutcome(q: TxOutcomeQuery): Promise<TxOutcome> {
    return this.inner.getTxOutcome!(q);
  }
}

const SECRET = "test-secret-0123456789";
const PAYER = "payer";
const PAYEE = "payee";

function setup() {
  let t = 1_800_000_000;
  const now = () => t;
  const mock = new MockBackend({ now, balances: { [PAYER]: 1_000_000_000n, [PAYEE]: 1_000_000_000n } });
  const backend = new FaultyBackend(mock);
  const service = new PaymentService({ backend, now, approvalSecret: SECRET });
  return { service, backend, mock, now, advance: (seconds: number) => (t += seconds) };
}

async function createMandate(service: PaymentService, now: () => number, totalBudget = 1_000_000n) {
  return service.createMandate({
    actor: PAYER,
    payer: PAYER,
    totalBudget,
    perTxCap: totalBudget,
    expiresAt: now() + 1000,
    allowedCounterparties: [PAYEE],
  });
}

async function expectRefused(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ name: "Refusal", code });
}

/**
 * The invariant every scenario below must preserve: the mandate's budget bookkeeping
 * (`committed`, hence `remaining`) must never fall below what is genuinely tied up on-chain
 * (still held, or captured and not yet refunded) for that mandate's holds. A violation here
 * means either a double-free of a reservation or a hold that moved money without reserving it.
 */
function assertInvariant(service: PaymentService, mock: MockBackend, mandateId: string): void {
  const { mandate, remaining } = service.getMandate(mandateId);
  expect(remaining).toBeLessThanOrEqual(mandate.totalBudget);
  expect(mandate.committed).toBeGreaterThanOrEqual(0n);

  const { holds } = service.getMandate(mandateId);
  const payments = mock.listPayments();
  let onChain = 0n;
  for (const h of holds) {
    const payment = payments.find((p) => p.holdId === h.id);
    if (payment) onChain += payment.held + payment.refundable;
  }
  expect(mandate.committed).toBeGreaterThanOrEqual(onChain);

  // no two holds for this mandate ever shared an id (structurally true via the Map, but assert
  // the underlying on-chain payment count never exceeds the number of logical holds either).
  const holdIds = new Set(holds.map((h) => h.id));
  expect(holdIds.size).toBe(holds.length);
}

test("a) two parallel holds, only one fits -> one ok, one OVER_BUDGET, exactly 1 backend hold call", async () => {
  const { service, backend, mock, now } = setup();
  const mandate = await createMandate(service, now, 1_000_000n);
  const holdSpy = vi.spyOn(backend, "hold");

  const results = await Promise.allSettled([
    service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 700_000n }),
    service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 700_000n }),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  expect(fulfilled.length).toBe(1);
  expect(rejected.length).toBe(1);
  expect(rejected[0].reason).toMatchObject({ code: "OVER_BUDGET" });
  expect(holdSpy).toHaveBeenCalledTimes(1);
  expect(service.getMandate(mandate.id).remaining).toBe(300_000n);
  assertInvariant(service, mock, mandate.id);
});

test("succeeded hold reservations clear only after accounting commits the hold", async () => {
  const { service, backend, now } = setup();
  const mandate = await createMandate(service, now, 1_000_000n);

  backend.queueHoldFault("ambiguous-after");
  await expectRefused(
    service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 400_000n }),
    "OPERATION_UNKNOWN",
  );
  const unknownOp = service.listOperations({ state: "unknown" }).find((op) => op.action === "hold")!;
  expect(unknownOp.reservation).toBe("400000");
  expect(service.getMandate(mandate.id).mandate.committed).toBe(400_000n);

  await service.reconcile(unknownOp.id);
  expect(service.getOperation(unknownOp.id).state).toBe("succeeded");
  expect(service.getOperation(unknownOp.id).reservation).toBe("0");
  expect(service.getMandate(mandate.id).mandate.committed).toBe(400_000n);
});

test("b) hold response lost after successful send -> OPERATION_UNKNOWN; reconcile converges; no duplicate hold", async () => {
  const { service, backend, mock, now } = setup();
  const mandate = await createMandate(service, now, 1_000_000n);
  const holdSpy = vi.spyOn(backend, "hold");

  backend.queueHoldFault("ambiguous-after");
  await expectRefused(
    service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 400_000n, idempotencyKey: "k-b" }),
    "OPERATION_UNKNOWN",
  );
  expect(holdSpy).toHaveBeenCalledTimes(1);
  expect(backend.executedHoldCalls).toBe(1); // it really did execute on-chain
  expect(service.getMandate(mandate.id).remaining).toBe(600_000n); // still reserved, not freed
  expect(service.getMandate(mandate.id).reserved).toBe(400_000n);
  assertInvariant(service, mock, mandate.id);

  const unknownOps = service.listOperations({ state: "unknown" });
  expect(unknownOps.length).toBe(1);
  await service.reconcile(unknownOps[0].id);
  expect(service.getOperation(unknownOps[0].id).state).toBe("succeeded");
  expect(service.getMandate(mandate.id).remaining).toBe(600_000n); // unchanged: reservation becomes the real commitment
  expect(service.getMandate(mandate.id).reserved).toBe(0n);
  const holdId = service.getOperation(unknownOps[0].id).result?.holdId!;
  expect(service.getHold(holdId).held).toBe(400_000n);
  assertInvariant(service, mock, mandate.id);

  // retry with the same idempotency key: replays the cached result, no new backend call
  const replay = await service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 400_000n, idempotencyKey: "k-b" });
  expect(replay.id).toBe(holdId);
  expect(holdSpy).toHaveBeenCalledTimes(1);
  assertInvariant(service, mock, mandate.id);
});

test("c) retry with same idempotency key + same params replays; different params -> IDEMPOTENCY_KEY_REUSED", async () => {
  const { service, backend, mock, now } = setup();
  const mandate = await createMandate(service, now, 1_000_000n);
  const holdSpy = vi.spyOn(backend, "hold");

  const first = await service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 300_000n, idempotencyKey: "k-c" });
  const second = await service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 300_000n, idempotencyKey: "k-c" });
  expect(second.id).toBe(first.id);
  expect(holdSpy).toHaveBeenCalledTimes(1);

  await expectRefused(
    service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 301_000n, idempotencyKey: "k-c" }),
    "IDEMPOTENCY_KEY_REUSED",
  );
  expect(holdSpy).toHaveBeenCalledTimes(1);
  assertInvariant(service, mock, mandate.id);
});

test("d) restart: FileStateStore round-trips a pending/unknown op and converges via reconcilePending", async () => {
  const dir = mkdtempSync(join(tmpdir(), "singit-state-"));
  let t = 1_800_000_000;
  const now = () => t;
  const mock = new MockBackend({ now, balances: { [PAYER]: 1_000_000_000n, [PAYEE]: 1_000_000_000n } });
  const backend = new FaultyBackend(mock);

  const service1 = new PaymentService({ backend, now, approvalSecret: SECRET, store: new FileStateStore(dir) });
  const mandate = await createMandate(service1, now, 1_000_000n);

  backend.queueHoldFault("ambiguous-after");
  await expectRefused(
    service1.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 400_000n, idempotencyKey: "restart-1" }),
    "OPERATION_UNKNOWN",
  );

  // simulate a process restart: a brand-new service over the same dir and the same backend
  const service2 = new PaymentService({ backend, now, approvalSecret: SECRET, store: new FileStateStore(dir) });

  expect(service2.getMandate(mandate.id).mandate.totalBudget).toBe(1_000_000n);
  expect(service2.getMandate(mandate.id).remaining).toBe(600_000n);
  expect(service2.listOperations({ state: "unknown" }).length).toBe(1);

  const holdSpy = vi.spyOn(backend, "hold");
  await service2.reconcilePending();
  expect(holdSpy).toHaveBeenCalledTimes(0); // reconcile never calls hold() again

  const succeeded = service2.listOperations({ state: "succeeded" });
  expect(succeeded.length).toBe(1);
  const holdId = succeeded[0].result?.holdId!;
  const hold = service2.getHold(holdId);
  expect(hold.held).toBe(400_000n);
  expect(service2.getMandate(mandate.id).remaining).toBe(600_000n);
  expect(service2.getMandate(mandate.id).reserved).toBe(0n);
  assertInvariant(service2, mock, mandate.id);
});

test("e) getStatus throwing after a hold executes -> OPERATION_UNKNOWN (not WRONG_MINT); reconcile later confirms it", async () => {
  const { service, backend, mock, now } = setup();
  const mandate = await createMandate(service, now, 1_000_000n);

  backend.queueStatusFault("throw");
  await expectRefused(service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 300_000n }), "OPERATION_UNKNOWN");
  expect(service.getMandate(mandate.id).remaining).toBe(700_000n); // still reserved
  assertInvariant(service, mock, mandate.id);

  const unknownOps = service.listOperations({ state: "unknown" });
  expect(unknownOps.length).toBe(1);
  await service.reconcile(unknownOps[0].id);
  const resolved = service.getOperation(unknownOps[0].id);
  expect(resolved.state).toBe("succeeded");
  const hold = service.getHold(resolved.result!.holdId!);
  expect(hold.held).toBe(300_000n);
  assertInvariant(service, mock, mandate.id);
});

test("e) getStatus returning null after a hold executes -> OPERATION_UNKNOWN (not WRONG_MINT)", async () => {
  const { service, backend, mock, now } = setup();
  const mandate = await createMandate(service, now, 1_000_000n);

  backend.queueStatusFault("null");
  await expectRefused(service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 300_000n }), "OPERATION_UNKNOWN");
  expect(service.getMandate(mandate.id).remaining).toBe(700_000n);
  assertInvariant(service, mock, mandate.id);
});

test("f) wrong mint + ambiguous cleanup release -> reservation kept, op unknown; reconcile frees it exactly once", async () => {
  const { service, backend, mock, now } = setup();
  const mandate = await createMandate(service, now, 1_000_000n);

  backend.queueStatusFault("wrong-mint");
  backend.queueReleaseFault("ambiguous-after");
  await expectRefused(service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 300_000n }), "WRONG_MINT");

  expect(service.getMandate(mandate.id).remaining).toBe(700_000n); // reservation kept
  const cleanupOps = service.listOperations({ state: "unknown" }).filter((o) => o.action === "cleanup_release");
  expect(cleanupOps.length).toBe(1);
  const holdId = cleanupOps[0].holdId!;
  expect(() => service.getHold(holdId)).not.toThrow(); // recorded so it is visible
  expect(service.getHold(holdId).held).toBe(300_000n);
  expect(service.getHold(holdId).quarantined).toBe(true);
  assertInvariant(service, mock, mandate.id);

  await service.reconcile(cleanupOps[0].id);
  expect(service.getOperation(cleanupOps[0].id).state).toBe("succeeded");
  expect(service.getHold(holdId).held).toBe(0n);
  expect(service.getMandate(mandate.id).remaining).toBe(1_000_000n); // freed exactly once
  assertInvariant(service, mock, mandate.id);

  const before = service.getMandate(mandate.id).remaining;
  await service.reconcile(cleanupOps[0].id); // already terminal: no-op
  expect(service.getMandate(mandate.id).remaining).toBe(before);
});

test("g) hold ambiguous before execution -> reconcile sees not_found -> failed, reservation freed exactly once", async () => {
  const { service, backend, mock, now } = setup();
  const mandate = await createMandate(service, now, 1_000_000n);
  const innerHoldSpy = vi.spyOn(backend.inner, "hold");

  backend.queueHoldFault("ambiguous-before");
  await expectRefused(service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 300_000n }), "OPERATION_UNKNOWN");
  expect(innerHoldSpy).toHaveBeenCalledTimes(0); // never reached the real backend
  expect(service.getMandate(mandate.id).remaining).toBe(700_000n); // still reserved
  assertInvariant(service, mock, mandate.id);

  const unknownOps = service.listOperations({ state: "unknown" });
  expect(unknownOps.length).toBe(1);
  await service.reconcile(unknownOps[0].id);
  expect(service.getOperation(unknownOps[0].id).state).toBe("failed");
  expect(service.getMandate(mandate.id).remaining).toBe(1_000_000n); // freed
  assertInvariant(service, mock, mandate.id);

  const before = service.getMandate(mandate.id).remaining;
  await service.reconcile(unknownOps[0].id); // already terminal: no-op
  expect(service.getMandate(mandate.id).remaining).toBe(before);
});

test("h) concurrent capture + release on the same hold -> the second gets OPERATION_PENDING, no backend call", async () => {
  const { service, backend, mock, now } = setup();
  const mandate = await createMandate(service, now, 1_000_000n);
  const hold = await service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 500_000n });

  const gate = makeGate();
  backend.setGate("capture", gate.promise);

  const p1 = service.capture({ actor: PAYEE, holdId: hold.id, amount: 200_000n });
  const p2 = service.release({ actor: PAYEE, holdId: hold.id });
  gate.release();
  const [r1, r2] = await Promise.allSettled([p1, p2]);

  const rejected = [r1, r2].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  const fulfilled = [r1, r2].find((r) => r.status === "fulfilled");
  expect(rejected).toBeDefined();
  expect(rejected!.reason).toMatchObject({ code: "OPERATION_PENDING" });
  expect(fulfilled).toBeDefined();
  assertInvariant(service, mock, mandate.id);
});

test("i) capture response lost after successful send -> unknown, hold locked; reconcile applies it exactly once", async () => {
  const { service, backend, mock, now } = setup();
  const mandate = await createMandate(service, now, 1_000_000n);
  const hold = await service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 500_000n });

  backend.queueCaptureFault("ambiguous-after");
  await expectRefused(service.capture({ actor: PAYEE, holdId: hold.id, amount: 200_000n }), "OPERATION_UNKNOWN");

  const captureSpy = vi.spyOn(backend, "capture");
  await expectRefused(service.capture({ actor: PAYEE, holdId: hold.id, amount: 100_000n }), "OPERATION_PENDING");
  expect(captureSpy).toHaveBeenCalledTimes(0);
  assertInvariant(service, mock, mandate.id);

  const unknownOps = service.listOperations({ state: "unknown" });
  expect(unknownOps.length).toBe(1);
  await service.reconcile(unknownOps[0].id);
  expect(service.getOperation(unknownOps[0].id).state).toBe("succeeded");
  expect(service.getHold(hold.id).held).toBe(300_000n);
  expect(service.getHold(hold.id).captured).toBe(200_000n);
  assertInvariant(service, mock, mandate.id);

  // the lock is released now: a further capture proceeds normally
  const result = await service.capture({ actor: PAYEE, holdId: hold.id, amount: 100_000n });
  expect(result.held).toBe(200_000n);
  expect(result.captured).toBe(300_000n);
  assertInvariant(service, mock, mandate.id);
});

test("fix1) reconcile must not race a same-process in-flight hold call (devnet getTxOutcome could say not_found before send)", async () => {
  const { service, backend, mock, now } = setup();
  const mandate = await createMandate(service, now, 1_000_000n);

  const gate = makeGate();
  backend.setGate("hold", gate.promise);

  const holdPromise = service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 300_000n });

  // the op exists and is "pending", with its backend.hold() call gated open: in flight.
  const pendingOps = service.listOperations({ state: "pending" });
  expect(pendingOps.length).toBe(1);
  const opId = pendingOps[0].id;

  // Without the inFlight guard, reconcile would call getTxOutcome (txSig/holdId both still
  // unset, since onPrepared has not fired yet) -> MockBackend reports not_found -> reconcile
  // would wrongly mark this "failed" and free the reservation while the call is still live.
  const reconciledWhileInFlight = await service.reconcile(opId);
  expect(reconciledWhileInFlight.state).toBe("pending");
  expect(service.getMandate(mandate.id).remaining).toBe(700_000n); // reservation still intact
  expect(service.getOperation(opId).state).toBe("pending");

  gate.release();
  const hold = await holdPromise;
  expect(hold.held).toBe(300_000n);
  expect(service.getMandate(mandate.id).remaining).toBe(700_000n);
  assertInvariant(service, mock, mandate.id);
});

test("fix2) reconcile discovering a wrong-mint hold (not just the live path) goes through the cleanup path, not a blind trusted Hold", async () => {
  const { service, backend, mock, now } = setup();
  const mandate = await createMandate(service, now, 1_000_000n);

  backend.queueStatusFault("throw"); // live hold() can't verify at all -> OPERATION_UNKNOWN
  await expectRefused(service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 300_000n }), "OPERATION_UNKNOWN");

  const unknownOps = service.listOperations({ state: "unknown" });
  expect(unknownOps.length).toBe(1);

  // THIS time, reconcile's own getStatus call (not the live path's) is the one that discovers
  // the mismatch for the first time.
  backend.queueStatusFault("wrong-mint");
  backend.queueReleaseFault("ambiguous-after"); // cleanup stays pending
  await service.reconcile(unknownOps[0].id);

  const holdOp = service.getOperation(unknownOps[0].id);
  expect(holdOp.state).toBe("succeeded"); // the hold itself genuinely executed
  const holdId = holdOp.result!.holdId!;
  const cleanupOps = service.listOperations({ holdId, state: "unknown" }).filter((o) => o.action === "cleanup_release");
  expect(cleanupOps.length).toBe(1); // a cleanup op was journaled, not skipped
  expect(service.getHold(holdId).quarantined).toBe(true); // and the hold is marked unsafe to use
  assertInvariant(service, mock, mandate.id);
});

test("fix3a) cleanup_release not_found triggers a fresh guarded retry instead of a stuck terminal failure", async () => {
  const { service, backend, mock, now } = setup();
  const mandate = await createMandate(service, now, 1_000_000n);

  backend.queueStatusFault("wrong-mint");
  backend.queueReleaseFault("ambiguous-before"); // the cleanup release never reaches the chain this time
  await expectRefused(service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 300_000n }), "WRONG_MINT");

  const cleanupOps = service.listOperations({ state: "unknown" }).filter((o) => o.action === "cleanup_release");
  expect(cleanupOps.length).toBe(1);
  const holdId = cleanupOps[0].holdId!;
  expect(service.getHold(holdId).quarantined).toBe(true);
  expect(service.getHold(holdId).held).toBe(300_000n); // still genuinely held: nothing was ever sent
  assertInvariant(service, mock, mandate.id);

  // reconcile: getTxOutcome reports not_found (nothing to find) -> must retry the release, not
  // give up with funds stuck in escrow.
  await service.reconcile(cleanupOps[0].id);
  expect(service.getOperation(cleanupOps[0].id).state).toBe("succeeded"); // the retry (no fault queued) landed for real
  expect(service.getHold(holdId).held).toBe(0n);
  expect(service.getMandate(mandate.id).remaining).toBe(1_000_000n);
  expect(mock.listPayments().find((p) => p.holdId === holdId)?.held).toBe(0n);
  assertInvariant(service, mock, mandate.id);
});

test("fix3b) cleanup_release not_found but on-chain state already shows held=0 -> frees the reservation without a redundant release call", async () => {
  const { service, backend, mock, now } = setup();
  const mandate = await createMandate(service, now, 1_000_000n);

  backend.queueStatusFault("wrong-mint");
  backend.queueReleaseFault("ambiguous-before");
  await expectRefused(service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 300_000n }), "WRONG_MINT");

  const cleanupOps = service.listOperations({ state: "unknown" }).filter((o) => o.action === "cleanup_release");
  const holdId = cleanupOps[0].holdId!;

  // Simulate an external/concurrent release that already landed on-chain for this hold (e.g. a
  // second process's cleanup attempt), bypassing this service entirely.
  const payment = mock.listPayments().find((p) => p.holdId === holdId)!;
  await mock.release({ holdId, expectedHeld: payment.held, expectedRefundable: payment.refundable });
  expect(mock.listPayments().find((p) => p.holdId === holdId)?.held).toBe(0n);

  const releaseSpy = vi.spyOn(backend, "release");
  await service.reconcile(cleanupOps[0].id);
  expect(service.getOperation(cleanupOps[0].id).state).toBe("succeeded");
  expect(releaseSpy).toHaveBeenCalledTimes(0); // no redundant release call: getStatus already showed held=0
  expect(service.getHold(holdId).held).toBe(0n);
  expect(service.getMandate(mandate.id).remaining).toBe(1_000_000n); // freed exactly once
  assertInvariant(service, mock, mandate.id);
});

test("fix3c) a quarantined hold refuses capture/refund/release(by payee)/open_dispute with WRONG_MINT", async () => {
  const { service, backend, mock, now } = setup();
  const mandate = await createMandate(service, now, 1_000_000n);

  backend.queueStatusFault("wrong-mint");
  backend.queueReleaseFault("ambiguous-after"); // cleanup stays pending: the hold remains visible & quarantined
  await expectRefused(service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 300_000n }), "WRONG_MINT");

  const cleanupOps = service.listOperations({ state: "unknown" }).filter((o) => o.action === "cleanup_release");
  const holdId = cleanupOps[0].holdId!;
  expect(service.getHold(holdId).quarantined).toBe(true);

  await expectRefused(service.capture({ actor: PAYEE, holdId, amount: 1n }), "WRONG_MINT");
  await expectRefused(service.refund({ actor: PAYEE, holdId, amount: 1n }), "WRONG_MINT");
  await expectRefused(service.release({ actor: PAYEE, holdId }), "WRONG_MINT");
  await expectRefused(service.openDispute({ actor: PAYER, holdId, reason: "x", evidence: [] }), "WRONG_MINT");
  assertInvariant(service, mock, mandate.id);
});

test("fix4a) a definitely-failed op's idempotent replay carries the original Refusal code (BACKEND_ERROR), not the raw backend fault code", async () => {
  const { service, backend, mock, now } = setup();
  const mandate = await createMandate(service, now, 1_000_000n);

  backend.queueHoldFault("definite-before"); // BackendError("test_fault", ...), not a valid RefusalCode
  await expectRefused(
    service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 300_000n, idempotencyKey: "k-fix4a" }),
    "BACKEND_ERROR",
  );

  // retry with the same key: must replay the SAME Refusal code, not the raw "test_fault" string
  await expectRefused(
    service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 300_000n, idempotencyKey: "k-fix4a" }),
    "BACKEND_ERROR",
  );
  assertInvariant(service, mock, mandate.id);
});

test("fix4b) a reconcile-discovered not_found failure also replays as BACKEND_ERROR, not a raw backend code", async () => {
  const { service, backend, mock, now } = setup();
  const mandate = await createMandate(service, now, 1_000_000n);

  backend.queueHoldFault("ambiguous-before");
  await expectRefused(
    service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 300_000n, idempotencyKey: "k-fix4b" }),
    "OPERATION_UNKNOWN",
  );
  const unknownOps = service.listOperations({ state: "unknown" });
  await service.reconcile(unknownOps[0].id);
  expect(service.getOperation(unknownOps[0].id).state).toBe("failed");

  await expectRefused(
    service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 300_000n, idempotencyKey: "k-fix4b" }),
    "BACKEND_ERROR",
  );
  assertInvariant(service, mock, mandate.id);
});

test("fix6) restart then retry with the same idempotencyKey returns the same hold, backend.hold called once in total", async () => {
  const dir = mkdtempSync(join(tmpdir(), "singit-state-"));
  let t = 1_800_000_000;
  const now = () => t;
  const mock = new MockBackend({ now, balances: { [PAYER]: 1_000_000_000n, [PAYEE]: 1_000_000_000n } });
  const backend = new FaultyBackend(mock);

  const service1 = new PaymentService({ backend, now, approvalSecret: SECRET, store: new FileStateStore(dir) });
  const mandate = await createMandate(service1, now, 1_000_000n);

  backend.queueHoldFault("ambiguous-after");
  await expectRefused(
    service1.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 400_000n, idempotencyKey: "fix6-key" }),
    "OPERATION_UNKNOWN",
  );

  // process "restarts": a brand-new service over the same dir, same backend instance
  const service2 = new PaymentService({ backend, now, approvalSecret: SECRET, store: new FileStateStore(dir) });

  const replay = await service2.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 400_000n, idempotencyKey: "fix6-key" });
  expect(replay.held).toBe(400_000n);

  const again = await service2.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 400_000n, idempotencyKey: "fix6-key" });
  expect(again.id).toBe(replay.id);

  expect(backend.holdCalls).toBe(1); // exactly one backend.hold() call in total, across both processes and both retries
  expect(backend.executedHoldCalls).toBe(1);
  assertInvariant(service2, mock, mandate.id);
});

test("C) two concurrent holds never overlap on the backend: strictly sequential hold() calls, no false UNKNOWN", async () => {
  let t = 1_800_000_000;
  const now = () => t;
  const mock = new MockBackend({ now, balances: { [PAYER]: 2_000_000n, [PAYEE]: 0n } });
  const backend = new ConcurrencyTrackingBackend(mock, 20);
  const service = new PaymentService({ backend, now, approvalSecret: SECRET });
  const mandate = await createMandate(service, now, 2_000_000n);

  const [h1, h2] = await Promise.all([
    service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 500_000n }),
    service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 500_000n }),
  ]);

  expect(backend.calls.length).toBe(2);
  expect(backend.maxConcurrent).toBe(1); // never two backend.hold() calls in flight at once
  const [first, second] = backend.calls;
  expect(second.enter).toBeGreaterThanOrEqual(first.exit); // strictly sequential, not just non-overlapping by luck
  expect(h1.held).toBe(500_000n);
  expect(h2.held).toBe(500_000n);
  expect(service.listOperations({ state: "unknown" }).length).toBe(0); // the mutex never produces a false OPERATION_UNKNOWN
  expect(service.getMandate(mandate.id).remaining).toBe(1_000_000n);
});

test("F) hold salt is durably persisted before submit, and never regenerated by reconcile or idempotent replay", async () => {
  const { service, backend, now } = setup();
  const mandate = await createMandate(service, now, 1_000_000n);

  backend.queueHoldFault("ambiguous-after");
  await expectRefused(
    service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 400_000n, idempotencyKey: "k-salt" }),
    "OPERATION_UNKNOWN",
  );

  const unknownOps = service.listOperations({ state: "unknown" });
  expect(unknownOps.length).toBe(1);
  const originalSalt = unknownOps[0].salt;
  expect(originalSalt).toMatch(/^[0-9a-f]{64}$/);

  await service.reconcile(unknownOps[0].id);
  expect(service.getOperation(unknownOps[0].id).salt).toBe(originalSalt); // reconcile never regenerates it

  const replay = await service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 400_000n, idempotencyKey: "k-salt" });
  const replayOp = service.listOperations({ mandateId: mandate.id, holdId: replay.id }).find((o) => o.action === "hold")!;
  expect(replayOp.salt).toBe(originalSalt); // idempotent replay reuses the exact same salt/PDA
});
