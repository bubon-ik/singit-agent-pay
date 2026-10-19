/**
 * PaymentService: the enforcement core. Pure TS, no MCP imports. Every mandate rule in
 * INTERFACE.md ("Mandate rules") is checked here, before any PaymentBackend call — the
 * backend only ever moves escrowed USDC, it never decides whether a payment is allowed.
 */
import { createHash, randomBytes } from "node:crypto";
import { formatUsdc } from "./amount.js";
import { ApprovalDecision, verifyApprovalToken } from "./approval.js";
import {
  BackendError,
  DEVNET_USDC_MINT,
  type EscrowStatus,
  type HoldRequest,
  type PaymentBackend,
  type SubmitContext,
  type TxOutcome,
  type TxReceipt,
} from "./backend/types.js";
import { AUDIT_SCHEMA_VERSION, type AuditAction, type AuditEntry, type RefusalCode } from "./audit.js";
import {
  MemoryStateStore,
  type OpAction,
  type OperationRecord,
  type OpState,
  type StateStore,
  type StoredDispute,
  type StoredHold,
  type StoredMandate,
} from "./store.js";

export type { OpAction, OperationRecord, OpState } from "./store.js";

export const MAX_HOLD_SECONDS = 7 * 86400;
export const MIN_REFUND_WINDOW_SECONDS = 3600;
export const DEFAULT_REFUND_WINDOW_SECONDS = 86400;
export const MAX_REFUND_WINDOW_SECONDS = 30 * 86400;
/** Deadlines/expiresAt at or above this look like milliseconds, not unix seconds (QA M-3). */
export const MS_THRESHOLD = 1e11;

/** 1..128 chars, [A-Za-z0-9._:-]. See HoldArgs.idempotencyKey doc. */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

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
  /** Set once a wrong-mint/terms hold is detected and its cleanup release has not (yet)
   * confirmed. Quarantined holds refuse capture/refund/release(by payee)/open_dispute with
   * WRONG_MINT; only the internal cleanup_release op can move them. */
  quarantined?: boolean;
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
    /** The journaled operation this refusal is about (pending/UNKNOWN/failed/in flight), so the
     * caller can observe it read-only instead of starting a new payment (MVP-02). */
    public readonly operationId?: string,
  ) {
    super(message);
    this.name = "Refusal";
  }
}

/** Result of one economic write: the hold as that operation left it, and its journal id. */
export interface OpOutcome {
  hold: Hold;
  operationId: string;
  /** true = the same idempotencyKey already succeeded; nothing was sent again. */
  replay: boolean;
  txSig: string | null;
}

export interface PaymentServiceOptions {
  backend: PaymentBackend;
  /** Unix seconds. Defaults to the real clock. */
  now?: () => number;
  approvalSecret?: string;
  mint?: string;
  /** Durable operation journal + state snapshot. Defaults to an in-memory store (nothing survives a restart). */
  store?: StateStore;
  /**
   * Live devnet policy, set by createServiceRuntime for capture402 (MVP-02/04/05). Every economic
   * write must carry a client idempotencyKey; an UNKNOWN outcome closes write admission until a
   * restart; flows not accepted for live use (automatic cleanup releases, two-step dispute
   * refunds) are refused by the server. Off by default so the mock demo keeps its behaviour.
   */
  live?: boolean;
}

/** Wraps every durable write so a failed append (disk full, EIO, fsync error) closes economic
 * write admission and surfaces as STORAGE_FAILURE instead of an unclassified crash (MVP-04). */
function guardStore(store: StateStore, onFailure: () => Refusal): StateStore {
  const guarded = <T>(write: (value: T) => void) => (value: T) => {
    try {
      write(value);
    } catch {
      throw onFailure();
    }
  };
  return {
    load: () => store.load(),
    putMandate: guarded((m) => store.putMandate(m)),
    putHold: guarded((h) => store.putHold(h)),
    putDispute: guarded((d) => store.putDispute(d)),
    putOp: guarded((op) => store.putOp(op)),
    putOpCommit: guarded((c) => store.putOpCommit(c)),
    appendAudit: guarded((e) => store.appendAudit(e)),
  };
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
  /**
   * Scopes retries of this exact call to one on-chain hold. 1..128 chars, [A-Za-z0-9._:-].
   * If absent, a random key is used internally (no dedupe) — a deterministic default is NOT
   * safe for hold, since two genuinely distinct holds can share every other field.
   */
  idempotencyKey?: string;
}

export interface CaptureArgs {
  actor: string;
  holdId: string;
  amount: bigint;
  releaseRemainder?: boolean;
  idempotencyKey?: string;
}

export interface ReleaseArgs {
  actor: string;
  holdId: string;
  idempotencyKey?: string;
}

export interface RefundArgs {
  actor: string;
  holdId: string;
  amount: bigint;
  idempotencyKey?: string;
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
  idempotencyKey?: string;
}

/** Backend codes for a definite, non-retryable "the refund/dispute window is closed" failure
 * (capture402's `refund_deadline_expired` and any future facilitator synonym for it) map to the
 * same RefusalCode open_dispute already uses for that condition, rather than a generic
 * BACKEND_ERROR (QA P-L1). */
const REFUND_WINDOW_CLOSED_BACKEND_CODES = new Set(["refund_deadline_expired"]);

/** Converts a thrown BackendError into a Refusal (BACKEND_ERROR, unless its code maps to a more
 * specific RefusalCode); passes everything else through. */
function toRefusal(err: unknown): Refusal {
  if (err instanceof Refusal) return err;
  if (err instanceof BackendError) {
    if (REFUND_WINDOW_CLOSED_BACKEND_CODES.has(err.code)) {
      return new Refusal("REFUND_WINDOW_CLOSED", `BLOCKED: backend error (${err.code}): ${err.message}`);
    }
    return new Refusal("BACKEND_ERROR", `BLOCKED: backend error (${err.code}): ${err.message}`);
  }
  throw err;
}

/** Recursively drops undefined, sorts object keys, and stringifies bigints, so the same
 * logical request always canonicalizes to the same JSON regardless of key order. */
function canonicalizeValue(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(canonicalizeValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val === undefined) continue;
      out[k] = canonicalizeValue(val);
    }
    return out;
  }
  return v;
}

function canonicalize(obj: Record<string, unknown>): Record<string, unknown> {
  return canonicalizeValue(obj) as Record<string, unknown>;
}

function paramsHash(canonical: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function serializeMandate(m: Mandate): StoredMandate {
  return {
    id: m.id,
    payer: m.payer,
    totalBudget: m.totalBudget.toString(),
    perTxCap: m.perTxCap.toString(),
    expiresAt: m.expiresAt,
    allowedCounterparties: [...m.allowedCounterparties],
    committed: m.committed.toString(),
    createdAt: m.createdAt,
    note: m.note,
  };
}

function deserializeMandate(s: StoredMandate): Mandate {
  return {
    id: s.id,
    payer: s.payer,
    totalBudget: BigInt(s.totalBudget),
    perTxCap: BigInt(s.perTxCap),
    expiresAt: s.expiresAt,
    allowedCounterparties: [...s.allowedCounterparties],
    committed: BigInt(s.committed),
    createdAt: s.createdAt,
    note: s.note,
  };
}

function serializeHold(h: Hold): StoredHold {
  return {
    id: h.id,
    mandateId: h.mandateId,
    payer: h.payer,
    payee: h.payee,
    mint: h.mint,
    maximum: h.maximum.toString(),
    held: h.held.toString(),
    captured: h.captured.toString(),
    refunded: h.refunded.toString(),
    captureDeadline: h.captureDeadline,
    refundDeadline: h.refundDeadline,
    txSigs: [...h.txSigs],
    lastTxSig: h.lastTxSig,
    disputeId: h.disputeId,
    quarantined: h.quarantined,
  };
}

function deserializeHold(s: StoredHold): Hold {
  return {
    id: s.id,
    mandateId: s.mandateId,
    payer: s.payer,
    payee: s.payee,
    mint: s.mint,
    maximum: BigInt(s.maximum),
    held: BigInt(s.held),
    captured: BigInt(s.captured),
    refunded: BigInt(s.refunded),
    captureDeadline: s.captureDeadline,
    refundDeadline: s.refundDeadline,
    txSigs: [...s.txSigs],
    lastTxSig: s.lastTxSig,
    disputeId: s.disputeId,
    quarantined: s.quarantined,
  };
}

function serializeDispute(d: Dispute): StoredDispute {
  return {
    id: d.id,
    holdId: d.holdId,
    mandateId: d.mandateId,
    openedBy: d.openedBy,
    reason: d.reason,
    evidence: [...d.evidence],
    status: d.status,
    outcome: d.outcome,
    refundAmount: d.refundAmount !== undefined ? d.refundAmount.toString() : undefined,
    resolvedAt: d.resolvedAt,
    txSigs: [...d.txSigs],
  };
}

function deserializeDispute(s: StoredDispute): Dispute {
  return {
    id: s.id,
    holdId: s.holdId,
    mandateId: s.mandateId,
    openedBy: s.openedBy,
    reason: s.reason,
    evidence: [...s.evidence],
    status: s.status,
    outcome: s.outcome,
    refundAmount: s.refundAmount !== undefined ? BigInt(s.refundAmount) : undefined,
    resolvedAt: s.resolvedAt,
    txSigs: [...s.txSigs],
  };
}

/** Maps an OperationRecord.action to the TxOutcomeQuery.kind the backend understands. */
const RECONCILE_KIND: Record<OpAction, "hold" | "capture" | "release" | "refund"> = {
  hold: "hold",
  capture: "capture",
  release: "release",
  refund: "refund",
  resolve_release: "release",
  resolve_refund: "refund",
  cleanup_release: "release",
};

export class PaymentService {
  private readonly backend: PaymentBackend;
  private readonly now: () => number;
  private readonly approvalSecret?: string;
  private readonly mint: string;
  private readonly store: StateStore;
  private readonly live: boolean;
  /** Set once economic writes must stop (MVP-04). Reads, replays and observation keep working;
   * only a restart (whose startup reconciliation must pass) reopens admission. */
  private admission: { code: RefusalCode; reason: string } | null = null;

  private readonly mandates = new Map<string, Mandate>();
  private readonly holds = new Map<string, Hold>();
  private readonly disputes = new Map<string, Dispute>();
  private readonly auditLog: AuditEntry[] = [];
  private readonly ops = new Map<string, OperationRecord>();
  /** Scoped idempotency key ("action:actor:key") -> op id. */
  private readonly idempotencyIndex = new Map<string, string>();
  /** holdId -> the single op currently pending|unknown on it (the per-hold in-flight guard). */
  private readonly holdLocks = new Map<string, string>();
  /** opIds being worked on IN THIS PROCESS right now: from beginOp until the outcome is committed
   * locally (not merely until the backend call settles), and for the duration of a reconcile().
   * reconcile() and idempotent replays must not race that work: e.g. on devnet, getTxOutcome can
   * legitimately say not_found before onPrepared/send has even happened, and two overlapping
   * reconciles of one op would each apply its delta. */
  private readonly inFlight = new Set<string>();

  private mandateSeq = 0;
  private disputeSeq = 0;
  private auditSeq = 0;
  private opSeq = 0;

  /** FIFO tail for serializing every money-moving backend call (hold/capture/release/refund,
   * including the internal cleanup_release): two concurrent calls on this backend never overlap
   * in flight, even though the per-mandate/per-hold reservation checks above already make their
   * outcome race-free. Chaining through .then(fn, fn) runs fn after the tail settles either way;
   * the tail itself is re-derived with a swallowed-error chain so one failed call never wedges it. */
  private backendTail: Promise<unknown> = Promise.resolve();

  private withBackendLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.backendTail.then(fn, fn);
    this.backendTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  constructor(opts: PaymentServiceOptions) {
    this.backend = opts.backend;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.approvalSecret = opts.approvalSecret;
    this.mint = opts.mint ?? DEVNET_USDC_MINT;
    this.live = opts.live ?? false;
    this.store = guardStore(opts.store ?? new MemoryStateStore(), () => {
      this.closeAdmission("STORAGE_FAILURE", "a durable journal write failed");
      return new Refusal(
        "STORAGE_FAILURE",
        "BLOCKED: a durable journal write failed; economic writes are closed until an operator inspects the store and restarts",
      );
    });

    const snapshot = this.store.load();
    this.mandateSeq = snapshot.seqs.mandateSeq;
    this.disputeSeq = snapshot.seqs.disputeSeq;
    this.opSeq = snapshot.seqs.opSeq;
    this.auditSeq = snapshot.seqs.auditSeq;

    for (const sm of snapshot.mandates) this.mandates.set(sm.id, deserializeMandate(sm));
    for (const sh of snapshot.holds) this.holds.set(sh.id, deserializeHold(sh));
    for (const sd of snapshot.disputes) this.disputes.set(sd.id, deserializeDispute(sd));
    this.auditLog.push(...snapshot.audit);
    for (const op of snapshot.ops) {
      this.ops.set(op.id, op);
      this.idempotencyIndex.set(op.key, op.id);
      if (op.holdId && (op.state === "pending" || op.state === "unknown")) {
        this.holdLocks.set(op.holdId, op.id);
      }
    }
    // A process that died mid-call leaves its op "pending": indistinguishable from an ambiguous
    // backend response, so treat it the same way (reconcile later decides succeeded/failed).
    for (const op of this.ops.values()) {
      if (op.state === "pending") {
        op.state = "unknown";
        op.updatedAt = this.now();
        this.store.putOp(op);
        this.recordReconcile(op, "pending", "unknown", "pending op found at restart (process died mid-call); treated as unknown pending reconcile");
      }
    }
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
    const entry: AuditEntry = {
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
    };
    this.auditLog.push(entry);
    try {
      this.store.appendAudit(entry);
    } catch {
      // The guarded store already closed admission. Keep the entry in memory and let the
      // refusal that caused this record surface instead of a secondary audit-write error.
    }
  }

  /** Stops new economic writes (idempotent: the first reason wins). Reads and replays continue. */
  closeAdmission(code: Extract<RefusalCode, "ADMISSION_CLOSED" | "STORAGE_FAILURE">, reason: string): void {
    if (!this.admission) this.admission = { code, reason };
  }

  /** Economic readiness, distinct from liveness (MVP-04). Counts only; no private evidence. */
  admissionStatus(): { open: boolean; code: RefusalCode | null; reason: string | null; unresolvedOps: number } {
    const unresolvedOps = [...this.ops.values()].filter((o) => o.state === "pending" || o.state === "unknown").length;
    return { open: !this.admission, code: this.admission?.code ?? null, reason: this.admission?.reason ?? null, unresolvedOps };
  }

  private assertAdmission(): void {
    if (this.admission) {
      throw new Refusal("ADMISSION_CLOSED", `BLOCKED: economic writes are closed (${this.admission.code}): ${this.admission.reason}`);
    }
  }

  /** Validates the key's format and, in live mode, that the client supplied one at all. */
  private requireKey(idempotencyKey: string | undefined): void {
    this.validateIdempotencyKey(idempotencyKey);
    if (this.live && idempotencyKey === undefined) {
      throw new Refusal(
        "IDEMPOTENCY_KEY_REQUIRED",
        "BLOCKED: live economic writes require an idempotencyKey (one per intent; reuse it unchanged on every retry)",
      );
    }
  }

  /**
   * MVP-02: looks a caller-supplied key up BEFORE any check that applies only to a new operation
   * (held amount, refundable, deadlines), so a retry after the original succeeded replays that
   * outcome instead of failing on the state the outcome itself produced. Null = nothing to replay.
   */
  private async findReplay(
    action: OpAction,
    actor: string,
    idempotencyKey: string | undefined,
    canonicalParams: Record<string, unknown>,
  ): Promise<OperationRecord | null> {
    if (idempotencyKey === undefined) return null;
    const existing = this.idempotencyIndex.get(this.scopedKey(action, actor, idempotencyKey));
    if (!existing) return null;
    return this.resolveIdempotentOp(existing, paramsHash(canonicalize(canonicalParams)), action);
  }

  /** The hold exactly as `op`'s success left it; journals predating that snapshot fall back to the current hold. */
  private replayHold(op: OperationRecord, current: Hold): Hold {
    return op.result?.hold ? deserializeHold(op.result.hold) : current;
  }

  private recordReconcile(op: OperationRecord, from: OpState, to: OpState, reason: string): void {
    this.record("reconcile", "system", "ok", null, `op ${op.id} (${op.action}): ${from} -> ${to}: ${reason}`, {
      mandateId: op.mandateId,
      holdId: op.holdId,
    });
  }

  private scopedKey(action: string, actor: string, idempotencyKey?: string): string {
    return `${action}:${actor}:${idempotencyKey ?? randomBytes(16).toString("hex")}`;
  }

  private validateIdempotencyKey(key: string | undefined): void {
    if (key !== undefined && !IDEMPOTENCY_KEY_RE.test(key)) {
      throw new Refusal("INVALID_INPUT", `BLOCKED: idempotencyKey must be 1-128 chars of [A-Za-z0-9._:-]`);
    }
  }

  /** Creates, indexes, locks (if holdId is set) and durably persists a new pending op. */
  private beginOp(fields: {
    key: string;
    action: OpAction;
    actor: string;
    mandateId: string;
    holdId: string | null;
    params: Record<string, unknown> & { paramsHash: string };
    salt?: string;
    expected?: { held: string; refundable: string };
    reservation: bigint;
    /** hold only: the mandate whose committed already includes this reservation, journaled in
     * the same record as the pending op so neither can be durable without the other. */
    reservedOn?: Mandate;
  }): OperationRecord {
    const now = this.now();
    const op: OperationRecord = {
      id: `op-${++this.opSeq}`,
      key: fields.key,
      action: fields.action,
      actor: fields.actor,
      mandateId: fields.mandateId,
      holdId: fields.holdId,
      params: fields.params,
      salt: fields.salt,
      expected: fields.expected,
      state: "pending",
      reservation: fields.reservation.toString(),
      createdAt: now,
      updatedAt: now,
    };
    this.ops.set(op.id, op);
    this.idempotencyIndex.set(fields.key, op.id);
    if (fields.holdId) this.holdLocks.set(fields.holdId, op.id);
    this.inFlight.add(op.id);
    if (fields.reservedOn) this.store.putOpCommit({ op, mandate: serializeMandate(fields.reservedOn) });
    else this.store.putOp(op);
    return op;
  }

  /**
   * Awaits a money-moving backend call (serialized against every other such call on this
   * backend, see withBackendLock), durably recording op.prepared before the send (via
   * onPrepared) so a later reconcile can find it even if this call's response is lost.
   *
   * On failure: a `BackendError` is a definite outcome (`phase: "validation"` = never executed,
   * `"confirmed_failure"` = landed with an error) — the op is marked "failed" (and the per-hold
   * lock released) and a Refusal is rethrown. A `BackendOutcomeUnknown` (possible send, outcome
   * unproven) is NEVER rethrown raw (P-M1): the op is marked "unknown" (lock stays held) and
   * OPERATION_UNKNOWN is thrown instead, so the reservation survives for reconcile()/retry. Any
   * other (non-BackendError) throw is treated the same conservative way.
   */
  private async submit<T>(op: OperationRecord, holdIdForLock: string | null, call: (ctx: SubmitContext) => Promise<T>): Promise<T> {
    // op stays in `inFlight` after this returns; the caller removes it once the outcome is committed.
    try {
      return await this.withBackendLock(() =>
        call({
          onPrepared: (p) => {
            op.prepared = p;
            op.updatedAt = this.now();
            this.store.putOp(op);
          },
        }),
      );
    } catch (err) {
      op.updatedAt = this.now();
      if (err instanceof BackendError) {
        const refusal = toRefusal(err);
        op.state = "failed";
        op.error = {
          code: err.code,
          message: err.message,
          refusalCode: refusal.code,
        };
        if (holdIdForLock && this.holdLocks.get(holdIdForLock) === op.id) this.holdLocks.delete(holdIdForLock);
        this.store.putOp(op);
        throw refusal;
      }
      op.state = "unknown";
      if (this.live) this.closeAdmission("ADMISSION_CLOSED", `operation ${op.id} (${op.action}) has an UNKNOWN outcome`);
      this.store.putOp(op);
      this.record("OUTCOME_UNKNOWN", op.actor, "blocked", "OPERATION_UNKNOWN", `op ${op.id} (${op.action}) outcome unknown; reservation kept for reconcile`, {
        mandateId: op.mandateId,
        holdId: holdIdForLock ?? op.holdId,
      });
      throw new Refusal(
        "OPERATION_UNKNOWN",
        `BLOCKED: ${op.action} on ${holdIdForLock ?? op.mandateId} is ambiguous (no confirmed backend response); observe operation ${op.id}, never resend`,
        op.id,
      );
    }
  }

  /** `mutated`, if given, is the hold/mandate this op's success produced: it is committed in the
   * SAME durable record as the op's terminal state (see StateStore.putOpCommit), so a crash can
   * never leave the mutation persisted without the op terminal (or vice versa) — the exact gap
   * that let reconcile re-apply an already-applied delta. */
  private finalizeOpSucceeded(
    op: OperationRecord,
    result: { holdId?: string; txSig?: string },
    holdIdForLock: string | null,
    mutated?: { hold?: Hold; mandate?: Mandate },
  ): void {
    op.state = "succeeded";
    // Confirmed holds are represented by mandate.committed; only unresolved holds
    // count as reservations in the operation journal.
    op.reservation = "0";
    op.result = mutated?.hold ? { ...result, hold: serializeHold(mutated.hold) } : result;
    op.updatedAt = this.now();
    if (holdIdForLock && this.holdLocks.get(holdIdForLock) === op.id) this.holdLocks.delete(holdIdForLock);
    if (mutated?.hold || mutated?.mandate) {
      this.store.putOpCommit({
        op,
        hold: mutated.hold ? serializeHold(mutated.hold) : undefined,
        mandate: mutated.mandate ? serializeMandate(mutated.mandate) : undefined,
      });
    } else {
      this.store.putOp(op);
    }
  }

  /**
   * Looks up an op by its scoped idempotency key: different paramsHash -> IDEMPOTENCY_KEY_REUSED;
   * pending/unknown -> reconcile it first; failed -> rethrow the stored refusal; otherwise
   * returns the (now terminal) op so the caller can build its replay result.
   */
  private async resolveIdempotentOp(existingOpId: string, hash: string, actionLabel: string): Promise<OperationRecord> {
    let op = this.ops.get(existingOpId);
    if (!op) throw new Refusal("OPERATION_UNKNOWN", `BLOCKED: operation ${existingOpId} is missing from the journal`, existingOpId);
    if (op.params.paramsHash !== hash) {
      throw new Refusal("IDEMPOTENCY_KEY_REUSED", `BLOCKED: idempotency key already used for a ${actionLabel} with different parameters`, op.id);
    }
    if (this.inFlight.has(op.id)) {
      // A concurrent identical request: never a second send. Observe, then retry with the same key.
      throw new Refusal("OPERATION_PENDING", `BLOCKED: operation ${op.id} for this idempotency key is still in progress; retry with the same key`, op.id);
    }
    if (op.state === "pending" || op.state === "unknown") {
      await this.reconcile(op.id);
      op = this.ops.get(existingOpId)!;
    }
    if (op.state === "failed") {
      throw new Refusal(op.error?.refusalCode ?? "BACKEND_ERROR", op.error?.message ?? `BLOCKED: operation ${op.id} failed`, op.id);
    }
    if (op.state !== "succeeded") {
      throw new Refusal("OPERATION_UNKNOWN", `BLOCKED: operation ${op.id} is still unresolved; observe it, never resend`, op.id);
    }
    return op;
  }

  /**
   * Shared executor for capture/release/refund/resolve_release/resolve_refund: all are "run one
   * guarded backend call against an existing hold, mutate it on success". Handles idempotent
   * replay, the per-hold in-flight guard, and op lifecycle; the caller only supplies the backend
   * call itself and how to mutate the hold once it is confirmed.
   */
  private async executeHoldOp(opts: {
    action: OpAction;
    actor: string;
    idempotencyKey: string | undefined;
    hold: Hold;
    canonicalParams: Record<string, unknown>;
    expected: { held: string; refundable: string };
    call: (ctx: SubmitContext) => Promise<TxReceipt>;
    /** Mutates opts.hold (and/or the mandate) in place; must NOT persist anything itself, since
     * executeHoldOp commits the mutation and the op's terminal state atomically. */
    applyMutation: (receipt: TxReceipt) => { mandate?: Mandate } | void;
  }): Promise<{ hold: Hold; replay: boolean; op: OperationRecord }> {
    const key = this.scopedKey(opts.action, opts.actor, opts.idempotencyKey);
    const canonical = canonicalize(opts.canonicalParams);
    const hash = paramsHash(canonical);

    const existingOpId = this.idempotencyIndex.get(key);
    if (existingOpId) {
      const op = await this.resolveIdempotentOp(existingOpId, hash, opts.action);
      return { hold: this.replayHold(op, opts.hold), replay: true, op };
    }

    const locked = this.holdLocks.get(opts.hold.id);
    if (locked) {
      throw new Refusal("OPERATION_PENDING", `BLOCKED: another operation on hold ${opts.hold.id} is still pending/unknown`, locked);
    }
    this.assertAdmission();

    const op = this.beginOp({
      key,
      action: opts.action,
      actor: opts.actor,
      mandateId: opts.hold.mandateId,
      holdId: opts.hold.id,
      params: { ...canonical, paramsHash: hash },
      expected: opts.expected,
      reservation: 0n,
    });

    try {
      const receipt = await this.submit(op, opts.hold.id, opts.call);
      const extra = opts.applyMutation(receipt);
      this.finalizeOpSucceeded(op, { txSig: receipt.txSig }, opts.hold.id, { hold: opts.hold, mandate: extra?.mandate });
      return { hold: opts.hold, replay: false, op };
    } finally {
      this.inFlight.delete(op.id);
    }
  }

  private payerForOp(op: OperationRecord): string {
    const mandate = this.mandates.get(op.mandateId);
    if (mandate) return mandate.payer;
    if (op.holdId) {
      const hold = this.holds.get(op.holdId);
      if (hold) return hold.payer;
    }
    return "";
  }

  /** Frees a failed op's reservation, UNLESS it is a cleanup_release: a failed cleanup attempt
   * means the original (wrong-mint) hold is still genuinely held on-chain, so its budget must
   * stay reserved rather than be freed on a mere cleanup-attempt failure. */
  private finalizeOpFailedByReconcile(op: OperationRecord, outcome: Extract<TxOutcome, { status: "not_found" } | { status: "failed" }>): void {
    op.state = "failed";
    op.error =
      outcome.status === "failed"
        ? {
            code: outcome.code ?? "failed",
            message: `backend reported the transaction failed${outcome.code ? `: ${outcome.code}` : ""}`,
            refusalCode: "BACKEND_ERROR",
          }
        : {
            code: "not_found",
            message: "transaction not found on-chain (blockhash expired or never sent); treated as not executed",
            refusalCode: "BACKEND_ERROR",
          };
    op.updatedAt = this.now();
    if (op.holdId && this.holdLocks.get(op.holdId) === op.id) this.holdLocks.delete(op.holdId);

    const reservation = BigInt(op.reservation);
    if (reservation > 0n && op.action !== "cleanup_release") {
      const mandate = this.mandates.get(op.mandateId);
      if (mandate) {
        mandate.committed -= reservation;
        this.store.putMandate(serializeMandate(mandate));
      }
    }
    this.store.putOp(op);
  }

  /** Computes the action-specific hold/mandate mutation once reconcile has confirmed an op
   * executed. Mutates `hold` in place and returns the mandate it touched (if any); does NOT
   * persist — the caller commits both atomically with the op's terminal state. */
  private applyHoldMutationForOp(op: OperationRecord, hold: Hold): Mandate | undefined {
    const p = op.params as Record<string, unknown>;
    switch (op.action) {
      case "capture": {
        const amount = BigInt(p.amount as string);
        hold.held -= amount;
        hold.captured += amount;
        if (p.releaseRemainder && hold.held > 0n) {
          const remainder = hold.held;
          hold.held = 0n;
          const mandate = this.mandates.get(op.mandateId);
          if (mandate) mandate.committed -= remainder;
          return mandate;
        }
        return undefined;
      }
      case "release":
      case "resolve_release":
      case "cleanup_release": {
        const released = hold.held;
        hold.held = 0n;
        const mandate = this.mandates.get(op.mandateId);
        if (mandate) mandate.committed -= released;
        return mandate;
      }
      case "refund":
      case "resolve_refund": {
        const amount = BigInt(p.amount as string);
        hold.refunded += amount;
        return undefined;
      }
      default:
        return undefined;
    }
  }

  /** Applies the effect of a confirmed-executed capture/release/refund/resolve-release/
   * resolve-refund/cleanup-release op exactly once. Returns false (leave unknown) if the
   * on-chain state cannot be verified or disagrees with what the op expected. Hold execution is
   * verified separately: see verifyAndFinalizeHold, which additionally has to catch a
   * wrong-mint/terms hold. */
  private async applyExecutedOutcome(op: OperationRecord, outcome: Extract<TxOutcome, { status: "executed" }>): Promise<boolean> {
    const txSig = outcome.txSig ?? op.prepared?.txSig ?? op.result?.txSig ?? undefined;

    if (!op.holdId) return false;
    const hold = this.holds.get(op.holdId);
    if (!hold) return false;

    let status: EscrowStatus | null;
    try {
      status = await this.backend.getStatus(op.holdId);
    } catch {
      status = null;
    }
    const expected = op.expected;
    if (!status || !expected || status.held !== BigInt(expected.held) || status.refundable !== BigInt(expected.refundable)) {
      return false;
    }

    const mandate = this.applyHoldMutationForOp(op, hold);
    this.finalizeOpSucceeded(op, { txSig }, op.holdId, { hold, mandate });
    return true;
  }

  /**
   * After a "hold" op's backend call is confirmed executed (live, right after submit(), or via
   * reconcile), verifies the on-chain Payment account before trusting it:
   * - getStatus throws/returns null -> stays unknown (keep the reservation and the hold lock);
   *   a later reconcile will re-check.
   * - mint/maximum/payer/payee mismatch -> the hold genuinely executed, just on the wrong terms:
   *   mark the hold op succeeded, then attempt a cleanup release (attemptCleanupRelease). The
   *   reservation is freed only once that cleanup is confirmed; until then the hold is recorded
   *   and quarantined so it stays visible but every other action on it is refused.
   * - match -> create the Hold record (idempotent: a no-op if it already exists) and finalize
   *   the op succeeded.
   * Shared by hold()'s live path and reconcile()'s "hold executed" branch so both apply the
   * exact same verification + cleanup logic.
   */
  private async verifyAndFinalizeHold(
    op: OperationRecord,
    holdId: string,
    txSig: string | undefined,
    readOnly = false,
  ): Promise<
    { kind: "unknown" } | { kind: "wrong_mint"; cleanupSucceeded: boolean; cleanupDisabled?: true; statusMint: string | null } | { kind: "ok"; hold: Hold }
  > {
    const mandate = this.mandates.get(op.mandateId);
    const p = op.params as Record<string, unknown>;
    const resolved = (p.resolved ?? {}) as { captureDeadline?: number; refundDeadline?: number; mint?: string };
    const amount = BigInt(op.reservation);
    const payee = String(p.payee);
    const effectiveMint = resolved.mint ?? this.mint;
    const dc = resolved.captureDeadline ?? 0;
    const dr = resolved.refundDeadline ?? 0;

    let status: EscrowStatus | null;
    try {
      status = await this.backend.getStatus(holdId);
    } catch {
      status = null;
    }

    if (!status || !mandate) {
      op.state = "unknown";
      op.result = { holdId, txSig };
      op.updatedAt = this.now();
      this.store.putOp(op);
      return { kind: "unknown" };
    }

    const mismatched = status.mint !== this.mint || status.maximum !== amount || status.payer !== mandate.payer || status.payee !== payee;
    if (mismatched && readOnly) {
      op.state = "unknown";
      op.result = { holdId, txSig };
      op.updatedAt = this.now();
      this.store.putOp(op);
      return { kind: "unknown" };
    }
    if (mismatched) {
      op.state = "succeeded";
      // Cleanup owns the still committed funds; this op's reservation no longer
      // contributes to the pending/unknown reservation total.
      op.reservation = "0";
      op.result = { holdId, txSig };
      op.updatedAt = this.now();
      if (this.holdLocks.get(holdId) === op.id) this.holdLocks.delete(holdId);

      // Only persisted (and quarantined) if the cleanup attempt below does NOT succeed
      // immediately: a hold that is cleaned up synchronously never needs to become visible.
      const hold: Hold =
        this.holds.get(holdId) ??
        ({
          id: holdId,
          mandateId: op.mandateId,
          payer: mandate.payer,
          payee,
          mint: effectiveMint,
          maximum: amount,
          held: amount,
          captured: 0n,
          refunded: 0n,
          captureDeadline: dc,
          refundDeadline: dr,
          txSigs: txSig ? [txSig] : [],
          lastTxSig: txSig ?? null,
        } satisfies Hold);

      if (this.live) {
        // MVP-05: automatic cleanup is not accepted for live use. Record the hold quarantined with
        // its amount still committed, in the same record as the op; recovery is the payer's
        // reclaim after captureDeadline or a separately approved release, never a server resend.
        hold.quarantined = true;
        this.holds.set(holdId, hold);
        this.store.putOpCommit({ op, hold: serializeHold(hold) });
        return { kind: "wrong_mint", cleanupSucceeded: false, cleanupDisabled: true, statusMint: status.mint ?? null };
      }
      this.store.putOp(op);

      const cleanupCanonical = canonicalize({ holdId, expectedHeld: amount, expectedRefundable: 0n });
      const cleanupOp = this.beginOp({
        key: this.scopedKey("cleanup_release", op.actor, holdId),
        action: "cleanup_release",
        actor: op.actor,
        mandateId: op.mandateId,
        holdId,
        params: { ...cleanupCanonical, paramsHash: paramsHash(cleanupCanonical) },
        expected: { held: "0", refundable: "0" },
        reservation: amount,
      });

      let cleanupSucceeded: boolean;
      try {
        cleanupSucceeded = await this.attemptCleanupRelease(cleanupOp, hold);
      } finally {
        this.inFlight.delete(cleanupOp.id);
      }
      if (!cleanupSucceeded) {
        hold.quarantined = true;
        this.holds.set(holdId, hold);
        this.store.putHold(serializeHold(hold));
      }
      return { kind: "wrong_mint", cleanupSucceeded, statusMint: status.mint ?? null };
    }

    const existing = this.holds.get(holdId);
    if (existing) {
      this.finalizeOpSucceeded(op, { holdId, txSig }, holdId, { hold: existing });
      return { kind: "ok", hold: existing };
    }

    const hold: Hold = {
      id: holdId,
      mandateId: op.mandateId,
      payer: mandate.payer,
      payee,
      mint: effectiveMint,
      maximum: amount,
      held: amount,
      captured: 0n,
      refunded: 0n,
      captureDeadline: dc,
      refundDeadline: dr,
      txSigs: txSig ? [txSig] : [],
      lastTxSig: txSig ?? null,
    };
    this.holds.set(holdId, hold);
    op.holdId = holdId;
    // The new hold and the op's success land in one durable record (no hold without its op).
    this.finalizeOpSucceeded(op, { holdId, txSig }, holdId, { hold });
    return { kind: "ok", hold };
  }

  /** Attempts (or retries) the backend release that returns a wrong-mint hold's funds to the
   * payer. On success: zeroes the hold and frees the mandate's reservation exactly once. On any
   * failure (definite or ambiguous): leaves the cleanup op "unknown" for a later retry — a
   * cleanup attempt never has a terminal "failed" state, since the funds are still genuinely
   * held and must keep being retried rather than abandoned. */
  private async attemptCleanupRelease(cleanupOp: OperationRecord, hold: Hold): Promise<boolean> {
    // beginOp or reconcile() may already own this op; then they release it, not this call.
    const owned = !this.inFlight.has(cleanupOp.id);
    if (owned) this.inFlight.add(cleanupOp.id);
    try {
      const receipt = await this.withBackendLock(() =>
        this.backend.release(
          { holdId: hold.id, expectedHeld: BigInt(cleanupOp.reservation), expectedRefundable: 0n },
          {
            onPrepared: (p) => {
              cleanupOp.prepared = p;
              cleanupOp.updatedAt = this.now();
              this.store.putOp(cleanupOp);
            },
          },
        ),
      );
      hold.held = 0n;
      const mandate = this.mandates.get(cleanupOp.mandateId);
      if (mandate) mandate.committed -= BigInt(cleanupOp.reservation);
      this.finalizeOpSucceeded(cleanupOp, { txSig: receipt.txSig }, hold.id, { hold, mandate });
      return true;
    } catch (err) {
      cleanupOp.state = "unknown";
      cleanupOp.error = {
        code: err instanceof BackendError ? err.code : "error",
        message: err instanceof Error ? err.message : String(err),
        refusalCode: "WRONG_MINT",
      };
      cleanupOp.updatedAt = this.now();
      this.store.putOp(cleanupOp);
      return false;
    } finally {
      if (owned) this.inFlight.delete(cleanupOp.id);
    }
  }

  /**
   * reconcile()'s handling for a cleanup_release op whose getTxOutcome came back not_found/failed:
   * unlike every other action, this must NOT free the reservation and terminate as "failed" —
   * the underlying hold may still be held on-chain. Re-checks getStatus: held == 0 is NOT taken
   * as repayment (a capture also empties a hold), so the op stays unknown with its reservation;
   * held > 0 issues a fresh guarded release attempt on the SAME op in mock/demo mode only. Live
   * mode never resubmits automatically (MVP-05).
   */
  private async retryCleanupRelease(op: OperationRecord, prevState: OpState): Promise<void> {
    const hold = op.holdId ? this.holds.get(op.holdId) : undefined;
    if (!op.holdId || !hold) {
      if (op.state !== "unknown") {
        op.state = "unknown";
        op.updatedAt = this.now();
        this.store.putOp(op);
      }
      this.recordReconcile(op, prevState, "unknown", "cleanup_release target hold is missing; left unknown");
      return;
    }

    let status: EscrowStatus | null;
    try {
      status = await this.backend.getStatus(op.holdId);
    } catch {
      status = null;
    }

    if (!status) {
      if (op.state !== "unknown") {
        op.state = "unknown";
        op.updatedAt = this.now();
        this.store.putOp(op);
      }
      this.recordReconcile(op, prevState, "unknown", "could not read on-chain state for the cleanup release; left unknown");
      return;
    }

    if (status.held === 0n) {
      // MVP-05: H=0 is not proof of repayment. A capture also empties the hold, and this op's own
      // transaction was just reported not found/failed, so nothing proves the funds went back to
      // the payer. Keep the reservation and the quarantine; an operator verifies the original
      // outcome rather than the service guessing a transfer direction.
      if (op.state !== "unknown") {
        op.state = "unknown";
        op.updatedAt = this.now();
        this.store.putOp(op);
      }
      this.recordReconcile(op, prevState, "unknown", "on-chain held is 0 but this cleanup's own transaction is unconfirmed; release vs capture cannot be told apart, reservation kept for operator review");
      return;
    }

    if (this.live) {
      // MVP-05: a fresh release would be a new wire/salt, i.e. a new economic action. Never automatic in live mode.
      if (op.state !== "unknown") {
        op.state = "unknown";
        op.updatedAt = this.now();
        this.store.putOp(op);
      }
      this.recordReconcile(op, prevState, "unknown", "cleanup transaction not executed; automatic resubmission is disabled in live mode, reservation kept");
      return;
    }

    const succeeded = await this.attemptCleanupRelease(op, hold);
    this.recordReconcile(
      op,
      prevState,
      succeeded ? "succeeded" : "unknown",
      succeeded ? "retried cleanup release succeeded" : "retried cleanup release is still unresolved; will retry again",
    );
  }

  /** Converges a single op with on-chain truth. A no-op if it is already terminal, or if its
   * backend call is still actively in flight in this process (see `inFlight`): racing that call
   * is exactly how a devnet getTxOutcome saying not_found before send would cause a double-free. */
  async reconcile(opId: string, options: { readOnly?: boolean } = {}): Promise<OperationRecord> {
    const op = this.ops.get(opId);
    if (!op) throw new Refusal("INVALID_INPUT", `BLOCKED: unknown operation ${opId}`);
    if (op.state === "succeeded" || op.state === "failed") return op;
    if (this.inFlight.has(op.id)) return op;
    // Own the op for the whole reconcile: two overlapping reconciles (e.g. two concurrent replays
    // of one key) would otherwise each apply its delta after their getTxOutcome/getStatus awaits.
    this.inFlight.add(op.id);
    try {
      return await this.reconcileOwned(op, options);
    } finally {
      this.inFlight.delete(op.id);
    }
  }

  private async reconcileOwned(op: OperationRecord, options: { readOnly?: boolean }): Promise<OperationRecord> {
    const prevState = op.state;
    const kind = RECONCILE_KIND[op.action];

    // getTxOutcome is optional: without it there
    // is no evidence source to converge against, so the op simply stays pending/unknown until a
    // same-idempotencyKey retry supplies a terminal result, or a future backend adds it.
    if (!this.backend.getTxOutcome) return op;

    let outcome: TxOutcome;
    try {
      outcome = await this.backend.getTxOutcome({
        kind,
        txSig: op.prepared?.txSig ?? op.result?.txSig ?? null,
        holdId: op.holdId,
        payer: this.payerForOp(op),
        salt: op.salt,
        lastValidBlockHeight: op.prepared?.lastValidBlockHeight,
        evidence: op.prepared?.evidence,
      });
    } catch {
      return op; // read error: stays pending/unknown, caller can retry later
    }

    if (outcome.status === "pending") {
      if (op.state !== "unknown") {
        op.state = "unknown";
        op.updatedAt = this.now();
        this.store.putOp(op);
        this.recordReconcile(op, prevState, "unknown", "still pending on-chain");
      }
      return op;
    }

    if (outcome.status === "not_found" || outcome.status === "failed") {
      if (op.action === "cleanup_release") {
        // Startup recovery may observe an earlier cleanup, but must never sign a new one.
        if (options.readOnly) return op;
        await this.retryCleanupRelease(op, prevState);
        return op;
      }
      this.finalizeOpFailedByReconcile(op, outcome);
      this.recordReconcile(
        op,
        prevState,
        "failed",
        outcome.status === "not_found" ? "transaction not found on-chain; treated as not executed" : `transaction failed on-chain${outcome.code ? `: ${outcome.code}` : ""}`,
      );
      return op;
    }

    if (op.action === "hold") {
      const holdId = outcome.holdId ?? op.prepared?.holdId ?? op.result?.holdId ?? op.holdId ?? undefined;
      const txSig = outcome.txSig ?? op.prepared?.txSig ?? op.result?.txSig ?? undefined;
      if (!holdId) {
        if (op.state !== "unknown") {
          op.state = "unknown";
          op.updatedAt = this.now();
          this.store.putOp(op);
          this.recordReconcile(op, prevState, "unknown", "on-chain hold confirmed executed but no holdId could be recovered; left unknown");
        }
        return op;
      }
      const result = await this.verifyAndFinalizeHold(op, holdId, txSig, options.readOnly);
      if (result.kind === "ok") {
        this.recordReconcile(op, prevState, "succeeded", "on-chain hold confirmed executed");
      } else if (result.kind === "wrong_mint") {
        this.recordReconcile(
          op,
          prevState,
          "succeeded",
          `on-chain hold executed with mismatched terms (mint/maximum/payer/payee); ${result.cleanupSucceeded ? "cleanup release succeeded" : "cleanup release pending"}`,
        );
      } else if (op.state !== "unknown") {
        op.state = "unknown";
        op.updatedAt = this.now();
        this.store.putOp(op);
        this.recordReconcile(op, prevState, "unknown", "hold executed but its status could not be verified; left unknown for retry");
      }
      return op;
    }

    const applied = await this.applyExecutedOutcome(op, outcome);
    if (applied) {
      this.recordReconcile(op, prevState, "succeeded", `on-chain ${kind} confirmed executed`);
    } else if (op.state !== "unknown") {
      op.state = "unknown";
      op.updatedAt = this.now();
      this.store.putOp(op);
      this.recordReconcile(op, prevState, "unknown", "on-chain state disagrees with expected after an executed tx; left unknown for retry");
    }
    return op;
  }

  /** Reconciles every op still pending/unknown. Best-effort: one op's failure does not stop the rest. */
  async reconcilePending(options: { readOnly?: boolean } = {}): Promise<void> {
    const targets = [...this.ops.values()].filter((o) => o.state === "pending" || o.state === "unknown");
    for (const op of targets) {
      try {
        await this.reconcile(op.id, options);
      } catch {
        // leave it for the next reconcilePending() call
      }
    }
  }

  // ---- reads (no audit entries) ----

  getMandate(id: string): { mandate: Mandate; remaining: bigint; reserved: bigint; holds: Hold[] } {
    const mandate = this.mandates.get(id);
    if (!mandate) throw new Refusal("MANDATE_NOT_FOUND", `BLOCKED: mandate not found: ${id}`);
    const holds = [...this.holds.values()].filter((h) => h.mandateId === id);
    const reserved = [...this.ops.values()]
      .filter((o) => o.mandateId === id && (o.state === "pending" || o.state === "unknown"))
      .reduce((sum, o) => sum + BigInt(o.reservation), 0n);
    return { mandate, remaining: mandate.totalBudget - mandate.committed, reserved, holds };
  }

  listMandates(): Array<{ mandate: Mandate; remaining: bigint; reserved: bigint; holds: Hold[] }> {
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

  /** Private journal record, including original signed evidence. Redact at transport boundaries. */
  getOperation(id: string): OperationRecord {
    const op = this.ops.get(id);
    if (!op) throw new Refusal("INVALID_INPUT", `BLOCKED: unknown operation ${id}`);
    return op;
  }

  /** Private journal records. HTTP/dashboard callers must project public status fields. */
  listOperations(args: { state?: OpState; mandateId?: string; holdId?: string } = {}): OperationRecord[] {
    return [...this.ops.values()].filter(
      (o) =>
        (args.state === undefined || o.state === args.state) &&
        (args.mandateId === undefined || o.mandateId === args.mandateId) &&
        (args.holdId === undefined || o.holdId === args.holdId),
    );
  }

  /** Records that this (freshly constructed) service replaced the prior mock-backend state. HTTP /human/reset only. */
  recordReset(actor: string): void {
    this.record("reset", actor, "ok", null, "state reset to defaults (mock backend)", {});
  }

  // ---- writes (exactly one audit entry each) ----

  async createMandate(args: CreateMandateArgs): Promise<Mandate> {
    const { actor, payer, totalBudget, perTxCap, expiresAt, allowedCounterparties, note } = args;
    try {
      this.assertAdmission();
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
      this.store.putMandate(serializeMandate(mandate));
      this.record(
        "create_mandate",
        actor,
        "ok",
        null,
        `created mandate ${id} for payer ${payer}: budget ${formatUsdc(totalBudget)}, per-tx cap ${formatUsdc(perTxCap)}`,
        { mandateId: id, txSig: result.ref ?? null, amount: totalBudget },
      );
      return mandate;
    } catch (err) {
      const refusal = toRefusal(err);
      this.record("create_mandate", actor, refusal.code === "BACKEND_ERROR" ? "error" : "blocked", refusal.code, refusal.message, {});
      throw refusal;
    }
  }

  /** Audits an idempotent replay and returns the original outcome of `op`; nothing is sent. */
  private recordReplay(action: "capture" | "release" | "refund", actor: string, op: OperationRecord, current: Hold, amount: bigint | null): OpOutcome {
    const hold = this.replayHold(op, current);
    const txSig = op.result?.txSig ?? hold.lastTxSig;
    this.record(action, actor, "ok", null, `idempotent replay of ${op.id}`, {
      mandateId: hold.mandateId,
      holdId: hold.id,
      amount,
      txSig,
      held: hold.held,
      refundable: hold.captured - hold.refunded,
    });
    return { hold, operationId: op.id, replay: true, txSig };
  }

  async hold(args: HoldArgs): Promise<Hold> {
    return (await this.holdOp(args)).hold;
  }

  async holdOp(args: HoldArgs): Promise<OpOutcome> {
    const { actor, mandateId, payee, amount, mint, captureDeadline, refundDeadline, idempotencyKey } = args;
    let holdId: string | null = null;
    let txSig: string | null = null;
    let heldAfter: bigint | null = null;
    let refundableAfter: bigint | null = null;
    try {
      this.requireKey(idempotencyKey);
      const key = this.scopedKey("hold", actor, idempotencyKey);
      const canonical = canonicalize({ mandateId, payee, amount, mint, captureDeadline, refundDeadline });
      const hash = paramsHash(canonical);

      const existingOpId = this.idempotencyIndex.get(key);
      if (existingOpId) {
        const op = await this.resolveIdempotentOp(existingOpId, hash, "hold");
        const current = op.result?.holdId ? this.holds.get(op.result.holdId) : undefined;
        if (!current) throw new Refusal("OPERATION_UNKNOWN", `BLOCKED: operation ${op.id} succeeded but its hold is missing`, op.id);
        const hold = this.replayHold(op, current);
        txSig = op.result?.txSig ?? hold.lastTxSig;
        this.record("hold", actor, "ok", null, `idempotent replay of ${op.id}`, {
          mandateId,
          holdId: hold.id,
          amount,
          txSig,
          held: hold.held,
          refundable: hold.captured - hold.refunded,
        });
        return { hold, operationId: op.id, replay: true, txSig };
      }
      this.assertAdmission();

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

      // ---- Atomic reservation: all validation above is synchronous and complete. We reserve
      // the budget and durably journal this attempt BEFORE the first await. JS is single-
      // threaded, so no other call can interleave between the check above and this reservation
      // == a concurrent hold on the same mandate always sees it and cannot overspend the budget.
      mandate.committed += amount;
      const op = this.beginOp({
        key,
        action: "hold",
        actor,
        mandateId,
        holdId: null,
        params: { ...canonical, paramsHash: hash, resolved: { captureDeadline: dc, refundDeadline: dr, mint: effectiveMint } },
        salt,
        reservation: amount,
        reservedOn: mandate,
      });
      // ---- end atomic reservation section ----
      // A journal failure above (STORAGE_FAILURE) throws before any wire exists: nothing is sent.

      try {
        const req: HoldRequest = { payer: mandate.payer, mint: effectiveMint, payee, maximum: amount, captureDeadline: dc, refundDeadline: dr, salt };
        const receipt = await this.submit(op, null, (ctx) => this.backend.hold(req, ctx));

        holdId = receipt.holdId;
        txSig = receipt.txSig;
        op.holdId = holdId;
        this.holdLocks.set(holdId, op.id);

        const result = await this.verifyAndFinalizeHold(op, holdId, txSig ?? undefined);
        if (result.kind === "unknown") {
          if (this.live) this.closeAdmission("ADMISSION_CLOSED", `operation ${op.id} (hold) executed but could not be verified`);
          throw new Refusal("OPERATION_UNKNOWN", `BLOCKED: hold ${holdId} executed but its status could not be verified; observe operation ${op.id}`, op.id);
        }
        if (result.kind === "wrong_mint") {
          heldAfter = result.cleanupSucceeded ? 0n : amount;
          refundableAfter = 0n;
          const cleanupNote = result.cleanupDisabled
            ? "hold quarantined with its amount still committed; automatic cleanup is disabled in live mode (payer reclaims after captureDeadline)"
            : result.cleanupSucceeded
              ? "funds released back to payer"
              : "cleanup release pending, will retry";
          throw new Refusal("WRONG_MINT", `BLOCKED: wrong mint on hold ${holdId}: expected ${this.mint}, got ${result.statusMint ?? "unknown"}; ${cleanupNote}`, op.id);
        }

        heldAfter = amount;
        refundableAfter = 0n;
        this.record("hold", actor, "ok", null, `hold ${formatUsdc(amount)} on mandate ${mandateId} for payee ${payee}`, {
          mandateId,
          holdId,
          amount,
          txSig,
          held: result.hold.held,
          refundable: 0n,
        });
        return { hold: result.hold, operationId: op.id, replay: false, txSig };
      } finally {
        this.inFlight.delete(op.id);
      }
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
    return (await this.captureOp(args)).hold;
  }

  async captureOp(args: CaptureArgs): Promise<OpOutcome> {
    const { actor, holdId, amount, releaseRemainder, idempotencyKey } = args;
    let txSig: string | null = null;
    try {
      this.requireKey(idempotencyKey);
      const hold = this.holds.get(holdId);
      if (!hold) throw new Refusal("HOLD_NOT_FOUND", `BLOCKED: hold not found: ${holdId}`);
      if (actor !== hold.payee) throw new Refusal("NOT_PAYEE", `BLOCKED: ${actor} is not the payee of hold ${holdId}`);
      const canonicalParams = { holdId, amount, releaseRemainder: !!releaseRemainder };
      const prior = await this.findReplay("capture", actor, idempotencyKey, canonicalParams);
      if (prior) return this.recordReplay("capture", actor, prior, hold, amount);
      if (hold.quarantined) throw new Refusal("WRONG_MINT", `BLOCKED: hold ${holdId} is quarantined (wrong mint/terms); its cleanup release is still pending`);
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
      const heldAfterCapture = expectedHeld - amount;

      const { hold: resultHold, replay, op } = await this.executeHoldOp({
        action: "capture",
        actor,
        idempotencyKey,
        hold,
        canonicalParams,
        expected: { held: (releaseRemainder ? 0n : heldAfterCapture).toString(), refundable: (expectedRefundable + amount).toString() },
        call: (ctx) => this.backend.capture({ holdId, amount, releaseRemainder: !!releaseRemainder, expectedHeld, expectedRefundable }, ctx),
        applyMutation: (receipt) => {
          txSig = receipt.txSig;
          hold.txSigs.push(receipt.txSig);
          hold.lastTxSig = receipt.txSig;
          hold.held -= amount;
          hold.captured += amount;
          let mandate: Mandate | undefined;
          if (releaseRemainder && hold.held > 0n) {
            const remainder = hold.held;
            hold.held = 0n;
            mandate = this.mandates.get(hold.mandateId);
            if (mandate) mandate.committed -= remainder;
          }
          return { mandate };
        },
      });

      if (replay) return this.recordReplay("capture", actor, op, resultHold, amount);

      const remainderNote = releaseRemainder && heldAfterCapture > 0n ? `, released remainder ${formatUsdc(heldAfterCapture)}` : "";
      this.record("capture", actor, "ok", null, `captured ${formatUsdc(amount)} on hold ${holdId}${remainderNote}`, {
        mandateId: resultHold.mandateId,
        holdId,
        amount,
        txSig,
        held: resultHold.held,
        refundable: resultHold.captured - resultHold.refunded,
      });
      return { hold: resultHold, operationId: op.id, replay: false, txSig };
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
    return (await this.releaseOp(args)).hold;
  }

  async releaseOp(args: ReleaseArgs): Promise<OpOutcome> {
    const { actor, holdId, idempotencyKey } = args;
    let txSig: string | null = null;
    try {
      this.requireKey(idempotencyKey);
      const hold = this.holds.get(holdId);
      if (!hold) throw new Refusal("HOLD_NOT_FOUND", `BLOCKED: hold not found: ${holdId}`);
      if (actor !== hold.payee) throw new Refusal("NOT_PAYEE", `BLOCKED: ${actor} is not the payee of hold ${holdId}`);
      const prior = await this.findReplay("release", actor, idempotencyKey, { holdId });
      if (prior) return this.recordReplay("release", actor, prior, hold, null);
      if (hold.quarantined) throw new Refusal("WRONG_MINT", `BLOCKED: hold ${holdId} is quarantined (wrong mint/terms); its cleanup release is still pending`);
      if (hold.held === 0n) throw new Refusal("NOTHING_HELD", `BLOCKED: nothing held on hold ${holdId}`);

      const expectedHeld = hold.held;
      const expectedRefundable = hold.captured - hold.refunded;

      const { hold: resultHold, replay, op } = await this.executeHoldOp({
        action: "release",
        actor,
        idempotencyKey,
        hold,
        canonicalParams: { holdId },
        expected: { held: "0", refundable: expectedRefundable.toString() },
        call: (ctx) => this.backend.release({ holdId, expectedHeld, expectedRefundable }, ctx),
        applyMutation: (receipt) => {
          txSig = receipt.txSig;
          hold.txSigs.push(receipt.txSig);
          hold.lastTxSig = receipt.txSig;
          const released = hold.held;
          hold.held = 0n;
          const mandate = this.mandates.get(hold.mandateId);
          if (mandate) mandate.committed -= released;
          return { mandate };
        },
      });

      if (replay) return this.recordReplay("release", actor, op, resultHold, null);

      this.record("release", actor, "ok", null, `released hold ${holdId}, returned ${formatUsdc(expectedHeld)} to payer`, {
        mandateId: resultHold.mandateId,
        holdId,
        amount: expectedHeld,
        txSig,
        held: resultHold.held,
        refundable: resultHold.captured - resultHold.refunded,
      });
      return { hold: resultHold, operationId: op.id, replay: false, txSig };
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
    return (await this.refundOp(args)).hold;
  }

  async refundOp(args: RefundArgs): Promise<OpOutcome> {
    const { actor, holdId, amount, idempotencyKey } = args;
    let txSig: string | null = null;
    try {
      this.requireKey(idempotencyKey);
      const hold = this.holds.get(holdId);
      if (!hold) throw new Refusal("HOLD_NOT_FOUND", `BLOCKED: hold not found: ${holdId}`);
      if (actor !== hold.payee) throw new Refusal("NOT_PAYEE", `BLOCKED: ${actor} is not the payee of hold ${holdId}`);
      const prior = await this.findReplay("refund", actor, idempotencyKey, { holdId, amount });
      if (prior) return this.recordReplay("refund", actor, prior, hold, amount);
      if (hold.quarantined) throw new Refusal("WRONG_MINT", `BLOCKED: hold ${holdId} is quarantined (wrong mint/terms); its cleanup release is still pending`);
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

      const { hold: resultHold, replay, op } = await this.executeHoldOp({
        action: "refund",
        actor,
        idempotencyKey,
        hold,
        canonicalParams: { holdId, amount },
        expected: { held: expectedHeld.toString(), refundable: (refundable - amount).toString() },
        call: (ctx) => this.backend.refund({ holdId, amount, expectedHeld, expectedRefundable }, ctx),
        applyMutation: (receipt) => {
          txSig = receipt.txSig;
          hold.txSigs.push(receipt.txSig);
          hold.lastTxSig = receipt.txSig;
          hold.refunded += amount;
        },
      });

      if (replay) return this.recordReplay("refund", actor, op, resultHold, amount);

      this.record("refund", actor, "ok", null, `refunded ${formatUsdc(amount)} on hold ${holdId}`, {
        mandateId: resultHold.mandateId,
        holdId,
        amount,
        txSig,
        held: resultHold.held,
        refundable: resultHold.captured - resultHold.refunded,
      });
      return { hold: resultHold, operationId: op.id, replay: false, txSig };
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
      if (hold.quarantined) throw new Refusal("WRONG_MINT", `BLOCKED: hold ${holdId} is quarantined (wrong mint/terms); its cleanup release is still pending`);
      if (this.now() >= hold.refundDeadline) {
        throw new Refusal("REFUND_WINDOW_CLOSED", `BLOCKED: refund window closed for hold ${holdId}, dispute could never be refunded`);
      }
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
      this.store.putDispute(serializeDispute(dispute));
      this.store.putHold(serializeHold(hold));

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
    const { actor, disputeId, outcome, refundAmount, approvalToken, idempotencyKey } = args;
    let auditActor = actor;
    let txSig: string | null = null;
    try {
      this.validateIdempotencyKey(idempotencyKey);
      const dispute = this.disputes.get(disputeId);
      if (!dispute) throw new Refusal("DISPUTE_NOT_FOUND", `BLOCKED: dispute not found: ${disputeId}`);

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
      // After the approval check, so an agent without a token is told HUMAN_APPROVAL_REQUIRED.
      this.requireKey(idempotencyKey);

      if (dispute.status === "resolved") {
        // MVP-02: a keyed retry of the SAME approved decision replays the original resolution.
        const sameDecision = dispute.outcome === outcome && (dispute.refundAmount ?? 0n) === (outcome === "refund" ? (refundAmount ?? 0n) : 0n);
        if (idempotencyKey !== undefined && sameDecision) {
          this.record("resolve_dispute", auditActor, "ok", null, `idempotent replay of resolved dispute ${disputeId}`, {
            mandateId: dispute.mandateId,
            holdId: dispute.holdId,
            disputeId,
            amount: dispute.refundAmount && dispute.refundAmount > 0n ? dispute.refundAmount : null,
            txSig: dispute.txSigs.at(-1) ?? null,
          });
          return dispute;
        }
        throw new Refusal("DISPUTE_ALREADY_RESOLVED", `BLOCKED: dispute ${disputeId} is already resolved`);
      }

      const hold = this.holds.get(dispute.holdId);
      if (!hold) throw new Refusal("HOLD_NOT_FOUND", `BLOCKED: hold not found: ${dispute.holdId}`);

      const locked = this.holdLocks.get(hold.id);
      if (locked) {
        throw new Refusal("OPERATION_PENDING", `BLOCKED: another operation on hold ${hold.id} is still pending/unknown`, locked);
      }

      if (outcome === "reject") {
        dispute.status = "resolved";
        dispute.outcome = "reject";
        dispute.resolvedAt = this.now();
        this.store.putDispute(serializeDispute(dispute));
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
      if (this.live && hold.held > 0n && requested > 0n) {
        // MVP-05: release-then-refund is two economic operations whose partial completion has no
        // accepted live recovery yet. Live mode runs only single-operation resolutions.
        throw new Refusal(
          "ACTION_DISABLED",
          `BLOCKED: hold ${hold.id} still holds ${formatUsdc(hold.held)}; a release-plus-refund resolution is not enabled in live mode. Release or capture the hold first, then resolve with the refund`,
        );
      }

      let releaseTxSig: string | null = null;
      let refundTxSig: string | null = null;

      if (hold.held > 0n) {
        const expectedHeld = hold.held;
        const expectedRefundable = hold.captured - hold.refunded;
        const { op } = await this.executeHoldOp({
          action: "resolve_release",
          actor,
          idempotencyKey,
          hold,
          canonicalParams: { disputeId, holdId: hold.id },
          expected: { held: "0", refundable: expectedRefundable.toString() },
          call: (ctx) => this.backend.release({ holdId: hold.id, expectedHeld, expectedRefundable }, ctx),
          applyMutation: (receipt) => {
            releaseTxSig = receipt.txSig;
            hold.txSigs.push(receipt.txSig);
            hold.lastTxSig = receipt.txSig;
            dispute.txSigs.push(receipt.txSig);
            const released = hold.held;
            hold.held = 0n;
            const mandate = this.mandates.get(hold.mandateId);
            if (mandate) mandate.committed -= released;
            return { mandate };
          },
        });
        releaseTxSig = releaseTxSig ?? op.result?.txSig ?? null;
      }

      if (requested > 0n) {
        const refundable = hold.captured - hold.refunded;
        if (requested > refundable) {
          throw new Refusal(
            "REFUND_EXCEEDS_CAPTURED",
            `BLOCKED: refund ${formatUsdc(requested)} exceeds refundable ${formatUsdc(refundable)} on hold ${hold.id}`,
          );
        }
        const expectedHeld = hold.held;
        const { op } = await this.executeHoldOp({
          action: "resolve_refund",
          actor,
          idempotencyKey,
          hold,
          canonicalParams: { disputeId, holdId: hold.id, amount: requested },
          expected: { held: expectedHeld.toString(), refundable: (refundable - requested).toString() },
          call: (ctx) => this.backend.refund({ holdId: hold.id, amount: requested, expectedHeld, expectedRefundable: refundable }, ctx),
          applyMutation: (receipt) => {
            refundTxSig = receipt.txSig;
            hold.txSigs.push(receipt.txSig);
            hold.lastTxSig = receipt.txSig;
            dispute.txSigs.push(receipt.txSig);
            hold.refunded += requested;
          },
        });
        refundTxSig = refundTxSig ?? op.result?.txSig ?? null;
      }

      txSig = refundTxSig ?? releaseTxSig;
      dispute.status = "resolved";
      dispute.outcome = "refund";
      dispute.refundAmount = requested;
      dispute.resolvedAt = this.now();
      this.store.putDispute(serializeDispute(dispute));

      this.record("resolve_dispute", auditActor, "ok", null, `dispute ${disputeId} resolved: refunded ${formatUsdc(requested)}`, {
        mandateId: hold.mandateId,
        holdId: hold.id,
        disputeId,
        amount: requested > 0n ? requested : null,
        txSig,
        held: hold.held,
        refundable: hold.captured - hold.refunded,
      });
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
