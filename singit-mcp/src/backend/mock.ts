/**
 * In-memory PaymentBackend. Mirrors the capture402 on-chain checks (see INTERFACE.md
 * "On-chain rules") so that tests written against MockBackend also exercise the same
 * failure paths Capture402Backend will hit on devnet. Error codes mirror the facilitator's
 * `Reason` names (integration/src/facilitator.ts), minus the `invalid_auth_capture_svm_` prefix.
 */
import {
  BackendError,
  type CaptureRequest,
  type EscrowStatus,
  type HoldReceipt,
  type HoldRequest,
  type MandateTerms,
  type PaymentBackend,
  type RefundRequest,
  type ReleaseRequest,
  type SubmitContext,
  type TxOutcome,
  type TxOutcomeQuery,
  type TxReceipt,
} from "./types.js";

interface HeldPayment {
  payer: string;
  payee: string;
  mint: string;
  maximum: bigint;
  held: bigint;
  refundable: bigint;
  captureDeadline: number;
  refundDeadline: number;
}

export interface MockBackendOptions {
  /** Unix seconds. Defaults to the real clock. */
  now?: () => number;
  /** Synthetic token balances per address, by base units. Defaults to a copy of DEFAULT_MOCK_BALANCES. */
  balances?: Record<string, bigint>;
}

/** Starting balances for the mock backend when no explicit/env override is given. */
export const DEFAULT_MOCK_BALANCES: Record<string, bigint> = {
  "buyer-agent": 100_000_000n,
  "seller-agent": 20_000_000n,
  "agent:research-bot": 100_000_000n,
  // The dashboard story uses agent:-prefixed seller ids.
  "agent:data-vendor": 20_000_000n,
  "agent:gpu-broker": 20_000_000n,
};

/** Parses SINGIT_MOCK_BALANCES (JSON {"addr":"baseUnits"}) if set, else returns a copy of DEFAULT_MOCK_BALANCES. */
export function mockBalancesFromEnv(env: NodeJS.ProcessEnv): Record<string, bigint> {
  const raw = env.SINGIT_MOCK_BALANCES;
  if (!raw) return { ...DEFAULT_MOCK_BALANCES };
  return Object.fromEntries(Object.entries(JSON.parse(raw) as Record<string, string>).map(([addr, v]) => [addr, BigInt(v)]));
}

/** A txSig this backend issued, remembered so getTxOutcome can answer without any real chain. */
interface TxSigRecord {
  kind: "hold" | "capture" | "release" | "refund";
  holdId: string;
  executed: boolean;
}

export class MockBackend implements PaymentBackend {
  readonly name = "mock";

  private readonly now: () => number;
  private readonly balances: Map<string, bigint>;
  private readonly payments = new Map<string, HeldPayment>();
  /** Every txSig this backend has handed out via onPrepared, prepared or executed (QA: reconcile support). */
  private readonly txSigs = new Map<string, TxSigRecord>();
  private holdSeq = 0;
  private txSeq = 0;

  constructor(opts: MockBackendOptions = {}) {
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.balances = new Map(Object.entries(opts.balances ?? DEFAULT_MOCK_BALANCES));
  }

  private balanceOf(address: string): bigint {
    return this.balances.get(address) ?? 0n;
  }

  private credit(address: string, amount: bigint): void {
    this.balances.set(address, this.balanceOf(address) + amount);
  }

  private debit(address: string, amount: bigint): void {
    this.balances.set(address, this.balanceOf(address) - amount);
  }

  private nextTxSig(): string {
    return `mock-tx-${++this.txSeq}`;
  }

  private require(payment: HeldPayment, expectedHeld: bigint, expectedRefundable: bigint): void {
    if (payment.held !== expectedHeld || payment.refundable !== expectedRefundable) {
      throw new BackendError(
        "unexpected_payment_state",
        `unexpected payment state: held=${payment.held} refundable=${payment.refundable}, expected held=${expectedHeld} refundable=${expectedRefundable}`,
      );
    }
  }

  private find(holdId: string): HeldPayment {
    const payment = this.payments.get(holdId);
    if (!payment) {
      throw new BackendError("payment_not_found", `payment not found: ${holdId}`);
    }
    return payment;
  }

  async createMandate(_terms: MandateTerms): Promise<{ ref?: string }> {
    return {};
  }

  async hold(req: HoldRequest, ctx?: SubmitContext): Promise<HoldReceipt> {
    if (req.payer === req.payee) {
      throw new BackendError("accounts", "payer and server must be distinct accounts");
    }
    if (req.maximum <= 0n) {
      throw new BackendError("amount", "maximum must be > 0");
    }
    const now = this.now();
    if (!(now < req.captureDeadline && req.captureDeadline <= req.refundDeadline)) {
      throw new BackendError(
        "deadline_ordering",
        `deadlines out of order: require now (${now}) < captureDeadline (${req.captureDeadline}) <= refundDeadline (${req.refundDeadline})`,
      );
    }
    if (this.balanceOf(req.payer) < req.maximum) {
      throw new BackendError("insufficient_funds", `payer ${req.payer} has insufficient balance for ${req.maximum}`);
    }

    const holdId = `mock-hold-${++this.holdSeq}`;
    const txSig = this.nextTxSig();
    this.txSigs.set(txSig, { kind: "hold", holdId, executed: false });
    if (ctx?.onPrepared) await ctx.onPrepared({ txSig, holdId });

    this.debit(req.payer, req.maximum);
    this.payments.set(holdId, {
      payer: req.payer,
      payee: req.payee,
      mint: req.mint,
      maximum: req.maximum,
      held: req.maximum,
      refundable: 0n,
      captureDeadline: req.captureDeadline,
      refundDeadline: req.refundDeadline,
    });
    this.txSigs.get(txSig)!.executed = true;
    return { holdId, txSig };
  }

  async capture(req: CaptureRequest, ctx?: SubmitContext): Promise<TxReceipt> {
    const payment = this.find(req.holdId);
    this.require(payment, req.expectedHeld, req.expectedRefundable);
    if (payment.held === 0n) {
      throw new BackendError("empty_hold", `nothing held on ${req.holdId}`);
    }
    if (this.now() >= payment.captureDeadline) {
      throw new BackendError("capture_deadline_expired", `capture deadline passed for ${req.holdId}`);
    }
    if (req.amount <= 0n || req.amount > payment.held) {
      throw new BackendError("amount", `capture amount ${req.amount} out of bounds for held ${payment.held}`);
    }

    const txSig = this.nextTxSig();
    this.txSigs.set(txSig, { kind: "capture", holdId: req.holdId, executed: false });
    if (ctx?.onPrepared) await ctx.onPrepared({ txSig });

    payment.held -= req.amount;
    payment.refundable += req.amount;
    this.credit(payment.payee, req.amount);
    if (req.releaseRemainder && payment.held > 0n) {
      this.credit(payment.payer, payment.held);
      payment.held = 0n;
    }
    this.txSigs.get(txSig)!.executed = true;
    return { txSig };
  }

  async release(req: ReleaseRequest, ctx?: SubmitContext): Promise<TxReceipt> {
    const payment = this.find(req.holdId);
    this.require(payment, req.expectedHeld, req.expectedRefundable);
    if (payment.held === 0n) {
      throw new BackendError("empty_hold", `nothing held on ${req.holdId}`);
    }

    const txSig = this.nextTxSig();
    this.txSigs.set(txSig, { kind: "release", holdId: req.holdId, executed: false });
    if (ctx?.onPrepared) await ctx.onPrepared({ txSig });

    this.credit(payment.payer, payment.held);
    payment.held = 0n;
    this.txSigs.get(txSig)!.executed = true;
    return { txSig };
  }

  async refund(req: RefundRequest, ctx?: SubmitContext): Promise<TxReceipt> {
    const payment = this.find(req.holdId);
    this.require(payment, req.expectedHeld, req.expectedRefundable);
    if (this.now() >= payment.refundDeadline) {
      throw new BackendError("refund_deadline_expired", `refund deadline passed for ${req.holdId}`);
    }
    if (req.amount <= 0n || req.amount > payment.refundable) {
      throw new BackendError("amount", `refund amount ${req.amount} out of bounds for refundable ${payment.refundable}`);
    }
    if (this.balanceOf(payment.payee) < req.amount) {
      throw new BackendError("server_insufficient_funds", `merchant ${payment.payee} has insufficient balance to refund ${req.amount}`);
    }

    const txSig = this.nextTxSig();
    this.txSigs.set(txSig, { kind: "refund", holdId: req.holdId, executed: false });
    if (ctx?.onPrepared) await ctx.onPrepared({ txSig });

    this.debit(payment.payee, req.amount);
    this.credit(payment.payer, req.amount);
    payment.refundable -= req.amount;
    this.txSigs.get(txSig)!.executed = true;
    return { txSig };
  }

  async getStatus(holdId: string): Promise<EscrowStatus | null> {
    const payment = this.payments.get(holdId);
    if (!payment) return null;
    return {
      holdId,
      payer: payment.payer,
      payee: payment.payee,
      mint: payment.mint,
      maximum: payment.maximum,
      held: payment.held,
      refundable: payment.refundable,
      captureDeadline: payment.captureDeadline,
      refundDeadline: payment.refundDeadline,
    };
  }

  /**
   * Mock has no in-flight/async layer: a remembered txSig is either executed (mutated balances)
   * or merely prepared (onPrepared ran, then the call never completed, e.g. a faulty wrapper
   * threw after onPrepared) -- the latter and any unknown signature are indistinguishable from
   * "this never landed", i.e. not_found.
   */
  async getTxOutcome(q: TxOutcomeQuery): Promise<TxOutcome> {
    if (q.txSig) {
      const rec = this.txSigs.get(q.txSig);
      if (!rec || !rec.executed) return { status: "not_found" };
      return { status: "executed", txSig: q.txSig, holdId: rec.holdId };
    }
    if (q.kind === "hold" && q.holdId && this.payments.has(q.holdId)) {
      return { status: "executed", txSig: null, holdId: q.holdId };
    }
    return { status: "not_found" };
  }

  /** Read-only snapshot of on-chain payments, for test assertions (e.g. "budget never exceeds
   * totalBudget minus real on-chain holds/captures"). Not part of the PaymentBackend contract. */
  listPayments(): Array<{ holdId: string; payer: string; payee: string; mint: string; maximum: bigint; held: bigint; refundable: bigint }> {
    return [...this.payments.entries()].map(([holdId, p]) => ({
      holdId,
      payer: p.payer,
      payee: p.payee,
      mint: p.mint,
      maximum: p.maximum,
      held: p.held,
      refundable: p.refundable,
    }));
  }
}
