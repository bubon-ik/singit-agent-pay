/**
 * Durable operation journal for PaymentService. All methods are SYNCHRONOUS so they can be
 * called from inside the atomic reservation section (before the first await to a backend).
 *
 * Every stored amount-like field is a decimal string (bigint serialized), never a bigint or
 * number, so a Snapshot round-trips through JSON without a custom reviver.
 */
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { AuditEntry, RefusalCode } from "./audit.js";
import type { PreparedTx } from "./backend/types.js";

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
  result?: { holdId?: string; txSig?: string };
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
}

export interface StateStore {
  load(): Snapshot;
  putMandate(m: StoredMandate): void;
  putHold(h: StoredHold): void;
  putDispute(d: StoredDispute): void;
  putOp(op: OperationRecord): void;
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
    return {
      mandates: [...this.mandates.values()],
      holds: [...this.holds.values()],
      disputes: [...this.disputes.values()],
      ops: [...this.ops.values()],
      audit: [...this.audit],
      seqs: computeSeqs(this.mandates.values(), this.disputes.values(), this.ops.values(), this.audit),
    };
  }

  putMandate(m: StoredMandate): void {
    this.mandates.set(m.id, m);
  }
  putHold(h: StoredHold): void {
    this.holds.set(h.id, h);
  }
  putDispute(d: StoredDispute): void {
    this.disputes.set(d.id, d);
  }
  putOp(op: OperationRecord): void {
    this.ops.set(op.id, op);
  }
  appendAudit(e: AuditEntry): void {
    this.audit.push(e);
  }
}

type RecordLine = { t: "mandate"; v: 1; data: StoredMandate } | { t: "hold"; v: 1; data: StoredHold } | { t: "dispute"; v: 1; data: StoredDispute } | { t: "op"; v: 1; data: OperationRecord } | { t: "audit"; v: 1; data: AuditEntry };

/**
 * Append-only JSONL durable store: one `state.jsonl` file per dir, one JSON object per line.
 * Replay on load (last record per id wins). A crash mid-write can leave the LAST line truncated
 * or corrupt; that line is skipped. Any earlier corruption is a real integrity problem and throws.
 */
export class FileStateStore implements StateStore {
  private readonly filePath: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.filePath = join(dir, "state.jsonl");
    if (!existsSync(this.filePath)) {
      appendFileSync(this.filePath, "", { mode: 0o600 });
    }
    chmodSync(this.filePath, 0o600);
  }

  private appendLine(line: RecordLine): void {
    const fd = openSync(this.filePath, "a");
    try {
      writeSync(fd, `${JSON.stringify(line)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  load(): Snapshot {
    const raw = readFileSync(this.filePath, "utf8");
    const lines = raw.split("\n");
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    const mandates = new Map<string, StoredMandate>();
    const holds = new Map<string, StoredHold>();
    const disputes = new Map<string, StoredDispute>();
    const ops = new Map<string, OperationRecord>();
    const auditBySeq = new Map<number, AuditEntry>();

    for (let i = 0; i < lines.length; i++) {
      let rec: RecordLine;
      try {
        rec = JSON.parse(lines[i]) as RecordLine;
      } catch (err) {
        if (i === lines.length - 1) {
          // Remove the interrupted tail before the next append; otherwise it becomes a
          // corrupt interior line and prevents the following restart from loading.
          const prefix = lines.slice(0, i).join("\n") + (i > 0 ? "\n" : "");
          const fd = openSync(this.filePath, "r+");
          try {
            ftruncateSync(fd, Buffer.byteLength(prefix));
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          continue;
        }
        throw new Error(`corrupt state store ${this.filePath}:${i + 1}: ${(err as Error).message}`);
      }
      switch (rec.t) {
        case "mandate":
          mandates.set(rec.data.id, rec.data);
          break;
        case "hold":
          holds.set(rec.data.id, rec.data);
          break;
        case "dispute":
          disputes.set(rec.data.id, rec.data);
          break;
        case "op":
          ops.set(rec.data.id, rec.data);
          break;
        case "audit":
          auditBySeq.set(rec.data.seq, rec.data);
          break;
      }
    }

    const audit = [...auditBySeq.values()].sort((a, b) => a.seq - b.seq);
    return {
      mandates: [...mandates.values()],
      holds: [...holds.values()],
      disputes: [...disputes.values()],
      ops: [...ops.values()],
      audit,
      seqs: computeSeqs(mandates.values(), disputes.values(), ops.values(), audit),
    };
  }

  putMandate(m: StoredMandate): void {
    this.appendLine({ t: "mandate", v: 1, data: m });
  }
  putHold(h: StoredHold): void {
    this.appendLine({ t: "hold", v: 1, data: h });
  }
  putDispute(d: StoredDispute): void {
    this.appendLine({ t: "dispute", v: 1, data: d });
  }
  putOp(op: OperationRecord): void {
    this.appendLine({ t: "op", v: 1, data: op });
  }
  appendAudit(e: AuditEntry): void {
    this.appendLine({ t: "audit", v: 1, data: e });
  }
}

/** SINGIT_STATE_DIR set -> durable FileStateStore in that dir; else an in-memory store (default). */
export function stateStoreFromEnv(env: NodeJS.ProcessEnv): StateStore {
  const dir = env.SINGIT_STATE_DIR;
  return dir ? new FileStateStore(dir) : new MemoryStateStore();
}
