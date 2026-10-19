/**
 * A PaymentBackend wrapper around MockBackend for exercising PaymentService's UNKNOWN-state
 * handling: it can make any money-moving call ambiguous (before or after the inner mock actually
 * executes), make it fail definitely, delay it on a controlled gate, and make getStatus
 * throw/return null/report the wrong mint. createMandate and getTxOutcome always pass through to
 * the inner MockBackend, since reconcile() needs its real txSig bookkeeping to resolve truth.
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
} from "../../src/backend/types.js";
import type { MockBackend } from "../../src/backend/mock.js";

export type FaultMode =
  /** No fault: behaves like a plain passthrough. */
  | "none"
  /** Throws an ambiguous BackendError before the inner backend ever runs (never executes). */
  | "ambiguous-before"
  /** Calls the inner backend to completion (it executes), then throws an ambiguous BackendError
   * (simulates a lost response after a successful send). */
  | "ambiguous-after"
  /** Throws a definite (non-ambiguous) BackendError before the inner backend ever runs. */
  | "definite-before";

export type StatusFaultMode = "normal" | "throw" | "null" | "wrong-mint";

export type GatedMethod = "hold" | "capture" | "release" | "refund";

export interface Gate {
  promise: Promise<void>;
  release(): void;
}

/** A promise you can resolve on demand, to pin down ordering in concurrency tests. */
export function makeGate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export class FaultyBackend implements PaymentBackend {
  readonly name = "faulty-test";

  holdCalls = 0;
  captureCalls = 0;
  releaseCalls = 0;
  refundCalls = 0;
  /** Calls that actually ran the inner MockBackend to completion (i.e. landed on-chain). */
  executedHoldCalls = 0;
  executedCaptureCalls = 0;
  executedReleaseCalls = 0;
  executedRefundCalls = 0;

  private holdFaults: FaultMode[] = [];
  private captureFaults: FaultMode[] = [];
  private releaseFaults: FaultMode[] = [];
  private refundFaults: FaultMode[] = [];
  private statusFaults: StatusFaultMode[] = [];
  private gates: Partial<Record<GatedMethod, Promise<void>>> = {};

  constructor(public readonly inner: MockBackend) {}

  queueHoldFault(mode: FaultMode): void {
    this.holdFaults.push(mode);
  }
  queueCaptureFault(mode: FaultMode): void {
    this.captureFaults.push(mode);
  }
  queueReleaseFault(mode: FaultMode): void {
    this.releaseFaults.push(mode);
  }
  queueRefundFault(mode: FaultMode): void {
    this.refundFaults.push(mode);
  }
  queueStatusFault(mode: StatusFaultMode): void {
    this.statusFaults.push(mode);
  }

  /** The named method awaits this gate right after being called, before doing anything else. */
  setGate(method: GatedMethod, gate: Promise<void>): void {
    this.gates[method] = gate;
  }
  clearGate(method: GatedMethod): void {
    delete this.gates[method];
  }

  private nextFault(queue: FaultMode[]): FaultMode {
    return queue.length > 0 ? queue.shift()! : "none";
  }

  createMandate(terms: MandateTerms): Promise<{ ref?: string }> {
    return this.inner.createMandate(terms);
  }

  async hold(req: HoldRequest, ctx?: SubmitContext): Promise<HoldReceipt> {
    this.holdCalls++;
    if (this.gates.hold) await this.gates.hold;
    const fault = this.nextFault(this.holdFaults);
    if (fault === "ambiguous-before") {
      throw new BackendError("test_fault", "simulated: ambiguous failure before send", { ambiguous: true });
    }
    if (fault === "definite-before") {
      throw new BackendError("test_fault", "simulated: definite failure before send");
    }
    const receipt = await this.inner.hold(req, ctx);
    this.executedHoldCalls++;
    if (fault === "ambiguous-after") {
      throw new BackendError("test_fault", "simulated: response lost after successful send", { ambiguous: true });
    }
    return receipt;
  }

  async capture(req: CaptureRequest, ctx?: SubmitContext): Promise<TxReceipt> {
    this.captureCalls++;
    if (this.gates.capture) await this.gates.capture;
    const fault = this.nextFault(this.captureFaults);
    if (fault === "ambiguous-before") {
      throw new BackendError("test_fault", "simulated: ambiguous failure before send", { ambiguous: true });
    }
    if (fault === "definite-before") {
      throw new BackendError("test_fault", "simulated: definite failure before send");
    }
    const receipt = await this.inner.capture(req, ctx);
    this.executedCaptureCalls++;
    if (fault === "ambiguous-after") {
      throw new BackendError("test_fault", "simulated: response lost after successful send", { ambiguous: true });
    }
    return receipt;
  }

  async release(req: ReleaseRequest, ctx?: SubmitContext): Promise<TxReceipt> {
    this.releaseCalls++;
    if (this.gates.release) await this.gates.release;
    const fault = this.nextFault(this.releaseFaults);
    if (fault === "ambiguous-before") {
      throw new BackendError("test_fault", "simulated: ambiguous failure before send", { ambiguous: true });
    }
    if (fault === "definite-before") {
      throw new BackendError("test_fault", "simulated: definite failure before send");
    }
    const receipt = await this.inner.release(req, ctx);
    this.executedReleaseCalls++;
    if (fault === "ambiguous-after") {
      throw new BackendError("test_fault", "simulated: response lost after successful send", { ambiguous: true });
    }
    return receipt;
  }

  async refund(req: RefundRequest, ctx?: SubmitContext): Promise<TxReceipt> {
    this.refundCalls++;
    if (this.gates.refund) await this.gates.refund;
    const fault = this.nextFault(this.refundFaults);
    if (fault === "ambiguous-before") {
      throw new BackendError("test_fault", "simulated: ambiguous failure before send", { ambiguous: true });
    }
    if (fault === "definite-before") {
      throw new BackendError("test_fault", "simulated: definite failure before send");
    }
    const receipt = await this.inner.refund(req, ctx);
    this.executedRefundCalls++;
    if (fault === "ambiguous-after") {
      throw new BackendError("test_fault", "simulated: response lost after successful send", { ambiguous: true });
    }
    return receipt;
  }

  async getStatus(holdId: string): Promise<EscrowStatus | null> {
    const mode = this.statusFaults.length > 0 ? this.statusFaults.shift()! : "normal";
    if (mode === "throw") throw new Error("simulated: getStatus failed");
    if (mode === "null") return null;
    const status = await this.inner.getStatus(holdId);
    if (mode === "wrong-mint" && status) return { ...status, mint: "definitely-not-the-expected-mint" };
    return status;
  }

  getTxOutcome(q: TxOutcomeQuery): Promise<TxOutcome> {
    return this.inner.getTxOutcome(q);
  }

  /** Number of payments actually created on the (mock) chain, for asserting "at most one real hold". */
  get onChainHoldCount(): number {
    return this.executedHoldCalls;
  }
}
