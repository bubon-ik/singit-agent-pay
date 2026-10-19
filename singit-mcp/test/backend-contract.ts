/**
 * Shared conformance suite for any PaymentBackend implementation. Run it against MockBackend
 * (test/backend-contract.mock.test.ts) and Capture402Backend on devnet
 * (test/backend-contract.capture402.test.ts). NOT a *.test.ts file itself so vitest's default
 * file discovery does not pick it up directly.
 */
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { BackendError, DEVNET_USDC_MINT, type PaymentBackend } from "../src/backend/types.js";
import { PaymentService } from "../src/service.js";

export interface ContractFixture {
  backend: PaymentBackend;
  payer: string;
  payee: string;
  /** Base units per "1 test USDC" used by this suite. Mock: 1_000_000n; devnet may use smaller. */
  unit: bigint;
  now(): number;
  /** Only present when the fixture controls the clock. */
  advance?(seconds: number): void;
  unknownHoldId: string;
  /** If set, run the wrong-mint case using this mint address. */
  wrongMint?: string;
}

function salt(): string {
  return randomBytes(32).toString("hex");
}

/** Asserts `promise` rejects with a BackendError whose code matches, allowing the
 * capture402 facilitator's "invalid_auth_capture_svm_" + code prefix. */
export async function expectBackendCode(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected the promise to reject").toBeInstanceOf(BackendError);
  const err = caught as BackendError;
  expect(err.name).toBe("BackendError");
  expect(typeof err.code).toBe("string");
  expect(err.code.length).toBeGreaterThan(0);
  expect([code, `invalid_auth_capture_svm_${code}`]).toContain(err.code);
}

export function runBackendContract(
  label: string,
  makeFixture: () => Promise<ContractFixture> | ContractFixture,
  opts: { skip?: boolean; timeoutMs?: number } = {},
): void {
  const timeout = opts.timeoutMs;

  describe.skipIf(opts.skip ?? false)(label, () => {
    let fx: ContractFixture;

    beforeEach(async () => {
      fx = await makeFixture();
    });

    function deadlines(): { captureDeadline: number; refundDeadline: number } {
      const captureDeadline = fx.now() + 3600;
      const refundDeadline = captureDeadline + 86400;
      return { captureDeadline, refundDeadline };
    }

    async function openHold(maximum: bigint = fx.unit) {
      const { captureDeadline, refundDeadline } = deadlines();
      const receipt = await fx.backend.hold({
        payer: fx.payer,
        mint: DEVNET_USDC_MINT,
        payee: fx.payee,
        maximum,
        captureDeadline,
        refundDeadline,
        salt: salt(),
      });
      return { receipt, captureDeadline, refundDeadline };
    }

    test(
      "a. shape: name, createMandate, hold",
      async () => {
        expect(typeof fx.backend.name).toBe("string");
        expect(fx.backend.name.length).toBeGreaterThan(0);

        const mandateRef = await fx.backend.createMandate({
          id: "contract-mandate-shape",
          payer: fx.payer,
          totalBudget: fx.unit,
          perTxCap: fx.unit,
          expiresAt: fx.now() + 86400,
          allowedCounterparties: [fx.payee],
        });
        expect(typeof mandateRef).toBe("object");

        const { receipt } = await openHold();
        expect(typeof receipt.holdId).toBe("string");
        expect(receipt.holdId.length).toBeGreaterThan(0);
        expect(typeof receipt.txSig).toBe("string");
        expect(receipt.txSig.length).toBeGreaterThan(0);
      },
      timeout,
    );

    test(
      "b. getStatus after hold returns all EscrowStatus fields",
      async () => {
        const { receipt, captureDeadline, refundDeadline } = await openHold();
        const status = await fx.backend.getStatus(receipt.holdId);
        expect(status).not.toBeNull();
        const s = status!;
        expect(s.holdId).toBe(receipt.holdId);
        expect(s.payer).toBe(fx.payer);
        expect(s.payee).toBe(fx.payee);
        expect(s.mint).toBe(DEVNET_USDC_MINT);
        expect(typeof s.maximum).toBe("bigint");
        expect(typeof s.held).toBe("bigint");
        expect(typeof s.refundable).toBe("bigint");
        expect(s.maximum).toBe(fx.unit);
        expect(s.held).toBe(fx.unit);
        expect(s.refundable).toBe(0n);
        expect(s.captureDeadline).toBe(captureDeadline);
        expect(s.refundDeadline).toBe(refundDeadline);
      },
      timeout,
    );

    test(
      "c. getStatus(unknownHoldId) resolves null",
      async () => {
        await expect(fx.backend.getStatus(fx.unknownHoldId)).resolves.toBeNull();
      },
      timeout,
    );

    test(
      "d. partial capture then release remainder (releaseRemainder:false)",
      async () => {
        const { receipt } = await openHold();
        const captureAmount = (fx.unit * 6n) / 10n;

        const captureReceipt = await fx.backend.capture({
          holdId: receipt.holdId,
          amount: captureAmount,
          releaseRemainder: false,
          expectedHeld: fx.unit,
          expectedRefundable: 0n,
        });
        let status = (await fx.backend.getStatus(receipt.holdId))!;
        expect(status.held).toBe(fx.unit - captureAmount);
        expect(status.refundable).toBe(captureAmount);

        const releaseReceipt = await fx.backend.release({
          holdId: receipt.holdId,
          expectedHeld: status.held,
          expectedRefundable: status.refundable,
        });
        status = (await fx.backend.getStatus(receipt.holdId))!;
        expect(status.held).toBe(0n);
        expect(status.refundable).toBe(captureAmount);

        expect(captureReceipt.txSig.length).toBeGreaterThan(0);
        expect(releaseReceipt.txSig.length).toBeGreaterThan(0);
        expect(captureReceipt.txSig).not.toBe(releaseReceipt.txSig);
      },
      timeout,
    );

    test(
      "e. partial capture with releaseRemainder:true",
      async () => {
        const { receipt } = await openHold();
        const captureAmount = (fx.unit * 6n) / 10n;

        await fx.backend.capture({
          holdId: receipt.holdId,
          amount: captureAmount,
          releaseRemainder: true,
          expectedHeld: fx.unit,
          expectedRefundable: 0n,
        });
        const status = (await fx.backend.getStatus(receipt.holdId))!;
        expect(status.held).toBe(0n);
        expect(status.refundable).toBe(captureAmount);
      },
      timeout,
    );

    test(
      "f. capture more than held -> amount; stale guards -> unexpected_payment_state",
      async () => {
        const { receipt } = await openHold();

        await expectBackendCode(
          fx.backend.capture({
            holdId: receipt.holdId,
            amount: fx.unit + 1n,
            releaseRemainder: false,
            expectedHeld: fx.unit,
            expectedRefundable: 0n,
          }),
          "amount",
        );

        await expectBackendCode(
          fx.backend.capture({
            holdId: receipt.holdId,
            amount: fx.unit / 2n,
            releaseRemainder: false,
            expectedHeld: fx.unit + 1n,
            expectedRefundable: 0n,
          }),
          "unexpected_payment_state",
        );

        await expectBackendCode(
          fx.backend.release({
            holdId: receipt.holdId,
            expectedHeld: fx.unit + 1n,
            expectedRefundable: 0n,
          }),
          "unexpected_payment_state",
        );
      },
      timeout,
    );

    test(
      "g. refund limits",
      async () => {
        const { receipt } = await openHold();
        const captureAmount = (fx.unit * 6n) / 10n;
        await fx.backend.capture({
          holdId: receipt.holdId,
          amount: captureAmount,
          releaseRemainder: false,
          expectedHeld: fx.unit,
          expectedRefundable: 0n,
        });

        const refundAmount = (fx.unit * 2n) / 10n;
        await fx.backend.refund({
          holdId: receipt.holdId,
          amount: refundAmount,
          expectedHeld: fx.unit - captureAmount,
          expectedRefundable: captureAmount,
        });
        const status = (await fx.backend.getStatus(receipt.holdId))!;
        expect(status.refundable).toBe(captureAmount - refundAmount);

        await expectBackendCode(
          fx.backend.refund({
            holdId: receipt.holdId,
            amount: captureAmount, // exceeds the remaining refundable
            expectedHeld: status.held,
            expectedRefundable: status.refundable,
          }),
          "amount",
        );
      },
      timeout,
    );

    test(
      "h. deadline expiry (only when the fixture controls the clock)",
      async (ctx) => {
        if (!fx.advance) {
          ctx.skip();
          return;
        }
        const { receipt } = await openHold();

        fx.advance(3600); // now === captureDeadline
        await expectBackendCode(
          fx.backend.capture({
            holdId: receipt.holdId,
            amount: fx.unit,
            releaseRemainder: false,
            expectedHeld: fx.unit,
            expectedRefundable: 0n,
          }),
          "capture_deadline_expired",
        );

        fx.advance(86400); // now === refundDeadline
        await expectBackendCode(
          fx.backend.refund({
            holdId: receipt.holdId,
            amount: 1n,
            expectedHeld: fx.unit,
            expectedRefundable: 0n,
          }),
          "refund_deadline_expired",
        );
      },
      timeout,
    );

    test(
      "i. wrong mint (only when fixture.wrongMint is set)",
      async (ctx) => {
        if (!fx.wrongMint) {
          ctx.skip();
          return;
        }
        const { captureDeadline, refundDeadline } = deadlines();
        try {
          const receipt = await fx.backend.hold({
            payer: fx.payer,
            mint: fx.wrongMint,
            payee: fx.payee,
            maximum: fx.unit,
            captureDeadline,
            refundDeadline,
            salt: salt(),
          });
          const status = await fx.backend.getStatus(receipt.holdId);
          expect(status).not.toBeNull();
          expect(status!.mint).toBe(fx.wrongMint);
          expect(status!.mint).not.toBe(DEVNET_USDC_MINT);
        } catch (err) {
          expect(err).toBeInstanceOf(BackendError);
        }
      },
      timeout,
    );

    test(
      "k. integration through PaymentService",
      async () => {
        const service = new PaymentService({ backend: fx.backend, now: fx.now, approvalSecret: "contract-secret-0123456789" });
        const mandate = await service.createMandate({
          actor: fx.payer,
          payer: fx.payer,
          totalBudget: fx.unit,
          perTxCap: fx.unit,
          expiresAt: fx.now() + 200_000,
          allowedCounterparties: [fx.payee],
        });

        const hold = await service.hold({ actor: fx.payer, mandateId: mandate.id, payee: fx.payee, amount: fx.unit });
        expect(hold.refundDeadline).toBeGreaterThan(hold.captureDeadline);

        const captureAmount = (fx.unit * 6n) / 10n;
        const captured = await service.capture({ actor: fx.payee, holdId: hold.id, amount: captureAmount });
        expect(captured.held).toBe(fx.unit - captureAmount);

        const released = await service.release({ actor: fx.payee, holdId: hold.id });
        expect(released.held).toBe(0n);

        const dispute = await service.openDispute({ actor: fx.payer, holdId: hold.id, reason: "contract suite check", evidence: [] });
        expect(dispute.status).toBe("open");
      },
      timeout,
    );
  });
}
