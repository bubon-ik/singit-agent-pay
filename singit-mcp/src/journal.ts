/** Pure, non-repairing journal reader shared by startup and offline inspection. */
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
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
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const legacyReview = z.object({
  prefixSha256: digest, prefixBytes: integer.positive(), snapshotSha256: digest,
  namespace: z.object({ programId: text, genesisHash: text, payer: text, merchant: text }).strict(),
  operator: text, reviewer: text, reviewedAt: z.string().datetime(), evidenceSha256: digest,
  outcomes: z.array(z.discriminatedUnion("kind", [
    z.object({ operationId: text, kind: z.literal("finalized_success"), txSig: text,
      finality: z.literal("finalized"), err: z.null(), receipt: hold, evidenceSha256: digest }).strict(),
    z.object({ operationId: text, kind: z.literal("retained_failure"), txSig: z.null(),
      reason: text, evidenceSha256: digest }).strict(),
  ])).min(1),
}).strict();
export type LegacyReview = z.infer<typeof legacyReview>;
const schemas = { mandate, hold, dispute, op: operation, audit,
  opcommit: bundle.extend({ op: operation }), statecommit: bundle.extend({ audit }), legacyreview: legacyReview };

export type JournalCode = "JOURNAL_CORRUPT" | "JOURNAL_UNSUPPORTED" | "JOURNAL_CHANGED" | "LEGACY_REVIEW_REQUIRED";
export class JournalError extends Error {
  constructor(public readonly code: JournalCode, public readonly line: number, public readonly snapshot?: Snapshot) {
    // Never include raw bytes, parser errors, keys, evidence or paths in a public error.
    super(`${code}: journal refused${line ? ` at line ${line}` : ""}; preserve the original and inspect offline`);
    this.name = "JournalError";
  }
}

type Payloads = { mandate: StoredMandate; hold: StoredHold; dispute: StoredDispute; op: OperationRecord;
  audit: AuditEntry; opcommit: OpCommit; statecommit: StateCommit; legacyreview: LegacyReview };
export type RecordLine = { [K in keyof Payloads]: { t: K; v: 1 | 2; data: Payloads[K] } }[keyof Payloads];

export function validateRecord(value: unknown, line: number): RecordLine {
  const rec = value as RecordLine | null;
  if (!rec || typeof rec !== "object" || typeof rec.t !== "string" || ![1, 2].includes(rec.v) ||
      !Object.hasOwn(schemas, rec.t) || (rec.v === 1 && ["statecommit", "legacyreview"].includes(rec.t))) {
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

const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export const legacySnapshotSha256 = (snapshot: Snapshot) => hash(JSON.stringify(snapshot));

/** A named operator/reviewer disposition, never inferred from account absence or H=0.
 * It cannot replace accounting or originals. Receipt projections must already occur in
 * the retained v1 prefix and must reproduce its complete economic history exactly. */
function reviewedLegacyReceipts(prefix: string, snapshot: Snapshot, review: LegacyReview): Map<string, StoredHold> {
  function refuse(): never { throw new JournalError("LEGACY_REVIEW_REQUIRED", 0); }
  if (review.prefixSha256 !== hash(prefix) || review.prefixBytes !== Buffer.byteLength(prefix, "utf8") ||
      review.snapshotSha256 !== legacySnapshotSha256(snapshot) || review.operator === review.reviewer ||
      !snapshot.legacyIssues?.length || snapshot.ops.some(op => !["succeeded", "failed"].includes(op.state)) ||
      review.namespace.payer === review.namespace.merchant) refuse();
  const records = prefix.trimEnd().split("\n").map(line => validateRecord(JSON.parse(line), 0));
  if (records.some(rec => rec.v !== 1 || !["mandate", "hold", "dispute", "op", "audit"].includes(rec.t))) refuse();
  const originals = new Map<string, StoredHold>(), current = new Map<string, StoredHold>();
  for (const rec of records) {
    if (rec.t === "hold") current.set(rec.data.id, rec.data);
    if (rec.t === "op" && rec.data.state === "succeeded") {
      const h = current.get(rec.data.holdId ?? "");
      if (!h || originals.has(rec.data.id)) refuse();
      originals.set(rec.data.id, h);
    }
  }
  const outcomes = new Map(review.outcomes.map(outcome => [outcome.operationId, outcome]));
  if (outcomes.size !== review.outcomes.length || outcomes.size !== snapshot.ops.length) refuse();
  const receipts = new Map<string, StoredHold>(), history = new Map<string, StoredHold>();
  const retained = new Map<string, bigint>();
  const identity = ["id", "mandateId", "payer", "payee", "mint", "maximum", "captureDeadline", "refundDeadline"] as const;
  for (const op of snapshot.ops) {
    const outcome = outcomes.get(op.id), m = snapshot.mandates.find(m => m.id === op.mandateId);
    if (!outcome || !m || m.payer !== review.namespace.payer) refuse();
    if (op.state === "failed") {
      // No financial repair: even a stale failed-hold reservation stays committed.
      // This attestation does not prove no-send or authorize retrying that intent.
      if (outcome.kind !== "retained_failure" || op.action !== "hold" || op.prepared || op.result || op.holdId || !op.error) refuse();
      retained.set(m.id, (retained.get(m.id) ?? 0n) + BigInt(op.reservation));
      continue;
    }
    if (outcome.kind !== "finalized_success") refuse();
    const h = outcome.receipt, stored = originals.get(op.id), e = op.prepared?.evidence;
    const last = snapshot.holds.find(item => item.id === op.holdId);
    if (!stored || !isDeepStrictEqual(stored, h) || !last || !e ||
        e.programId !== review.namespace.programId || e.genesisHash !== review.namespace.genesisHash ||
        e.signature !== outcome.txSig || op.prepared?.txSig !== outcome.txSig || op.result?.txSig !== outcome.txSig ||
        op.prepared?.holdId !== h.id || h.id !== op.holdId || h.mandateId !== op.mandateId ||
        h.payer !== review.namespace.payer || h.payee !== review.namespace.merchant ||
        identity.some(key => h[key] !== last[key]) || h.lastTxSig !== outcome.txSig ||
        h.txSigs.at(-1) !== outcome.txSig || !isDeepStrictEqual(h.txSigs, last.txSigs.slice(0, h.txSigs.length))) refuse();
    const previous = history.get(h.id), amount = typeof op.params.amount === "string" && /^(0|[1-9][0-9]*)$/.test(op.params.amount)
      ? BigInt(op.params.amount) : 0n;
    let held = previous ? BigInt(previous.held) : 0n, captured = previous ? BigInt(previous.captured) : 0n;
    let refunded = previous ? BigInt(previous.refunded) : 0n;
    if (!isDeepStrictEqual(h.txSigs, [...(previous?.txSigs ?? []), outcome.txSig])) refuse();
    if (op.action === "hold") {
      if (previous || amount <= 0n || h.maximum !== amount.toString() || op.actor !== h.payer) refuse();
      held = amount;
    } else {
      if (!previous) refuse();
      if (op.action === "capture") {
        if (op.actor !== h.payee || amount <= 0n || amount > held) refuse();
        held = op.params.releaseRemainder === true ? 0n : held - amount; captured += amount;
      } else if (op.action === "release" || op.action === "cleanup_release") {
        if (op.actor !== h.payee || held <= 0n) refuse();
        held = 0n;
      } else if (op.action === "refund" || op.action === "resolve_refund") {
        if (amount <= 0n || amount > captured - refunded || (op.action === "refund" && op.actor !== h.payee)) refuse();
        refunded += amount;
        if (op.action === "resolve_refund") {
          const d = snapshot.disputes.find(d => d.id === op.params.disputeId);
          if (!d || d.status !== "resolved" || d.outcome !== "refund" || d.holdId !== h.id ||
              d.mandateId !== m.id || d.refundAmount !== amount.toString() || !d.txSigs.includes(outcome.txSig)) refuse();
        }
      } else refuse();
    }
    if (h.held !== held.toString() || h.captured !== captured.toString() || h.refunded !== refunded.toString() ||
        (op.expected && (op.expected.held !== h.held || op.expected.refundable !== (captured - refunded).toString()))) refuse();
    receipts.set(op.id, h); history.set(h.id, h);
  }
  if (history.size !== snapshot.holds.length || snapshot.disputes.some(d => d.status !== "resolved")) refuse();
  for (const h of snapshot.holds) {
    const final = history.get(h.id);
    if (!final || ["held", "captured", "refunded", "lastTxSig"].some(key => h[key as keyof StoredHold] !== final[key as keyof StoredHold]) ||
        !isDeepStrictEqual(h.txSigs, final.txSigs)) refuse();
    retained.set(h.mandateId, (retained.get(h.mandateId) ?? 0n) + BigInt(h.held) + BigInt(h.captured));
  }
  for (const m of snapshot.mandates) {
    if (BigInt(m.committed) !== (retained.get(m.id) ?? 0n) || BigInt(m.committed) > BigInt(m.totalBudget)) refuse();
  }
  return receipts;
}

/** Reads v1 without rewriting it. Ambiguous old terminal accounting requires operator review;
 * an atomic v1 outcome can acquire a new audit proof without reapplying any balance delta. */
export function parseJournal(raw: string): Snapshot {
  const mandates = new Map<string, StoredMandate>(), holds = new Map<string, StoredHold>();
  const disputes = new Map<string, StoredDispute>(), ops = new Map<string, OperationRecord>();
  const audits = new Map<number, AuditEntry>(), unsafeLegacy = new Set<string>();
  const terminalRecords = new Map<string, RecordLine>(), proofs = new Map<string, AuditEntry>();
  const stateRecords = new Map<number, RecordLine>();
  let reviewed = false;
  let reviewedNamespace: LegacyReview["namespace"] | undefined;
  const snapshot = (): Snapshot => {
    const entries = [...audits.values()].sort((a, b) => a.seq - b.seq);
    const sequence = (ids: string[], prefix: string) => ids.reduce((maximum, id) => {
      const value = id.startsWith(prefix) ? Number(id.slice(prefix.length)) : 0;
      return Number.isSafeInteger(value) && value >= 0 ? Math.max(maximum, value) : maximum;
    }, 0);
    return { mandates: [...mandates.values()], holds: [...holds.values()], disputes: [...disputes.values()], ops: [...ops.values()],
      audit: entries, seqs: { mandateSeq: sequence([...mandates.keys()], "m-"), disputeSeq: sequence([...disputes.keys()], "d-"),
        opSeq: sequence([...ops.keys()], "op-"), auditSeq: entries.at(-1)?.seq ?? 0 },
      ...(unsafeLegacy.size ? { legacyIssues: [...unsafeLegacy] } : {}),
      ...(reviewedNamespace ? { reviewedNamespace } : {}) };
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
      if (reviewed && (rec.v === 1 || rec.t === "legacyreview")) throw new JournalError("JOURNAL_CORRUPT", i + 1);
      if (rec.t === "legacyreview") {
        const receipts = reviewedLegacyReceipts(`${lines.slice(0, i).join("\n")}\n`, snapshot(), rec.data);
        for (const [id, receipt] of receipts) {
          const op = ops.get(id)!;
          ops.set(id, { ...op, result: { ...op.result, hold: receipt } });
        }
        unsafeLegacy.clear(); reviewed = true; reviewedNamespace = rec.data.namespace;
        continue;
      }
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
