/**
 * MVP-03: a successful capture/refund/release must commit its hold/mandate mutation and its op's
 * terminal state as ONE durable write (see StateStore.putOpCommit / PaymentService.
 * finalizeOpSucceeded). These tests simulate a crash exactly at that boundary — the backend call
 * already landed, but the local commit never reaches disk — by dropping the service and rebuilding
 * a fresh one from the same store directory, then reconciling (twice, to prove idempotence).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { AuditEntry } from "../src/audit.js";
import { MockBackend } from "../src/backend/mock.js";
import { PaymentService } from "../src/service.js";
import { FileStateStore, type OpCommit, type OperationRecord, type StateStore, type StoredDispute, type StoredHold, type StoredMandate } from "../src/store.js";

const PAYER = "payer";
const PAYEE = "payee";
const SECRET = "test-secret-0123456789";

/** Wraps a real StateStore and throws instead of persisting the Nth call to a chosen method —
 * simulating a crash at that exact durable-write boundary: the write never reaches disk, so a
 * freshly rebuilt service over the same directory sees state as of just before the crash. */
class CrashingStore implements StateStore {
  private calls = 0;

  constructor(
    private readonly inner: StateStore,
    private readonly method: "putOp" | "putOpCommit",
    private readonly failOnCall: number,
  ) {}

  load() {
    return this.inner.load();
  }
  putMandate(m: StoredMandate) {
    this.inner.putMandate(m);
  }
  putHold(h: StoredHold) {
    this.inner.putHold(h);
  }
  putDispute(d: StoredDispute) {
    this.inner.putDispute(d);
  }
  putOp(op: OperationRecord) {
    if (this.method === "putOp" && ++this.calls === this.failOnCall) {
      throw new Error("simulated crash: putOp never reached disk");
    }
    this.inner.putOp(op);
  }
  putOpCommit(c: OpCommit) {
    if (this.method === "putOpCommit" && ++this.calls === this.failOnCall) {
      throw new Error("simulated crash: putOpCommit never reached disk");
    }
    this.inner.putOpCommit(c);
  }
  appendAudit(e: AuditEntry) {
    this.inner.appendAudit(e);
  }
}

function mandateArgs(now: () => number, totalBudget = 1_000_000n) {
  return {
    actor: PAYER,
    payer: PAYER,
    totalBudget,
    perTxCap: totalBudget,
    expiresAt: now() + 1000,
    allowedCounterparties: [PAYEE],
  };
}

test("capture: crash between backend success and local commit -> restart + reconcile x2 applies exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "singit-atomic-capture-"));
  const now = () => 1_800_000_000;
  const mock = new MockBackend({ now, balances: { [PAYER]: 1_000_000_000n, [PAYEE]: 1_000_000_000n } });
  const captureSpy = vi.spyOn(mock, "capture");

  const service1 = new PaymentService({ backend: mock, now, approvalSecret: SECRET, store: new CrashingStore(new FileStateStore(dir), "putOpCommit", 3) }); // 1-2: the hold's reservation + its success
  const mandate = await service1.createMandate(mandateArgs(now));
  const hold = await service1.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 400_000n });

  await expect(service1.capture({ actor: PAYEE, holdId: hold.id, amount: 150_000n, idempotencyKey: "cap-1" })).rejects.toThrow();
  expect(captureSpy).toHaveBeenCalledTimes(1); // the backend call really landed

  // restart: brand-new service over the same dir and the same backend (on-chain state persists)
  const service2 = new PaymentService({ backend: mock, now, approvalSecret: SECRET, store: new FileStateStore(dir) });
  // the crash means neither the hold mutation nor the op's success ever reached disk
  expect(service2.getHold(hold.id).captured).toBe(0n);
  expect(service2.getHold(hold.id).held).toBe(400_000n);
  const captureOp = service2.listOperations({ holdId: hold.id }).find((o) => o.action === "capture")!;
  expect(captureOp.state).toBe("unknown");

  await service2.reconcile(captureOp.id);
  await service2.reconcile(captureOp.id); // idempotent: already terminal, must not re-apply

  expect(service2.getOperation(captureOp.id).state).toBe("succeeded");
  expect(service2.getHold(hold.id).captured).toBe(150_000n); // exactly once, not 300_000n
  expect(service2.getHold(hold.id).held).toBe(250_000n);
  expect(captureSpy).toHaveBeenCalledTimes(1); // recovery never re-sends
});

test("refund: crash between backend success and local commit -> restart + reconcile x2 applies exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "singit-atomic-refund-"));
  const now = () => 1_800_000_000;
  const mock = new MockBackend({ now, balances: { [PAYER]: 1_000_000_000n, [PAYEE]: 1_000_000_000n } });

  const service1 = new PaymentService({ backend: mock, now, approvalSecret: SECRET, store: new FileStateStore(dir) });
  const mandate = await service1.createMandate(mandateArgs(now));
  const hold = await service1.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 400_000n });
  await service1.capture({ actor: PAYEE, holdId: hold.id, amount: 300_000n });

  const refundSpy = vi.spyOn(mock, "refund");
  const crashingService = new PaymentService({
    backend: mock,
    now,
    approvalSecret: SECRET,
    store: new CrashingStore(new FileStateStore(dir), "putOpCommit", 1),
  });
  await expect(
    crashingService.refund({ actor: PAYEE, holdId: hold.id, amount: 100_000n, idempotencyKey: "ref-1" }),
  ).rejects.toThrow();
  expect(refundSpy).toHaveBeenCalledTimes(1);

  const service2 = new PaymentService({ backend: mock, now, approvalSecret: SECRET, store: new FileStateStore(dir) });
  expect(service2.getHold(hold.id).refunded).toBe(0n); // never committed locally

  const refundOp = service2.listOperations({ holdId: hold.id }).find((o) => o.action === "refund")!;
  expect(refundOp.state).toBe("unknown");

  await service2.reconcile(refundOp.id);
  await service2.reconcile(refundOp.id);

  expect(service2.getOperation(refundOp.id).state).toBe("succeeded");
  expect(service2.getHold(hold.id).refunded).toBe(100_000n); // exactly once, not 200_000n
  expect(refundSpy).toHaveBeenCalledTimes(1);
});

test("release: crash between backend success and local commit -> restart + reconcile x2 applies exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "singit-atomic-release-"));
  const now = () => 1_800_000_000;
  const mock = new MockBackend({ now, balances: { [PAYER]: 1_000_000_000n, [PAYEE]: 1_000_000_000n } });
  const releaseSpy = vi.spyOn(mock, "release");

  const service1 = new PaymentService({ backend: mock, now, approvalSecret: SECRET, store: new CrashingStore(new FileStateStore(dir), "putOpCommit", 3) }); // 1-2: the hold's reservation + its success
  const mandate = await service1.createMandate(mandateArgs(now));
  const hold = await service1.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 400_000n });

  await expect(service1.release({ actor: PAYEE, holdId: hold.id, idempotencyKey: "rel-1" })).rejects.toThrow();
  expect(releaseSpy).toHaveBeenCalledTimes(1);

  const service2 = new PaymentService({ backend: mock, now, approvalSecret: SECRET, store: new FileStateStore(dir) });
  expect(service2.getHold(hold.id).held).toBe(400_000n); // never committed locally
  expect(service2.getMandate(mandate.id).mandate.committed).toBe(400_000n);

  const releaseOp = service2.listOperations({ holdId: hold.id }).find((o) => o.action === "release")!;
  expect(releaseOp.state).toBe("unknown");

  await service2.reconcile(releaseOp.id);
  await service2.reconcile(releaseOp.id);

  expect(service2.getOperation(releaseOp.id).state).toBe("succeeded");
  expect(service2.getHold(hold.id).held).toBe(0n);
  expect(service2.getMandate(mandate.id).mandate.committed).toBe(0n); // freed exactly once
  expect(releaseSpy).toHaveBeenCalledTimes(1);
});

test("store write failure before send means no send (beginOp's putOp fails -> backend never called)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "singit-atomic-noop-"));
  const now = () => 1_800_000_000;
  const mock = new MockBackend({ now, balances: { [PAYER]: 1_000_000_000n, [PAYEE]: 1_000_000_000n } });
  const captureSpy = vi.spyOn(mock, "capture");

  const service1 = new PaymentService({ backend: mock, now, approvalSecret: SECRET, store: new FileStateStore(dir) });
  const mandate = await service1.createMandate(mandateArgs(now));
  const hold = await service1.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 400_000n });

  const crashingService = new PaymentService({
    backend: mock,
    now,
    approvalSecret: SECRET,
    store: new CrashingStore(new FileStateStore(dir), "putOp", 1), // first putOp after restart: beginOp's reservation write
  });
  await expect(crashingService.capture({ actor: PAYEE, holdId: hold.id, amount: 150_000n })).rejects.toThrow();
  expect(captureSpy).not.toHaveBeenCalled();
});
