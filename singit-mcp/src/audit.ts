/**
 * Audit log schema — STABLE v1. The demo dashboard consumes it. Add fields only; never rename or remove.
 * Built from MCP events + backend tx signatures (capture402 emits no program logs, QA L-2).
 */

/** Action names are exactly the MCP tool names (tool `hold` -> action "hold"). */

/** Refusal codes returned by tools and recorded in the audit log (`code`). */
export const RefusalCodes = [
  "INVALID_INPUT",
  "MANDATE_NOT_FOUND",
  "MANDATE_EXPIRED", // QA M-1
  "COUNTERPARTY_NOT_ALLOWED", // QA M-1
  "OVER_PER_TX_CAP", // QA M-1
  "OVER_BUDGET", // QA M-1
  "WRONG_MINT", // QA M-2
  "INVALID_DEADLINE", // QA M-3 (ms instead of s, beyond max hold, refund window too short)
  "HOLD_NOT_FOUND",
  "NOT_PAYER",
  "NOT_PAYEE",
  "CAPTURE_EXCEEDS_HOLD",
  "CAPTURE_DEADLINE_PASSED",
  "NOTHING_HELD",
  "REFUND_EXCEEDS_CAPTURED",
  "REFUND_DEADLINE_PASSED",
  "REFUND_WINDOW_CLOSED", // open_dispute: now >= hold.refundDeadline, same boundary as refund
  "DISPUTE_OPEN",
  "DISPUTE_NOT_FOUND",
  "DISPUTE_ALREADY_RESOLVED",
  "HUMAN_APPROVAL_REQUIRED", // QA H-1: missing/invalid human token, or approval not configured
  "BACKEND_ERROR",
] as const;
export type RefusalCode = (typeof RefusalCodes)[number];

export type AuditAction =
  | "create_mandate"
  | "hold"
  | "capture"
  | "release"
  | "refund"
  | "open_dispute"
  | "resolve_dispute"
  // "reset" is the only action that is not an MCP tool: HTTP POST /human/reset only (mock backend).
  | "reset";

export const AUDIT_SCHEMA_VERSION = 1 as const;

export interface AuditEntry {
  /** Schema version, always 1 for this shape. */
  v: typeof AUDIT_SCHEMA_VERSION;
  /** 1, 2, 3 ... in order of recording. */
  seq: number;
  /** ISO 8601 UTC. */
  ts: string;
  /** Agent/human id that made the call. For human-approved resolutions: "human-approved:<actor>". */
  actor: string;
  action: AuditAction;
  /** "ok" = executed, "blocked" = refused by a mandate/escrow rule (no money moved), "error" = backend failed. */
  outcome: "ok" | "blocked" | "error";
  /** RefusalCode when outcome != "ok", else null. */
  code: RefusalCode | null;
  /** Human-readable explanation, e.g. "BLOCKED: over budget: hold 3.000000 USDC but only 1.500000 USDC remains". */
  reason: string;
  mandateId: string | null;
  holdId: string | null;
  disputeId: string | null;
  /** USDC base units (6 decimals) as a decimal string. */
  amount: string | null;
  /** When money moved: mock ref (mock-tx-N) until Capture402Backend is wired to devnet, then the devnet tx signature. Else null. */
  txSig: string | null;
  /** Escrow state AFTER the call (base-unit strings), when a hold is involved. */
  held: string | null;
  refundable: string | null;
}
