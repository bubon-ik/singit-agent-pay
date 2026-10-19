import { expect, test, vi } from "vitest";
import { issueApprovalToken } from "../src/approval.js";
import { MockBackend } from "../src/backend/mock.js";
import type {
  CaptureRequest,
  EscrowStatus,
  HoldRequest,
  MandateTerms,
  PaymentBackend,
  RefundRequest,
  ReleaseRequest,
} from "../src/backend/types.js";
import { PaymentService } from "../src/service.js";

const SECRET = "test-secret-0123456789";
const PAYER = "payer";
const PAYEE = "payee";

function setup(opts: { approvalSecret?: string } = {}) {
  let t = 1_800_000_000;
  const now = () => t;
  const backend = new MockBackend({ now, balances: { [PAYER]: 1_000_000_000n, [PAYEE]: 1_000_000_000n } });
  const service = new PaymentService({
    backend,
    now,
    approvalSecret: "approvalSecret" in opts ? opts.approvalSecret : SECRET,
  });
  return { service, backend, now, advance: (seconds: number) => (t += seconds) };
}

async function createMandate(
  service: PaymentService,
  overrides: { totalBudget?: bigint; perTxCap?: bigint; expiresAt: number; allowedCounterparties?: string[] },
) {
  return service.createMandate({
    actor: PAYER,
    payer: PAYER,
    totalBudget: overrides.totalBudget ?? 1_000_000n,
    perTxCap: overrides.perTxCap ?? 1_000_000n,
    expiresAt: overrides.expiresAt,
    allowedCounterparties: overrides.allowedCounterparties ?? [PAYEE],
  });
}

async function expectRefused(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ name: "Refusal", code });
}

/** A backend whose getStatus reports a different mint than the one actually requested (QA M-2b). */
class WrongMintBackend implements PaymentBackend {
  readonly name = "wrong-mint-test";
  constructor(private readonly inner: MockBackend) {}
  createMandate(terms: MandateTerms) {
    return this.inner.createMandate(terms);
  }
  hold(req: HoldRequest) {
    return this.inner.hold(req);
  }
  capture(req: CaptureRequest) {
    return this.inner.capture(req);
  }
  release(req: ReleaseRequest) {
    return this.inner.release(req);
  }
  refund(req: RefundRequest) {
    return this.inner.refund(req);
  }
  async getStatus(holdId: string): Promise<EscrowStatus | null> {
    const status = await this.inner.getStatus(holdId);
    if (!status) return null;
    return { ...status, mint: "definitely-not-devnet-usdc" };
  }
}

test("overspend blocked across two holds (QA M-1)", async () => {
  const { service, backend, now } = setup();
  const mandate = await createMandate(service, { totalBudget: 1_000_000n, perTxCap: 700_000n, expiresAt: now() + 1000 });
  const holdSpy = vi.spyOn(backend, "hold");

  await service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 600_000n });
  expect(holdSpy).toHaveBeenCalledTimes(1);

  await expectRefused(
    service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 500_000n }),
    "OVER_BUDGET",
  );
  expect(holdSpy).toHaveBeenCalledTimes(1); // backend.hold was NOT called for the refused second hold

  const entries = service.listAuditLog({ mandateId: mandate.id });
  const last = entries[entries.length - 1];
  expect(last.outcome).toBe("blocked");
  expect(last.code).toBe("OVER_BUDGET");
});

test("hold over the per-tx cap -> OVER_PER_TX_CAP", async () => {
  const { service, now } = setup();
  const mandate = await createMandate(service, { perTxCap: 300_000n, expiresAt: now() + 1000 });
  await expectRefused(
    service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 400_000n }),
    "OVER_PER_TX_CAP",
  );
});

test("hold to a disallowed counterparty -> COUNTERPARTY_NOT_ALLOWED", async () => {
  const { service, now } = setup();
  const mandate = await createMandate(service, { expiresAt: now() + 1000, allowedCounterparties: ["someone-else"] });
  await expectRefused(
    service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 100_000n }),
    "COUNTERPARTY_NOT_ALLOWED",
  );
});

test("hold after mandate expiry -> MANDATE_EXPIRED", async () => {
  const { service, now, advance } = setup();
  const mandate = await createMandate(service, { expiresAt: now() + 500 });
  advance(600);
  await expectRefused(
    service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 100_000n }),
    "MANDATE_EXPIRED",
  );
});

test("wrong mint on the request -> WRONG_MINT (QA M-2)", async () => {
  const { service, now } = setup();
  const mandate = await createMandate(service, { expiresAt: now() + 1000 });
  await expectRefused(
    service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 100_000n, mint: "some-other-mint" }),
    "WRONG_MINT",
  );
});

test("backend reporting a different mint on getStatus -> WRONG_MINT and funds released (QA M-2)", async () => {
  let t = 1_800_000_000;
  const now = () => t;
  const inner = new MockBackend({ now, balances: { [PAYER]: 1_000_000_000n, [PAYEE]: 0n } });
  const backend = new WrongMintBackend(inner);
  const service = new PaymentService({ backend, now, approvalSecret: SECRET });
  const mandate = await createMandate(service, { expiresAt: now() + 1000 });

  await expectRefused(
    service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 500_000n }),
    "WRONG_MINT",
  );

  expect(service.getMandate(mandate.id).remaining).toBe(1_000_000n); // committed reverted

  const entries = service.listAuditLog({ mandateId: mandate.id });
  const last = entries[entries.length - 1];
  expect(last.code).toBe("WRONG_MINT");
  expect(last.held).toBe("0"); // release succeeded: nothing left held
});

test("hold: backend reports a non-devnet-USDC mint on getStatus -> WRONG_MINT, hold not active, budget restored, remainder released", async () => {
  let t = 1_800_000_000;
  const now = () => t;
  const inner = new MockBackend({ now, balances: { [PAYER]: 1_000_000_000n, [PAYEE]: 0n } });
  const releaseSpy = vi.spyOn(inner, "release");
  const backend = new WrongMintBackend(inner);
  const service = new PaymentService({ backend, now, approvalSecret: SECRET });
  const mandate = await createMandate(service, { expiresAt: now() + 1000 });
  const before = service.getMandate(mandate.id);

  await expectRefused(
    service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 500_000n }),
    "WRONG_MINT",
  );

  const after = service.getMandate(mandate.id);
  expect(after.mandate.committed).toBe(before.mandate.committed);
  expect(after.remaining).toBe(before.remaining);

  const entries = service.listAuditLog({ mandateId: mandate.id });
  const last = entries[entries.length - 1];
  expect(last.code).toBe("WRONG_MINT");
  const holdId = last.holdId as string;
  expect(holdId).toBeTruthy();
  expect(() => service.getHold(holdId)).toThrow();

  expect(releaseSpy).toHaveBeenCalledTimes(1);
  expect(releaseSpy).toHaveBeenCalledWith(expect.objectContaining({ holdId, expectedHeld: 500_000n, expectedRefundable: 0n }));
});

test("captureDeadline in milliseconds -> INVALID_DEADLINE (QA M-3)", async () => {
  const { service, now } = setup();
  const mandate = await createMandate(service, { expiresAt: now() + 30 * 86400 });
  await expectRefused(
    service.hold({
      actor: PAYER,
      mandateId: mandate.id,
      payee: PAYEE,
      amount: 100_000n,
      captureDeadline: (now() + 3600) * 1000,
    }),
    "INVALID_DEADLINE",
  );
});

test("captureDeadline beyond 7 days -> INVALID_DEADLINE (QA M-3)", async () => {
  const { service, now } = setup();
  const mandate = await createMandate(service, { expiresAt: now() + 30 * 86400 });
  await expectRefused(
    service.hold({
      actor: PAYER,
      mandateId: mandate.id,
      payee: PAYEE,
      amount: 100_000n,
      captureDeadline: now() + 8 * 86400,
    }),
    "INVALID_DEADLINE",
  );
});

test("refund window under 1h -> INVALID_DEADLINE (QA M-3)", async () => {
  const { service, now } = setup();
  const mandate = await createMandate(service, { expiresAt: now() + 30 * 86400 });
  const captureDeadline = now() + 3600;
  await expectRefused(
    service.hold({
      actor: PAYER,
      mandateId: mandate.id,
      payee: PAYEE,
      amount: 100_000n,
      captureDeadline,
      refundDeadline: captureDeadline + 1800,
    }),
    "INVALID_DEADLINE",
  );
});

test("capture exceeding held -> CAPTURE_EXCEEDS_HOLD", async () => {
  const { service, now } = setup();
  const mandate = await createMandate(service, { expiresAt: now() + 1000 });
  const hold = await service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 500_000n });
  await expectRefused(
    service.capture({ actor: PAYEE, holdId: hold.id, amount: 600_000n }),
    "CAPTURE_EXCEEDS_HOLD",
  );
});

test("partial capture then release returns the remainder and frees budget", async () => {
  const { service, now } = setup();
  const mandate = await createMandate(service, { expiresAt: now() + 1000 });
  const hold = await service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 600_000n });
  expect(service.getMandate(mandate.id).remaining).toBe(400_000n);

  await service.capture({ actor: PAYEE, holdId: hold.id, amount: 300_000n });
  expect(service.getMandate(mandate.id).remaining).toBe(400_000n); // still committed until released

  await service.release({ actor: PAYEE, holdId: hold.id });
  expect(service.getMandate(mandate.id).remaining).toBe(700_000n); // the uncaptured 300000 is freed
});

test("refund exceeding captured -> REFUND_EXCEEDS_CAPTURED", async () => {
  const { service, now } = setup();
  const mandate = await createMandate(service, { expiresAt: now() + 1000 });
  const hold = await service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 500_000n });
  await service.capture({ actor: PAYEE, holdId: hold.id, amount: 200_000n });
  await expectRefused(
    service.refund({ actor: PAYEE, holdId: hold.id, amount: 300_000n }),
    "REFUND_EXCEEDS_CAPTURED",
  );
});

test("valid refund succeeds and does not restore mandate budget", async () => {
  const { service, now } = setup();
  const mandate = await createMandate(service, { expiresAt: now() + 1000 });
  const hold = await service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 500_000n });
  await service.capture({ actor: PAYEE, holdId: hold.id, amount: 200_000n });
  const remainingBefore = service.getMandate(mandate.id).remaining;

  const refunded = await service.refund({ actor: PAYEE, holdId: hold.id, amount: 150_000n });
  expect(refunded.refunded).toBe(150_000n);
  expect(service.getMandate(mandate.id).remaining).toBe(remainingBefore);
});

test("open_dispute freezes capture (DISPUTE_OPEN) (QA H-1)", async () => {
  const { service, now } = setup();
  const mandate = await createMandate(service, { expiresAt: now() + 1000 });
  const hold = await service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 500_000n });
  await service.openDispute({ actor: PAYER, holdId: hold.id, reason: "not delivered", evidence: ["ticket-1"] });
  await expectRefused(service.capture({ actor: PAYEE, holdId: hold.id, amount: 100_000n }), "DISPUTE_OPEN");
});

test("open_dispute succeeds just before the refund deadline", async () => {
  const { service, now, advance } = setup();
  const mandate = await createMandate(service, { expiresAt: now() + 100_000 });
  const hold = await service.hold({
    actor: PAYER,
    mandateId: mandate.id,
    payee: PAYEE,
    amount: 500_000n,
    captureDeadline: now() + 1000,
    refundDeadline: now() + 1000 + 3600,
  });

  advance(hold.refundDeadline - now() - 1);
  const dispute = await service.openDispute({ actor: PAYER, holdId: hold.id, reason: "not delivered", evidence: [] });
  expect(dispute.status).toBe("open");
});

test("open_dispute at exactly the refund deadline -> REFUND_WINDOW_CLOSED", async () => {
  const { service, now, advance } = setup();
  const mandate = await createMandate(service, { expiresAt: now() + 100_000 });
  const hold = await service.hold({
    actor: PAYER,
    mandateId: mandate.id,
    payee: PAYEE,
    amount: 500_000n,
    captureDeadline: now() + 1000,
    refundDeadline: now() + 1000 + 3600,
  });

  advance(hold.refundDeadline - now());
  await expectRefused(
    service.openDispute({ actor: PAYER, holdId: hold.id, reason: "not delivered", evidence: [] }),
    "REFUND_WINDOW_CLOSED",
  );
  expect(service.listDisputes()).toEqual([]);

  const entries = service.listAuditLog({ mandateId: mandate.id });
  const last = entries[entries.length - 1];
  expect(last.action).toBe("open_dispute");
  expect(last.outcome).toBe("blocked");
  expect(last.code).toBe("REFUND_WINDOW_CLOSED");
});

test("open_dispute after the refund deadline -> REFUND_WINDOW_CLOSED", async () => {
  const { service, now, advance } = setup();
  const mandate = await createMandate(service, { expiresAt: now() + 100_000 });
  const hold = await service.hold({
    actor: PAYER,
    mandateId: mandate.id,
    payee: PAYEE,
    amount: 500_000n,
    captureDeadline: now() + 1000,
    refundDeadline: now() + 1000 + 3600,
  });

  advance(hold.refundDeadline - now() + 10);
  await expectRefused(
    service.openDispute({ actor: PAYER, holdId: hold.id, reason: "not delivered", evidence: [] }),
    "REFUND_WINDOW_CLOSED",
  );
  expect(service.listDisputes()).toEqual([]);
});

test("resolve_dispute requires a valid human approval token (QA H-1)", async () => {
  const { service, now } = setup();
  const mandate = await createMandate(service, { expiresAt: now() + 1000 });
  const hold = await service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 500_000n });
  await service.capture({ actor: PAYEE, holdId: hold.id, amount: 400_000n });
  const dispute = await service.openDispute({ actor: PAYER, holdId: hold.id, reason: "bad", evidence: [] });

  await expectRefused(
    service.resolveDispute({ actor: PAYER, disputeId: dispute.id, outcome: "refund", refundAmount: 400_000n }),
    "HUMAN_APPROVAL_REQUIRED",
  ); // missing token

  await expectRefused(
    service.resolveDispute({
      actor: PAYER,
      disputeId: dispute.id,
      outcome: "refund",
      refundAmount: 400_000n,
      approvalToken: "a".repeat(64),
    }),
    "HUMAN_APPROVAL_REQUIRED",
  ); // forged token

  const tokenForWrongAmount = issueApprovalToken(SECRET, { disputeId: dispute.id, outcome: "refund", refundAmount: 100_000n });
  await expectRefused(
    service.resolveDispute({
      actor: PAYER,
      disputeId: dispute.id,
      outcome: "refund",
      refundAmount: 400_000n,
      approvalToken: tokenForWrongAmount,
    }),
    "HUMAN_APPROVAL_REQUIRED",
  ); // token minted for a different amount

  // The dispute is still open: none of the above refusals resolved it.
  expect(service.getDispute(dispute.id).status).toBe("open");
});

test("resolve_dispute refuses when no approval secret is configured (QA H-1)", async () => {
  const { service, now } = setup({ approvalSecret: undefined });
  const mandate = await createMandate(service, { expiresAt: now() + 1000 });
  const hold = await service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 500_000n });
  await service.capture({ actor: PAYEE, holdId: hold.id, amount: 400_000n });
  const dispute = await service.openDispute({ actor: PAYER, holdId: hold.id, reason: "bad", evidence: [] });

  const token = issueApprovalToken(SECRET, { disputeId: dispute.id, outcome: "refund", refundAmount: 400_000n });
  await expectRefused(
    service.resolveDispute({
      actor: PAYER,
      disputeId: dispute.id,
      outcome: "refund",
      refundAmount: 400_000n,
      approvalToken: token,
    }),
    "HUMAN_APPROVAL_REQUIRED",
  );
});

test("valid human token executes the refund and tags the audit actor (QA H-1)", async () => {
  const { service, now } = setup();
  const mandate = await createMandate(service, { expiresAt: now() + 1000 });
  const hold = await service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 500_000n });
  await service.capture({ actor: PAYEE, holdId: hold.id, amount: 400_000n });
  const dispute = await service.openDispute({ actor: PAYER, holdId: hold.id, reason: "bad", evidence: [] });
  const token = issueApprovalToken(SECRET, { disputeId: dispute.id, outcome: "refund", refundAmount: 400_000n });

  const resolved = await service.resolveDispute({
    actor: PAYER,
    disputeId: dispute.id,
    outcome: "refund",
    refundAmount: 400_000n,
    approvalToken: token,
  });
  expect(resolved.status).toBe("resolved");
  expect(resolved.outcome).toBe("refund");

  const entries = service.listAuditLog({ mandateId: mandate.id });
  const last = entries[entries.length - 1];
  expect(last.action).toBe("resolve_dispute");
  expect(last.actor.startsWith("human-approved:")).toBe(true);
});

test("reject outcome resolves the dispute and sends no tx (QA H-1)", async () => {
  const { service, now } = setup();
  const mandate = await createMandate(service, { expiresAt: now() + 1000 });
  const hold = await service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 500_000n });
  const dispute = await service.openDispute({ actor: PAYER, holdId: hold.id, reason: "bad", evidence: [] });
  const token = issueApprovalToken(SECRET, { disputeId: dispute.id, outcome: "reject" });

  const resolved = await service.resolveDispute({ actor: PAYER, disputeId: dispute.id, outcome: "reject", approvalToken: token });
  expect(resolved.status).toBe("resolved");
  expect(resolved.outcome).toBe("reject");
  expect(resolved.txSigs.length).toBe(0);
});

test("audit log entries are schema-complete and tx-stamped for money ops", async () => {
  const { service, now } = setup();
  const mandate = await createMandate(service, { expiresAt: now() + 1000 });
  const hold = await service.hold({ actor: PAYER, mandateId: mandate.id, payee: PAYEE, amount: 500_000n });
  await service.capture({ actor: PAYEE, holdId: hold.id, amount: 200_000n });
  await service.refund({ actor: PAYEE, holdId: hold.id, amount: 100_000n });

  const entries = service.listAuditLog();
  expect(entries.length).toBeGreaterThan(0);

  const expectedKeys = [
    "v", "seq", "ts", "actor", "action", "outcome", "code", "reason",
    "mandateId", "holdId", "disputeId", "amount", "txSig", "held", "refundable",
  ].sort();

  for (const entry of entries) {
    expect(entry.v).toBe(1);
    expect(Object.keys(entry).sort()).toEqual(expectedKeys);
    if (entry.outcome === "ok" && ["hold", "capture", "release", "refund"].includes(entry.action)) {
      expect(entry.txSig).not.toBeNull();
    }
  }
});
