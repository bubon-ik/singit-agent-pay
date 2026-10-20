/**
 * Durable operation journal for PaymentService. All methods are SYNCHRONOUS so they can be
 * called from inside the atomic reservation section (before the first await to a backend).
 *
 * Every stored amount-like field is a decimal string (bigint serialized), never a bigint or
 * number, so a Snapshot round-trips through JSON without a custom reviver.
 */
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import type { AuditEntry, RefusalCode } from "./audit.js";
import type { PreparedTx } from "./backend/types.js";
import { JournalError, parseJournal, validateRecord, type LegacyReview, type RecordLine } from "./journal.js";

export interface StoredMandate {
  id: string;
  payer: string;
  totalBudget: string;
  perTxCap: string;
  expiresAt: number;
  allowedCounterparties: string[];
  committed: string;
  createdAt: number;
  note?: string;
}

export interface StoredHold {
  id: string;
  mandateId: string;
  payer: string;
  payee: string;
  mint: string;
  maximum: string;
  held: string;
  captured: string;
  refunded: string;
  captureDeadline: number;
  refundDeadline: number;
  txSigs: string[];
  lastTxSig: string | null;
  disputeId?: string;
  /** Set once a wrong-mint/terms hold is detected (see PaymentService.verifyAndFinalizeHold).
   * Quarantined holds refuse capture/refund/release(by payee)/open_dispute with WRONG_MINT;
   * only the internal cleanup_release op can move them. */
  quarantined?: boolean;
}

export interface StoredDispute {
  id: string;
  holdId: string;
  mandateId: string;
  openedBy: string;
  reason: string;
  evidence: string[];
  status: "open" | "resolved";
  outcome?: "refund" | "reject";
  refundAmount?: string;
  resolvedAt?: number;
  txSigs: string[];
}

export type OpAction =
  | "hold"
  | "capture"
  | "release"
  | "refund"
  | "resolve_release"
  | "resolve_refund"
  | "cleanup_release";

export type OpState = "pending" | "unknown" | "succeeded" | "failed";

/** A single durable, idempotent, reconcilable money-moving attempt. See INTERFACE.md "Operation journal". */
export interface OperationRecord {
  id: string;
  /** Scoped idempotency key: `${action}:${actor}:${idempotencyKey}`. */
  key: string;
  action: OpAction;
  actor: string;
  mandateId: string;
  holdId: string | null;
  disputeId?: string;
  /** Canonical request params (bigints as decimal strings) plus paramsHash (sha256 of the canonical JSON). */
  params: Record<string, unknown> & { paramsHash: string };
  /** hold only: capture402 payment PDA = PDA(payer, salt). */
  salt?: string;
  /** Filled via ctx.onPrepared before the backend sends the tx. */
  prepared?: PreparedTx;
  /** On-chain held/refundable this op should produce once it lands (capture/release/refund/cleanup_release). */
  expected?: { held: string; refundable: string };
  state: OpState;
  /** `hold` is the hold exactly as this op's success left it (MVP-02): an idempotent replay
   * returns this original outcome, not the hold's later, mutable state. */
  result?: { holdId?: string; txSig?: string; hold?: StoredHold };
  /** `refusalCode` is the Refusal the ORIGINAL caller received (or would receive on replay);
   * `code`/`message` are the raw backend-level detail. Falls back to BACKEND_ERROR if unset
   * (older records predating this field). */
  error?: { code: string; message: string; refusalCode?: RefusalCode };
  /** Base units reserved against the mandate while this op is pending/unknown (hold: amount; others "0"). */
  reservation: string;
  createdAt: number;
  updatedAt: number;
}

export interface Seqs {
  mandateSeq: number;
  disputeSeq: number;
  opSeq: number;
  auditSeq: number;
}

export interface Snapshot {
  mandates: StoredMandate[];
  holds: StoredHold[];
  disputes: StoredDispute[];
  ops: OperationRecord[];
  audit: AuditEntry[];
  seqs: Seqs;
  /** Old non-atomic terminal records cannot safely be upgraded by guessing their effects. */
  legacyIssues?: string[];
  /** Immutable economic namespace of an explicitly reviewed legacy prefix. */
  reviewedNamespace?: LegacyReview["namespace"];
}

/** Atomic commit of a terminal op outcome plus the hold/mandate snapshot(s) it produced, written
 * as a single durable record keyed by op.id. Replay applies op/hold/mandate together or not at
 * all: there is no window where the mutation is durable but the op is not (or vice versa), so
 * reconcile (which only ever acts on non-terminal ops) can never re-apply an already-committed
 * delta. */
export interface OpCommit {
  op: OperationRecord;
  mandate?: StoredMandate;
  hold?: StoredHold;
  dispute?: StoredDispute;
  audit?: AuditEntry;
}

export interface StateCommit {
  mandate?: StoredMandate;
  hold?: StoredHold;
  dispute?: StoredDispute;
  audit: AuditEntry;
}

export interface StateStore {
  load(): Snapshot;
  putMandate(m: StoredMandate): void;
  putHold(h: StoredHold): void;
  putDispute(d: StoredDispute): void;
  putOp(op: OperationRecord): void;
  putOpCommit(commit: OpCommit): void;
  putStateCommit(commit: StateCommit): void;
  appendAudit(e: AuditEntry): void;
}

function seqFromId(id: string, prefix: string): number {
  if (!id.startsWith(prefix)) return 0;
  const n = Number(id.slice(prefix.length));
  return Number.isFinite(n) ? n : 0;
}

function computeSeqs(mandates: Iterable<StoredMandate>, disputes: Iterable<StoredDispute>, ops: Iterable<OperationRecord>, audit: Iterable<AuditEntry>): Seqs {
  const seqs: Seqs = { mandateSeq: 0, disputeSeq: 0, opSeq: 0, auditSeq: 0 };
  for (const m of mandates) seqs.mandateSeq = Math.max(seqs.mandateSeq, seqFromId(m.id, "m-"));
  for (const d of disputes) seqs.disputeSeq = Math.max(seqs.disputeSeq, seqFromId(d.id, "d-"));
  for (const o of ops) seqs.opSeq = Math.max(seqs.opSeq, seqFromId(o.id, "op-"));
  for (const e of audit) seqs.auditSeq = Math.max(seqs.auditSeq, e.seq);
  return seqs;
}

/** Default store: nothing survives a process restart. */
export class MemoryStateStore implements StateStore {
  private readonly mandates = new Map<string, StoredMandate>();
  private readonly holds = new Map<string, StoredHold>();
  private readonly disputes = new Map<string, StoredDispute>();
  private readonly ops = new Map<string, OperationRecord>();
  private readonly audit: AuditEntry[] = [];

  load(): Snapshot {
    return structuredClone({
      mandates: [...this.mandates.values()],
      holds: [...this.holds.values()],
      disputes: [...this.disputes.values()],
      ops: [...this.ops.values()],
      audit: [...this.audit],
      seqs: computeSeqs(this.mandates.values(), this.disputes.values(), this.ops.values(), this.audit),
    });
  }

  putMandate(m: StoredMandate): void {
    this.mandates.set(m.id, structuredClone(m));
  }
  putHold(h: StoredHold): void {
    this.holds.set(h.id, structuredClone(h));
  }
  putDispute(d: StoredDispute): void {
    this.disputes.set(d.id, structuredClone(d));
  }
  putOp(op: OperationRecord): void {
    this.ops.set(op.id, structuredClone(op));
  }
  putOpCommit(commit: OpCommit): void {
    this.putOp(commit.op);
    if (commit.mandate) this.putMandate(commit.mandate);
    if (commit.hold) this.putHold(commit.hold);
    if (commit.dispute) this.putDispute(commit.dispute);
    if (commit.audit) this.appendAudit(commit.audit);
  }
  putStateCommit(commit: StateCommit): void {
    if (commit.mandate) this.putMandate(commit.mandate);
    if (commit.hold) this.putHold(commit.hold);
    if (commit.dispute) this.putDispute(commit.dispute);
    this.appendAudit(commit.audit);
  }
  appendAudit(e: AuditEntry): void {
    this.audit.push(structuredClone(e));
  }
}

/** Append-only v2 journal. Existing v1 bytes are read, never rewritten or truncated.
 * Unknown formats, ambiguous legacy accounting and every incomplete/corrupt line refuse load. */
export class FileStateStore implements StateStore {
  private readonly directory: string;
  private readonly directoryIdentity: BigIntStats;
  private readonly filePath: string;
  private expected: BigIntStats;
  private failed = false;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const directory = lstatSync(dir, { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new JournalError("JOURNAL_CHANGED", 0);
    if ((directory.mode & 0o777n) !== 0o700n) chmodSync(dir, 0o700);
    this.directory = realpathSync(dir);
    this.directoryIdentity = lstatSync(this.directory, { bigint: true });
    this.filePath = join(this.directory, "state.jsonl");
    const existing = lstatSync(this.filePath, { bigint: true, throwIfNoEntry: false });
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1n)) {
      throw new JournalError("JOURNAL_CHANGED", 0);
    }
    if (!existing) {
      const fd = openSync(this.filePath, "wx", 0o600);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      const parent = openSync(this.directory, "r");
      try { fsyncSync(parent); } finally { closeSync(parent); }
    }
    const fd = openSync(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd, { bigint: true });
      if (!info.isFile() || info.nlink !== 1n || (existing && (existing.ino !== info.ino || existing.dev !== info.dev))) {
        throw new JournalError("JOURNAL_CHANGED", 0);
      }
      // Do not alter ctime on every reader construction when permissions already match.
      if ((info.mode & 0o777n) !== 0o600n) fchmodSync(fd, 0o600);
      this.expected = fstatSync(fd, { bigint: true });
      this.checkPath(fd);
    } finally { closeSync(fd); }
  }

  private checkPath(fd: number): BigIntStats {
    const directory = lstatSync(this.directory, { bigint: true });
    const path = lstatSync(this.filePath, { bigint: true }), opened = fstatSync(fd, { bigint: true });
    const owner = process.getuid?.();
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.dev !== this.directoryIdentity.dev ||
        directory.ino !== this.directoryIdentity.ino || (directory.mode & 0o077n) !== 0n ||
        (owner !== undefined && directory.uid !== BigInt(owner)) ||
        !path.isFile() || path.isSymbolicLink() || !opened.isFile() || path.nlink !== 1n || opened.nlink !== 1n ||
        path.dev !== this.expected.dev || path.ino !== this.expected.ino || path.dev !== opened.dev || path.ino !== opened.ino ||
        (opened.mode & 0o077n) !== 0n || (owner !== undefined && opened.uid !== BigInt(owner)) ||
        path.size !== opened.size || path.mtimeNs !== opened.mtimeNs || path.ctimeNs !== opened.ctimeNs) {
      throw new JournalError("JOURNAL_CHANGED", 0);
    }
    return opened;
  }

  private checkContinuity(info: BigIntStats): void {
    if (info.size !== this.expected.size || info.mtimeNs !== this.expected.mtimeNs || info.ctimeNs !== this.expected.ctimeNs) {
      throw new JournalError("JOURNAL_CHANGED", 0);
    }
  }

  private appendLine(line: RecordLine): void {
    if (this.failed) throw new Error("Journal append previously failed; preserve and inspect before restart");
    let fd: number | undefined;
    try {
      validateRecord(line, 0);
      // A replacement FIFO must not block this process before identity can be checked.
      fd = openSync(this.filePath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      this.checkContinuity(this.checkPath(fd));
      const bytes = Buffer.from(`${JSON.stringify(line)}\n`);
      for (let offset = 0; offset < bytes.length;) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error("Incomplete journal write");
        offset += written;
      }
      fsyncSync(fd);
      const after = this.checkPath(fd);
      if (after.size !== this.expected.size + BigInt(bytes.length)) throw new JournalError("JOURNAL_CHANGED", 0);
      this.expected = after;
    } catch (error) {
      this.failed = true;
      throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  private readRaw(): string {
    let fd: number | undefined;
    try {
      fd = openSync(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      this.checkContinuity(this.checkPath(fd));
      const bytes = readFileSync(fd);
      this.checkContinuity(this.checkPath(fd));
      if (BigInt(bytes.length) !== this.expected.size) throw new JournalError("JOURNAL_CHANGED", 0);
      let raw: string;
      try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new JournalError("JOURNAL_CORRUPT", 0); }
      return raw;
    }
    catch (error) { this.failed = true; throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  load(): Snapshot {
    try { return parseJournal(this.readRaw()); }
    catch (error) { this.failed = true; throw error; }
  }
  /** Explicit offline operator operation only. Validate the entire resulting history
   * before its single append; no accounting override, backend or automatic repair. */
  appendLegacyReview(data: LegacyReview): Snapshot {
    const raw = this.readRaw(), record: RecordLine = { t: "legacyreview", v: 2, data };
    validateRecord(record, 0);
    parseJournal(`${raw}${JSON.stringify(record)}\n`);
    this.appendLine(record);
    return this.load();
  }
  putMandate(data: StoredMandate): void { this.appendLine({ t: "mandate", v: 2, data }); }
  putHold(data: StoredHold): void { this.appendLine({ t: "hold", v: 2, data }); }
  putDispute(data: StoredDispute): void { this.appendLine({ t: "dispute", v: 2, data }); }
  putOp(data: OperationRecord): void { this.appendLine({ t: "op", v: 2, data }); }
  putOpCommit(data: OpCommit): void { this.appendLine({ t: "opcommit", v: 2, data }); }
  putStateCommit(data: StateCommit): void { this.appendLine({ t: "statecommit", v: 2, data }); }
  appendAudit(data: AuditEntry): void { this.appendLine({ t: "audit", v: 2, data }); }
}

/** SINGIT_STATE_DIR set -> durable FileStateStore in that dir; else an in-memory store (default). */
export function stateStoreFromEnv(env: NodeJS.ProcessEnv): StateStore {
  const dir = env.SINGIT_STATE_DIR;
  return dir ? new FileStateStore(dir) : new MemoryStateStore();
}
