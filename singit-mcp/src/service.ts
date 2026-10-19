/**
 * PaymentService: the enforcement core. Pure TS, no MCP imports. Every mandate rule in
 * INTERFACE.md ("Mandate rules") is checked here, before any PaymentBackend call — the
 * backend only ever moves escrowed USDC, it never decides whether a payment is allowed.
 */
import { randomBytes } from "node:crypto";
import { formatUsdc } from "./amount.js";
import { ApprovalDecision, verifyApprovalToken } from "./approval.js";
import {
  BackendError,
  DEVNET_USDC_MINT,
  type HoldRequest,
  type PaymentBackend,
} from "./backend/types.js";
import { AUDIT_SCHEMA_VERSION, type AuditAction, type AuditEntry, type RefusalCode } from "./audit.js";

export const MAX_HOLD_SECONDS = 7 * 86400;
export const MIN_REFUND_WINDOW_SECONDS = 3600;
export const DEFAULT_REFUND_WINDOW_SECONDS = 86400;
export const MAX_REFUND_WINDOW_SECONDS = 30 * 86400;
/** Deadlines/expiresAt at or above this look like milliseconds, not unix seconds (QA M-3). */
export const MS_THRESHOLD = 1e11;

export interface Mandate {
  id: string;
  payer: string;
  totalBudget: bigint;
  perTxCap: bigint;
  expiresAt: number;
  allowedCounterparties: string[];
  /** Sum of held + captured over the mandate's holds. A release lowers it; a refund does not. */
  committed: bigint;
  createdAt: number;
  note?: string;
}

export interface Hold {
  id: string;
  mandateId: string;
  payer: string;
  payee: string;
  mint: string;
  maximum: bigint;
  held: bigint;
  captured: bigint;
  refunded: bigint;
  captureDeadline: number;
  refundDeadline: number;
  /** All tx signatures for this hold, oldest first (mock refs mock-tx-N until Capture402Backend is wired to devnet, then devnet signatures). */
  txSigs: string[];
  /** Signature of the most recent tx on this hold (for explorer links). */
  lastTxSig: string | null;
  disputeId?: string;
}

export interface Dispute {
  id: string;
  holdId: string;
  mandateId: string;
  openedBy: string;
  reason: string;
  evidence: string[];
  status: "open" | "resolved";
  outcome?: "refund" | "reject";
  refundAmount?: bigint;
  resolvedAt?: number;
  txSigs: string[];
}

export class Refusal extends Error {
  constructor(
    public readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "Refusal";
  }
}

export interface PaymentServiceOptions {
  backend: PaymentBackend;
  /** Unix seconds. Defaults to the real clock. */
  now?: () => number;
  approvalSecret?: string;
  mint?: string;
}

export interface CreateMandateArgs {
  actor: string;
  payer: string;
  totalBudget: bigint;
  perTxCap: bigint;
  expiresAt: number;
  allowedCounterparties: string[];
  note?: string;
}

export interface HoldArgs {
  actor: string;
  mandateId: string;
  payee: string;
  amount: bigint;
  mint?: string;
  captureDeadline?: number;
  refundDeadline?: number;
}

export interface CaptureArgs {
  actor: string;
  holdId: string;
  amount: bigint;
  releaseRemainder?: boolean;
}

export interface ReleaseArgs {
  actor: string;
  holdId: string;
}

export interface RefundArgs {
  actor: string;
  holdId: string;
  amount: bigint;
}

export interface OpenDisputeArgs {
  actor: string;
  holdId: string;
  reason: string;
  evidence: string[];
}

export interface ResolveDisputeArgs {
  actor: string;
  disputeId: string;
  outcome: "refund" | "reject";
  refundAmount?: bigint;
  approvalToken?: string;
}

/** Converts a thrown BackendError into a Refusal("BACKEND_ERROR", ...); passes everything else through. */
function toRefusal(err: unknown): Refusal {
  if (err instanceof Refusal) return err;
  if (err instanceof BackendError) {
    return new Refusal("BACKEND_ERROR", `BLOCKED: backend error (${err.code}): ${err.message}`);
  }
  throw err;
}

export class PaymentService {
  private readonly backend: PaymentBackend;
  private readonly now: () => number;
  private readonly approvalSecret?: string;
  private readonly mint: string;

  private readonly mandates = new Map<string, Mandate>();
  private readonly holds = new Map<string, Hold>();
  private readonly disputes = new Map<string, Dispute>();
  private readonly auditLog: AuditEntry[] = [];

  private mandateSeq = 0;
  private disputeSeq = 0;
  private auditSeq = 0;

  constructor(opts: PaymentServiceOptions) {
    this.backend = opts.backend;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.approvalSecret = opts.approvalSecret;
    this.mint = opts.mint ?? DEVNET_USDC_MINT;
  }

  private record(
    action: AuditAction,
    actor: string,
    outcome: AuditEntry["outcome"],
    code: RefusalCode | null,
    reason: string,
    fields: {
      mandateId?: string | null;
      holdId?: string | null;
      disputeId?: string | null;
      amount?: bigint | null;
      txSig?: string | null;
      held?: bigint | null;
      refundable?: bigint | null;
    } = {},
  ): void {
    this.auditLog.push({
      v: AUDIT_SCHEMA_VERSION,
      seq: ++this.auditSeq,
      ts: new Date(this.now() * 1000).toISOString(),
      actor,
      action,
      outcome,
      code,
      reason,
      mandateId: fields.mandateId ?? null,
      holdId: fields.holdId ?? null,
      disputeId: fields.disputeId ?? null,
      amount: fields.amount != null ? fields.amount.toString() : null,
      txSig: fields.txSig ?? null,
      held: fields.held != null ? fields.held.toString() : null,
      refundable: fields.refundable != null ? fields.refundable.toString() : null,
    });
  }

  // ---- reads (no audit entries) ----

  getMandate(id: string): { mandate: Mandate; remaining: bigint; holds: Hold[] } {
    const mandate = this.mandates.get(id);
    if (!mandate) throw new Refusal("MANDATE_NOT_FOUND", `BLOCKED: mandate not found: ${id}`);
    const holds = [...this.holds.values()].filter((h) => h.mandateId === id);
    return { mandate, remaining: mandate.totalBudget - mandate.committed, holds };
  }

  listMandates(): Array<{ mandate: Mandate; remaining: bigint; holds: Hold[] }> {
    return [...this.mandates.keys()].map((id) => this.getMandate(id));
  }

  listDisputes(args: { status?: "open" | "resolved"; mandateId?: string } = {}): Dispute[] {
    return [...this.disputes.values()].filter(
      (d) => (args.status === undefined || d.status === args.status) && (args.mandateId === undefined || d.mandateId === args.mandateId),
    );
  }

  getHold(id: string): Hold {
    const hold = this.holds.get(id);
    if (!hold) throw new Refusal("HOLD_NOT_FOUND", `BLOCKED: hold not found: ${id}`);
    return hold;
  }

  getDispute(id: string): Dispute {
    const dispute = this.disputes.get(id);
    if (!dispute) throw new Refusal("DISPUTE_NOT_FOUND", `BLOCKED: dispute not found: ${id}`);
    return dispute;
  }

  listAuditLog(args: { mandateId?: string; limit?: number } = {}): AuditEntry[] {
    let entries = this.auditLog;
    if (args.mandateId !== undefined) {
      entries = entries.filter((e) => e.mandateId === args.mandateId);
    }
    if (args.limit !== undefined) {
      entries = entries.slice(Math.max(0, entries.length - args.limit));
    }
    return entries.slice();
  }

  /** Records that this (freshly constructed) service replaced the prior mock-backend state. HTTP /human/reset only. */
  recordReset(actor: string): void {
    this.record("reset", actor, "ok", null, "state reset to defaults (mock backend)", {});
  }

  // ---- writes (exactly one audit entry each) ----

  async createMandate(args: CreateMandateArgs): Promise<Mandate> {
    const { actor, payer, totalBudget, perTxCap, expiresAt, allowedCounterparties, note } = args;
    try {
      if (totalBudget <= 0n || perTxCap <= 0n) {
        throw new Refusal("INVALID_INPUT", "BLOCKED: totalBudget and perTxCap must be > 0");
      }
      if (perTxCap > totalBudget) {
        throw new Refusal(
          "INVALID_INPUT",
          `BLOCKED: perTxCap ${formatUsdc(perTxCap)} exceeds totalBudget ${formatUsdc(totalBudget)}`,
        );
      }
      if (allowedCounterparties.length === 0) {
        throw new Refusal("INVALID_INPUT", "BLOCKED: allowedCounterparties must be non-empty");
      }
      if (expiresAt >= MS_THRESHOLD) {
        throw new Refusal("INVALID_DEADLINE", `BLOCKED: expiresAt ${expiresAt} looks like milliseconds, expected unix seconds`);
      }
      if (this.now() >= expiresAt) {
        throw new Refusal("MANDATE_EXPIRED", `BLOCKED: expiresAt ${expiresAt} must be in the future`);
      }

      const id = `m-${++this.mandateSeq}`;
      const result = await this.backend.createMandate({ id, payer, totalBudget, perTxCap, expiresAt, allowedCounterparties });
      const mandate: Mandate = {
        id,
        payer,
        totalBudget,
        perTxCap,
        expiresAt,
        allowedCounterparties: [...allowedCounterparties],
        committed: 0n,
        createdAt: this.now(),
        note,
      };
      this.mandates.set(id, mandate);
      this.record(
        "create_mandate",
        actor,
        "ok",
        null,
        `created mandate ${id} for payer ${payer}: budget ${formatUsdc(totalBudget)}, per-tx cap ${formatUsdc(perTxCap)}`,
        { mandateId: id, txSig: result.ref ?? null },
      );
      return mandate;
    } catch (err) {
      const refusal = toRefusal(err);
      this.record("create_mandate", actor, refusal.code === "BACKEND_ERROR" ? "error" : "blocked", refusal.code, refusal.message, {});
      throw refusal;
    }
  }

  async hold(args: HoldArgs): Promise<Hold> {
    const { actor, mandateId, payee, amount, mint, captureDeadline, refundDeadline } = args;
    let holdId: string | null = null;
    let txSig: string | null = null;
    let heldAfter: bigint | null = null;
    let refundableAfter: bigint | null = null;
    try {
      const mandate = this.mandates.get(mandateId);
      if (!mandate) throw new Refusal("MANDATE_NOT_FOUND", `BLOCKED: mandate not found: ${mandateId}`);
      if (actor !== mandate.payer) throw new Refusal("NOT_PAYER", `BLOCKED: ${actor} is not the payer of mandate ${mandateId}`);

      const now = this.now();
      if (now >= mandate.expiresAt) throw new Refusal("MANDATE_EXPIRED", `BLOCKED: mandate ${mandateId} expired at ${mandate.expiresAt}`);
      if (!mandate.allowedCounterparties.includes(payee)) {
        throw new Refusal("COUNTERPARTY_NOT_ALLOWED", `BLOCKED: ${payee} is not an allowed counterparty on mandate ${mandateId}`);
      }
      if (amount <= 0n) throw new Refusal("INVALID_INPUT", "BLOCKED: hold amount must be > 0");
      if (amount > mandate.perTxCap) {
        throw new Refusal(
          "OVER_PER_TX_CAP",
          `BLOCKED: hold ${formatUsdc(amount)} exceeds per-tx cap ${formatUsdc(mandate.perTxCap)} on mandate ${mandateId}`,
        );
      }
      if (mandate.committed + amount > mandate.totalBudget) {
        const remaining = mandate.totalBudget - mandate.committed;
        throw new Refusal(
          "OVER_BUDGET",
          `BLOCKED: over budget: hold ${formatUsdc(amount)} but only ${formatUsdc(remaining)} of ${formatUsdc(mandate.totalBudget)} of mandate ${mandateId} remains`,
        );
      }
      const effectiveMint = mint ?? this.mint;
      if (effectiveMint !== this.mint) {
        throw new Refusal("WRONG_MINT", `BLOCKED: wrong mint ${effectiveMint}, expected ${this.mint}`);
      }

      const maxCaptureDeadline = Math.min(mandate.expiresAt, now + MAX_HOLD_SECONDS);
      let dc: number;
      if (captureDeadline !== undefined) {
        if (captureDeadline >= MS_THRESHOLD) {
          throw new Refusal("INVALID_DEADLINE", `BLOCKED: captureDeadline ${captureDeadline} looks like milliseconds, expected unix seconds`);
        }
        dc = captureDeadline;
      } else {
        dc = maxCaptureDeadline;
      }
      if (!(now < dc && dc <= maxCaptureDeadline)) {
        throw new Refusal(
          "INVALID_DEADLINE",
          `BLOCKED: captureDeadline ${dc} must satisfy now (${now}) < captureDeadline <= min(mandate.expiresAt, now+${MAX_HOLD_SECONDS}s) (${maxCaptureDeadline})`,
        );
      }

      let dr: number;
      if (refundDeadline !== undefined) {
        if (refundDeadline >= MS_THRESHOLD) {
          throw new Refusal("INVALID_DEADLINE", `BLOCKED: refundDeadline ${refundDeadline} looks like milliseconds, expected unix seconds`);
        }
        dr = refundDeadline;
      } else {
        dr = dc + DEFAULT_REFUND_WINDOW_SECONDS;
      }
      const refundWindow = dr - dc;
      if (refundWindow < MIN_REFUND_WINDOW_SECONDS || refundWindow > MAX_REFUND_WINDOW_SECONDS) {
        throw new Refusal(
          "INVALID_DEADLINE",
          `BLOCKED: refund window ${refundWindow}s (refundDeadline - captureDeadline) must be between ${MIN_REFUND_WINDOW_SECONDS}s and ${MAX_REFUND_WINDOW_SECONDS}s`,
        );
      }

      const salt = randomBytes(32).toString("hex");
      const req: HoldRequest = { payer: mandate.payer, mint: effectiveMint, payee, maximum: amount, captureDeadline: dc, refundDeadline: dr, salt };
      const receipt = await this.backend.hold(req);
      holdId = receipt.holdId;
      txSig = receipt.txSig;
      heldAfter = amount;
      refundableAfter = 0n;
      mandate.committed += amount;

      const status = await this.backend.getStatus(holdId);
      if (!status || status.mint !== this.mint) {
        mandate.committed -= amount;
        try {
          await this.backend.release({ holdId, expectedHeld: heldAfter, expectedRefundable: refundableAfter });
          heldAfter = 0n;
        } catch {
          // Best-effort: report the last known held/refundable below either way.
        }
        throw new Refusal(
          "WRONG_MINT",
          `BLOCKED: wrong mint on hold ${holdId}: expected ${this.mint}, got ${status?.mint ?? "unknown"}`,
        );
      }

      const hold: Hold = {
        id: holdId,
        mandateId,
        payer: mandate.payer,
        payee,
        mint: effectiveMint,
        maximum: amount,
        held: amount,
        captured: 0n,
        refunded: 0n,
        captureDeadline: dc,
        refundDeadline: dr,
        txSigs: [txSig],
        lastTxSig: txSig,
      };
      this.holds.set(hold.id, hold);
      this.record("hold", actor, "ok", null, `hold ${formatUsdc(amount)} on mandate ${mandateId} for payee ${payee}`, {
        mandateId,
        holdId,
        amount,
        txSig,
        held: hold.held,
        refundable: 0n,
      });
      return hold;
    } catch (err) {
      const refusal = toRefusal(err);
      this.record("hold", actor, refusal.code === "BACKEND_ERROR" ? "error" : "blocked", refusal.code, refusal.message, {
        mandateId,
        holdId,
        amount,
        txSig,
        held: heldAfter,
        refundable: refundableAfter,
      });
      throw refusal;
    }
  }

  async capture(args: CaptureArgs): Promise<Hold> {
    const { actor, holdId, amount, releaseRemainder } = args;
    let txSig: string | null = null;
    try {
      const hold = this.holds.get(holdId);
      if (!hold) throw new Refusal("HOLD_NOT_FOUND", `BLOCKED: hold not found: ${holdId}`);
      if (actor !== hold.payee) throw new Refusal("NOT_PAYEE", `BLOCKED: ${actor} is not the payee of hold ${holdId}`);
      if (hold.disputeId && this.disputes.get(hold.disputeId)?.status === "open") {
        throw new Refusal("DISPUTE_OPEN", `BLOCKED: hold ${holdId} has an open dispute`);
      }
      if (amount <= 0n) throw new Refusal("INVALID_INPUT", "BLOCKED: capture amount must be > 0");
      if (amount > hold.held) {
        throw new Refusal("CAPTURE_EXCEEDS_HOLD", `BLOCKED: capture ${formatUsdc(amount)} exceeds held ${formatUsdc(hold.held)} on hold ${holdId}`);
      }
      if (this.now() >= hold.captureDeadline) {
        throw new Refusal("CAPTURE_DEADLINE_PASSED", `BLOCKED: capture deadline passed for hold ${holdId}`);
      }

      const expectedHeld = hold.held;
      const expectedRefundable = hold.captured - hold.refunded;
      const receipt = await this.backend.capture({ holdId, amount, releaseRemainder: !!releaseRemainder, expectedHeld, expectedRefundable });
      txSig = receipt.txSig;
      hold.txSigs.push(txSig);
      hold.lastTxSig = txSig;
      hold.held -= amount;
      hold.captured += amount;

      let remainderNote = "";
      if (releaseRemainder && hold.held > 0n) {
        const remainder = hold.held;
        hold.held = 0n;
        const mandate = this.mandates.get(hold.mandateId);
        if (mandate) mandate.committed -= remainder;
        remainderNote = `, released remainder ${formatUsdc(remainder)}`;
      }

      this.record("capture", actor, "ok", null, `captured ${formatUsdc(amount)} on hold ${holdId}${remainderNote}`, {
        mandateId: hold.mandateId,
        holdId,
        amount,
        txSig,
        held: hold.held,
        refundable: hold.captured - hold.refunded,
      });
      return hold;
    } catch (err) {
      const refusal = toRefusal(err);
      const hold = this.holds.get(holdId);
      this.record("capture", actor, refusal.code === "BACKEND_ERROR" ? "error" : "blocked", refusal.code, refusal.message, {
        mandateId: hold?.mandateId ?? null,
        holdId,
        amount,
        txSig,
        held: hold?.held ?? null,
        refundable: hold ? hold.captured - hold.refunded : null,
      });
      throw refusal;
    }
  }

  async release(args: ReleaseArgs): Promise<Hold> {
    const { actor, holdId } = args;
    let txSig: string | null = null;
    try {
      const hold = this.holds.get(holdId);
      if (!hold) throw new Refusal("HOLD_NOT_FOUND", `BLOCKED: hold not found: ${holdId}`);
      if (actor !== hold.payee) throw new Refusal("NOT_PAYEE", `BLOCKED: ${actor} is not the payee of hold ${holdId}`);
      if (hold.held === 0n) throw new Refusal("NOTHING_HELD", `BLOCKED: nothing held on hold ${holdId}`);

      const expectedHeld = hold.held;
      const expectedRefundable = hold.captured - hold.refunded;
      const receipt = await this.backend.release({ holdId, expectedHeld, expectedRefundable });
      txSig = receipt.txSig;
      hold.txSigs.push(txSig);
      hold.lastTxSig = txSig;

      const released = hold.held;
      hold.held = 0n;
      const mandate = this.mandates.get(hold.mandateId);
      if (mandate) mandate.committed -= released;

      this.record("release", actor, "ok", null, `released hold ${holdId}, returned ${formatUsdc(released)} to payer`, {
        mandateId: hold.mandateId,
        holdId,
        amount: released,
        txSig,
        held: hold.held,
        refundable: hold.captured - hold.refunded,
      });
      return hold;
    } catch (err) {
      const refusal = toRefusal(err);
      const hold = this.holds.get(holdId);
      this.record("release", actor, refusal.code === "BACKEND_ERROR" ? "error" : "blocked", refusal.code, refusal.message, {
        mandateId: hold?.mandateId ?? null,
        holdId,
        amount: null,
        txSig,
        held: hold?.held ?? null,
        refundable: hold ? hold.captured - hold.refunded : null,
      });
      throw refusal;
    }
  }

  async refund(args: RefundArgs): Promise<Hold> {
    const { actor, holdId, amount } = args;
    let txSig: string | null = null;
    try {
      const hold = this.holds.get(holdId);
      if (!hold) throw new Refusal("HOLD_NOT_FOUND", `BLOCKED: hold not found: ${holdId}`);
      if (actor !== hold.payee) throw new Refusal("NOT_PAYEE", `BLOCKED: ${actor} is not the payee of hold ${holdId}`);
      if (amount <= 0n) throw new Refusal("INVALID_INPUT", "BLOCKED: refund amount must be > 0");
      const refundable = hold.captured - hold.refunded;
      if (amount > refundable) {
        throw new Refusal("REFUND_EXCEEDS_CAPTURED", `BLOCKED: refund ${formatUsdc(amount)} exceeds refundable ${formatUsdc(refundable)} on hold ${holdId}`);
      }
      if (this.now() >= hold.refundDeadline) {
        throw new Refusal("REFUND_DEADLINE_PASSED", `BLOCKED: refund deadline passed for hold ${holdId}`);
      }

      const expectedHeld = hold.held;
      const expectedRefundable = refundable;
      const receipt = await this.backend.refund({ holdId, amount, expectedHeld, expectedRefundable });
      txSig = receipt.txSig;
      hold.txSigs.push(txSig);
      hold.lastTxSig = txSig;
      hold.refunded += amount;

      this.record("refund", actor, "ok", null, `refunded ${formatUsdc(amount)} on hold ${holdId}`, {
        mandateId: hold.mandateId,
        holdId,
        amount,
        txSig,
        held: hold.held,
        refundable: hold.captured - hold.refunded,
      });
      return hold;
    } catch (err) {
      const refusal = toRefusal(err);
      const hold = this.holds.get(holdId);
      this.record("refund", actor, refusal.code === "BACKEND_ERROR" ? "error" : "blocked", refusal.code, refusal.message, {
        mandateId: hold?.mandateId ?? null,
        holdId,
        amount,
        txSig,
        held: hold?.held ?? null,
        refundable: hold ? hold.captured - hold.refunded : null,
      });
      throw refusal;
    }
  }

  async openDispute(args: OpenDisputeArgs): Promise<Dispute> {
    const { actor, holdId, reason, evidence } = args;
    try {
      const hold = this.holds.get(holdId);
      if (!hold) throw new Refusal("HOLD_NOT_FOUND", `BLOCKED: hold not found: ${holdId}`);
      if (actor !== hold.payer) throw new Refusal("NOT_PAYER", `BLOCKED: ${actor} is not the payer of hold ${holdId}`);
      if (!reason) throw new Refusal("INVALID_INPUT", "BLOCKED: dispute reason must be non-empty");
      if (hold.disputeId && this.disputes.get(hold.disputeId)?.status === "open") {
        throw new Refusal("DISPUTE_OPEN", `BLOCKED: hold ${holdId} already has an open dispute`);
      }

      const id = `d-${++this.disputeSeq}`;
      const dispute: Dispute = {
        id,
        holdId,
        mandateId: hold.mandateId,
        openedBy: actor,
        reason,
        evidence: [...evidence],
        status: "open",
        txSigs: [],
      };
      this.disputes.set(id, dispute);
      hold.disputeId = id;

      this.record("open_dispute", actor, "ok", null, `dispute opened on hold ${holdId}: ${reason}`, {
        mandateId: hold.mandateId,
        holdId,
        disputeId: id,
        held: hold.held,
        refundable: hold.captured - hold.refunded,
      });
      return dispute;
    } catch (err) {
      const refusal = toRefusal(err);
      const hold = this.holds.get(holdId);
      this.record("open_dispute", actor, refusal.code === "BACKEND_ERROR" ? "error" : "blocked", refusal.code, refusal.message, {
        mandateId: hold?.mandateId ?? null,
        holdId,
        held: hold?.held ?? null,
        refundable: hold ? hold.captured - hold.refunded : null,
      });
      throw refusal;
    }
  }

  async resolveDispute(args: ResolveDisputeArgs): Promise<Dispute> {
    const { actor, disputeId, outcome, refundAmount, approvalToken } = args;
    let auditActor = actor;
    let txSig: string | null = null;
    try {
      const dispute = this.disputes.get(disputeId);
      if (!dispute) throw new Refusal("DISPUTE_NOT_FOUND", `BLOCKED: dispute not found: ${disputeId}`);
      if (dispute.status === "resolved") {
        throw new Refusal("DISPUTE_ALREADY_RESOLVED", `BLOCKED: dispute ${disputeId} is already resolved`);
      }

      if (!this.approvalSecret || this.approvalSecret.length < 16) {
        throw new Refusal("HUMAN_APPROVAL_REQUIRED", "BLOCKED: human approval is not configured");
      }
      if (!approvalToken) {
        throw new Refusal("HUMAN_APPROVAL_REQUIRED", "BLOCKED: a human approval token is required to resolve a dispute");
      }
      const decision: ApprovalDecision = { disputeId, outcome, refundAmount: refundAmount ?? 0n };
      if (!verifyApprovalToken(this.approvalSecret, decision, approvalToken)) {
        throw new Refusal("HUMAN_APPROVAL_REQUIRED", "BLOCKED: invalid human approval token");
      }
      auditActor = `human-approved:${actor}`;

      const hold = this.holds.get(dispute.holdId);
      if (!hold) throw new Refusal("HOLD_NOT_FOUND", `BLOCKED: hold not found: ${dispute.holdId}`);

      if (outcome === "reject") {
        dispute.status = "resolved";
        dispute.outcome = "reject";
        dispute.resolvedAt = this.now();
        this.record("resolve_dispute", auditActor, "ok", null, `dispute ${disputeId} resolved: rejected`, {
          mandateId: hold.mandateId,
          holdId: hold.id,
          disputeId,
          held: hold.held,
          refundable: hold.captured - hold.refunded,
        });
        return dispute;
      }

      // outcome === "refund": validate first, then release what is still held, then refund.
      const requested = refundAmount ?? 0n;
      if (requested < 0n || requested > hold.captured - hold.refunded) {
        throw new Refusal(
          "REFUND_EXCEEDS_CAPTURED",
          `BLOCKED: refund ${formatUsdc(requested)} exceeds refundable ${formatUsdc(hold.captured - hold.refunded)} on hold ${hold.id}`,
        );
      }
      if (requested > 0n && this.now() >= hold.refundDeadline) {
        throw new Refusal("REFUND_DEADLINE_PASSED", `BLOCKED: refund deadline passed for hold ${hold.id}`);
      }
      let releaseTxSig: string | null = null;
      let refundTxSig: string | null = null;
      if (hold.held > 0n) {
        const expectedHeld = hold.held;
        const expectedRefundable = hold.captured - hold.refunded;
        const receipt = await this.backend.release({ holdId: hold.id, expectedHeld, expectedRefundable });
        releaseTxSig = receipt.txSig;
        hold.txSigs.push(releaseTxSig);
      hold.lastTxSig = releaseTxSig;
        dispute.txSigs.push(releaseTxSig);
        const released = hold.held;
        hold.held = 0n;
        const mandate = this.mandates.get(hold.mandateId);
        if (mandate) mandate.committed -= released;
      }

      const amount = refundAmount ?? 0n;
      if (amount > 0n) {
        const refundable = hold.captured - hold.refunded;
        if (amount > refundable) {
          throw new Refusal("REFUND_EXCEEDS_CAPTURED", `BLOCKED: refund ${formatUsdc(amount)} exceeds refundable ${formatUsdc(refundable)} on hold ${hold.id}`);
        }
        const expectedHeld = hold.held;
        const expectedRefundable = refundable;
        const receipt = await this.backend.refund({ holdId: hold.id, amount, expectedHeld, expectedRefundable });
        refundTxSig = receipt.txSig;
        hold.txSigs.push(refundTxSig);
      hold.lastTxSig = refundTxSig;
        dispute.txSigs.push(refundTxSig);
        hold.refunded += amount;
      }

      txSig = refundTxSig ?? releaseTxSig;
      dispute.status = "resolved";
      dispute.outcome = "refund";
      dispute.refundAmount = amount;
      dispute.resolvedAt = this.now();

      this.record(
        "resolve_dispute",
        auditActor,
        "ok",
        null,
        `dispute ${disputeId} resolved: refunded ${formatUsdc(amount)}`,
        {
          mandateId: hold.mandateId,
          holdId: hold.id,
          disputeId,
          amount: amount > 0n ? amount : null,
          txSig,
          held: hold.held,
          refundable: hold.captured - hold.refunded,
        },
      );
      return dispute;
    } catch (err) {
      const refusal = toRefusal(err);
      const dispute = this.disputes.get(disputeId);
      const hold = dispute ? this.holds.get(dispute.holdId) : undefined;
      this.record("resolve_dispute", auditActor, refusal.code === "BACKEND_ERROR" ? "error" : "blocked", refusal.code, refusal.message, {
        mandateId: hold?.mandateId ?? dispute?.mandateId ?? null,
        holdId: dispute?.holdId ?? null,
        disputeId,
        txSig,
        held: hold?.held ?? null,
        refundable: hold ? hold.captured - hold.refunded : null,
      });
      throw refusal;
    }
  }
}
