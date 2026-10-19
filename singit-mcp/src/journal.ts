/** Pure, non-repairing journal reader shared by startup and offline inspection. */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { AuditEntry } from "./audit.js";
import type { OpCommit, OperationRecord, Snapshot, StateCommit, StoredDispute, StoredHold, StoredMandate } from "./store.js";

const text = z.string().min(1);
const amount = z.string().regex(/^(0|[1-9][0-9]*)$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const mandate = z.object({ id: text, payer: text, totalBudget: amount, perTxCap: amount, expiresAt: integer,
  allowedCounterparties: z.array(text), committed: amount, createdAt: integer, note: z.string().optional() });
const hold = z.object({ id: text, mandateId: text, payer: text, payee: text, mint: text, maximum: amount,
  held: amount, captured: amount, refunded: amount, captureDeadline: integer, refundDeadline: integer,
  txSigs: z.array(text), lastTxSig: text.nullable(), disputeId: text.optional(), quarantined: z.boolean().optional() });
const dispute = z.object({ id: text, holdId: text, mandateId: text, openedBy: text, reason: text,
  evidence: z.array(z.string()), status: z.enum(["open", "resolved"]), outcome: z.enum(["refund", "reject"]).optional(),
  refundAmount: amount.optional(), resolvedAt: integer.optional(), txSigs: z.array(text) });
const action = z.enum(["hold", "capture", "release", "refund", "resolve_release", "resolve_refund", "cleanup_release"]);
const operation = z.object({ id: text, key: text, action, actor: text, mandateId: text, holdId: text.nullable(),
  disputeId: text.optional(), params: z.object({ paramsHash: text }), salt: text.optional(),
  prepared: z.object({ txSig: text, holdId: text.optional(), lastValidBlockHeight: integer.optional() }).optional(),
  expected: z.object({ held: amount, refundable: amount }).optional(), state: z.enum(["pending", "unknown", "succeeded", "failed"]),
  result: z.object({ holdId: text.optional(), txSig: text.optional(), hold: hold.optional() }).optional(),
  error: z.object({ code: text, message: z.string(), refusalCode: text.optional() }).optional(),
  reservation: amount, createdAt: integer, updatedAt: integer });
const audit = z.object({ v: z.literal(1), seq: integer.positive(), ts: text, actor: z.string(), action: text,
  outcome: z.enum(["ok", "blocked", "error"]), code: text.nullable(), reason: z.string(),
  mandateId: text.nullable(), holdId: text.nullable(), disputeId: text.nullable(), amount: amount.nullable(),
  txSig: text.nullable(), held: amount.nullable(), refundable: amount.nullable(), operationId: text.optional(),
  operationAction: action.optional(), operationState: z.enum(["succeeded", "failed"]).optional(), recovered: z.boolean().optional() });
const bundle = z.object({ mandate: mandate.optional(), hold: hold.optional(), dispute: dispute.optional(), audit: audit.optional() });
const schemas = { mandate, hold, dispute, op: operation, audit,
  opcommit: bundle.extend({ op: operation }), statecommit: bundle.extend({ audit }) };

export type JournalCode = "JOURNAL_CORRUPT" | "JOURNAL_UNSUPPORTED" | "JOURNAL_CHANGED" | "LEGACY_REVIEW_REQUIRED";
export class JournalError extends Error {
  constructor(public readonly code: JournalCode, public readonly line: number, public readonly snapshot?: Snapshot) {
    // Never include raw bytes, parser errors, keys, evidence or paths in a public error.
    super(`${code}: journal refused${line ? ` at line ${line}` : ""}; preserve the original and inspect offline`);
    this.name = "JournalError";
  }
}

type Payloads = { mandate: StoredMandate; hold: StoredHold; dispute: StoredDispute; op: OperationRecord;
  audit: AuditEntry; opcommit: OpCommit; statecommit: StateCommit };
export type RecordLine = { [K in keyof Payloads]: { t: K; v: 1 | 2; data: Payloads[K] } }[keyof Payloads];

export function validateRecord(value: unknown, line: number): RecordLine {
  const rec = value as RecordLine | null;
  if (!rec || typeof rec !== "object" || typeof rec.t !== "string" || ![1, 2].includes(rec.v) ||
      !Object.hasOwn(schemas, rec.t) || (rec.v === 1 && rec.t === "statecommit")) {
    throw new JournalError("JOURNAL_UNSUPPORTED", line);
  }
  if (!schemas[rec.t].safeParse(rec.data).success) throw new JournalError("JOURNAL_CORRUPT", line);
  if (rec.t === "op" || rec.t === "opcommit") {
    const op: OperationRecord = rec.t === "op" ? rec.data : rec.data.op;
    const commit = rec.t === "opcommit" ? rec.data : undefined;
    const inconsistent = () => new JournalError(rec.v === 1 ? "LEGACY_REVIEW_REQUIRED" : "JOURNAL_CORRUPT", line);
    if (op.prepared && op.result?.txSig && op.result.txSig !== op.prepared.txSig) throw inconsistent();
    if (op.state === "succeeded") {
      const txSig = op.result?.txSig, terminalHold = commit?.hold ?? op.result?.hold;
      if ((op.prepared && txSig !== op.prepared.txSig) || (terminalHold &&
          (!txSig || !terminalHold.txSigs.includes(txSig) || terminalHold.lastTxSig !== txSig))) throw inconsistent();
    }
    if (rec.v === 1) return rec;
    if (op.action === "resolve_release" || op.action === "resolve_refund") {
      const decision = op.params.resolution as { refundAmount?: unknown; final?: unknown } | undefined;
      if (!decision || typeof op.params.disputeId !== "string" || typeof decision.refundAmount !== "string" ||
          !/^(0|[1-9][0-9]*)$/.test(decision.refundAmount) || typeof decision.final !== "boolean") {
        throw new JournalError("JOURNAL_CORRUPT", line);
      }
    }
    if (op.state === "succeeded" || op.state === "failed") {
      const proof: AuditEntry | undefined = commit?.audit;
      if (!proof || proof.action !== "operation_outcome" || proof.operationId !== op.id ||
          proof.operationAction !== op.action || proof.operationState !== op.state || proof.mandateId !== op.mandateId ||
          proof.holdId !== op.holdId || proof.txSig !== (op.result?.txSig ?? op.prepared?.txSig ?? null) ||
          proof.outcome !== (op.state === "succeeded" ? "ok" : "error")) throw new JournalError("JOURNAL_CORRUPT", line);
      if (commit?.mandate && commit.mandate.id !== op.mandateId) throw new JournalError("JOURNAL_CORRUPT", line);
      if (commit?.hold && (commit.hold.id !== op.holdId || commit.hold.mandateId !== op.mandateId ||
          !isDeepStrictEqual(commit.hold, op.result?.hold))) throw new JournalError("JOURNAL_CORRUPT", line);
      if (commit?.dispute && (commit.dispute.id !== op.params.disputeId || commit.dispute.holdId !== op.holdId)) {
        throw new JournalError("JOURNAL_CORRUPT", line);
      }
      if (op.state === "succeeded" && (op.action === "resolve_release" || op.action === "resolve_refund")) {
        const decision = op.params.resolution as { refundAmount: string; final: boolean };
        const resolved = commit?.dispute, txSig = op.result?.txSig;
        if (!commit?.hold || !resolved || resolved.mandateId !== op.mandateId || !txSig ||
            !resolved.txSigs.includes(txSig) || proof.disputeId !== resolved.id ||
            (op.action === "resolve_refund" && (!decision.final || op.params.amount !== decision.refundAmount)) ||
            (op.action === "resolve_release" && (!commit.mandate || decision.final !== (decision.refundAmount === "0"))) ||
            (decision.final ? resolved.status !== "resolved" || resolved.outcome !== "refund" ||
              resolved.refundAmount !== decision.refundAmount || resolved.resolvedAt !== op.updatedAt : resolved.status !== "open")) {
          throw new JournalError("JOURNAL_CORRUPT", line);
        }
      }
    }
  }
  return rec;
}

/** Reads v1 without rewriting it. Ambiguous old terminal accounting requires operator review;
 * an atomic v1 outcome can acquire a new audit proof without reapplying any balance delta. */
export function parseJournal(raw: string): Snapshot {
  const mandates = new Map<string, StoredMandate>(), holds = new Map<string, StoredHold>();
  const disputes = new Map<string, StoredDispute>(), ops = new Map<string, OperationRecord>();
  const audits = new Map<number, AuditEntry>(), unsafeLegacy = new Set<string>();
  const terminalRecords = new Map<string, RecordLine>(), proofs = new Map<string, AuditEntry>();
  const stateRecords = new Map<number, RecordLine>();
  const snapshot = (): Snapshot => {
    const entries = [...audits.values()].sort((a, b) => a.seq - b.seq);
    const sequence = (ids: string[], prefix: string) => ids.reduce((maximum, id) => {
      const value = id.startsWith(prefix) ? Number(id.slice(prefix.length)) : 0;
      return Number.isSafeInteger(value) && value >= 0 ? Math.max(maximum, value) : maximum;
    }, 0);
    return { mandates: [...mandates.values()], holds: [...holds.values()], disputes: [...disputes.values()], ops: [...ops.values()],
      audit: entries, seqs: { mandateSeq: sequence([...mandates.keys()], "m-"), disputeSeq: sequence([...disputes.keys()], "d-"),
        opSeq: sequence([...ops.keys()], "op-"), auditSeq: entries.at(-1)?.seq ?? 0 },
      ...(unsafeLegacy.size ? { legacyIssues: [...unsafeLegacy] } : {}) };
  };
  const checkAudit = (entry: AuditEntry, candidate?: OperationRecord) => {
    if (entry.action === "operation_outcome") {
      const op = candidate ?? ops.get(entry.operationId ?? "");
      if (!op || entry.operationId !== op.id || !["succeeded", "failed"].includes(op.state) ||
          entry.operationAction !== op.action || entry.operationState !== op.state || entry.mandateId !== op.mandateId ||
          entry.holdId !== op.holdId || entry.outcome !== (op.state === "succeeded" ? "ok" : "error") ||
          entry.txSig !== (op.result?.txSig ?? op.prepared?.txSig ?? null)) throw new JournalError("JOURNAL_CORRUPT", 0);
      const proof = proofs.get(op.id);
      if (proof && !isDeepStrictEqual(proof, entry)) throw new JournalError("JOURNAL_CORRUPT", 0);
    }
    const previous = audits.get(entry.seq);
    if (previous && !isDeepStrictEqual(previous, entry)) throw new JournalError("JOURNAL_CORRUPT", 0);
  };
  const applyAudit = (entry: AuditEntry) => {
    checkAudit(entry);
    if (entry.action === "operation_outcome") proofs.set(entry.operationId!, entry);
    audits.set(entry.seq, entry);
  };
  const applyOp = (op: OperationRecord, atomic: boolean) => {
    ops.set(op.id, op);
    if ((op.state === "succeeded" || op.state === "failed") && !atomic) unsafeLegacy.add(op.id);
    if (op.action.startsWith("resolve_") && !op.params.resolution) unsafeLegacy.add(op.id);
  };
  const applyState = (data: StateCommit | OpCommit) => {
    if (data.mandate) mandates.set(data.mandate.id, data.mandate);
    if (data.hold) holds.set(data.hold.id, data.hold);
    if (data.dispute) disputes.set(data.dispute.id, data.dispute);
    if (data.audit) applyAudit(data.audit);
  };
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    try {
      if (i === lines.length - 1 && !raw.endsWith("\n")) throw new JournalError("JOURNAL_CORRUPT", i + 1);
      const rec = validateRecord(JSON.parse(lines[i]), i + 1);
      if (rec.t === "statecommit") {
        const previous = stateRecords.get(rec.data.audit.seq);
        if (previous) {
          if (!isDeepStrictEqual(previous, rec)) throw new JournalError("JOURNAL_CORRUPT", i + 1);
          // Deduplicate the whole atomic unit before its old snapshots can rewind accounting.
          continue;
        }
        if (audits.has(rec.data.audit.seq)) throw new JournalError("JOURNAL_CORRUPT", i + 1);
        stateRecords.set(rec.data.audit.seq, rec);
      }
      // Validate bundled audit conflicts before changing any state. A refused record must
      // not leak its unaccepted mutations into the inspector's valid-prefix snapshot.
      if (rec.t === "opcommit" && rec.data.audit) checkAudit(rec.data.audit, rec.data.op);
      if (rec.t === "statecommit") checkAudit(rec.data.audit);
      if (rec.t === "op" || rec.t === "opcommit") {
        const op = rec.t === "op" ? rec.data : rec.data.op;
        const previous = terminalRecords.get(op.id);
        if (previous) {
          if (!isDeepStrictEqual(previous, rec)) throw new JournalError(rec.v === 1 ? "LEGACY_REVIEW_REQUIRED" : "JOURNAL_CORRUPT", i + 1);
          // A duplicated old commit cannot roll a hold back past a later operation's snapshot.
          continue;
        }
        if (op.state === "succeeded" || op.state === "failed") terminalRecords.set(op.id, rec);
      }
      switch (rec.t) {
        case "mandate": mandates.set(rec.data.id, rec.data); break;
        case "hold": holds.set(rec.data.id, rec.data); break;
        case "dispute": disputes.set(rec.data.id, rec.data); break;
        case "op": applyOp(rec.data, false); break;
        case "audit": applyAudit(rec.data); break;
        case "statecommit": applyState(rec.data); break;
        case "opcommit": {
          const data: OpCommit = rec.data;
          // v1 resolve children did not atomically persist their human decision/dispute.
          const safe = rec.v === 2 || (data.op.state === "succeeded" && !!data.hold && !!data.op.result?.hold &&
            isDeepStrictEqual(data.hold, data.op.result.hold) && !!data.op.result.txSig &&
            !data.op.action.startsWith("resolve_"));
          applyOp(data.op, safe);
          applyState(data);
          break;
        }
      }
    } catch (error) {
      throw new JournalError(error instanceof JournalError ? error.code : "JOURNAL_CORRUPT", i + 1, snapshot());
    }
  }
  const result = snapshot();
  if (unsafeLegacy.size) throw new JournalError("LEGACY_REVIEW_REQUIRED", 0, result);
  return result;
}
