/**
 * Human approval tokens for dispute resolution. A token is an HMAC-SHA256 over the exact
 * decision being approved, so it can't be replayed for a different outcome or amount.
 * No MCP tool can mint one: only `scripts/approve.ts`, run by the human, holds the secret.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const VERSION = "singit-dispute-v1";

export interface ApprovalDecision {
  disputeId: string;
  outcome: string;
  refundAmount: bigint;
}

function message(decision: ApprovalDecision): string {
  return `${VERSION}|${decision.disputeId}|${decision.outcome}|${decision.refundAmount}`;
}

export function issueApprovalToken(secret: string, decision: ApprovalDecision): string {
  return createHmac("sha256", secret).update(message(decision)).digest("hex");
}

export function verifyApprovalToken(secret: string, decision: ApprovalDecision, token: string): boolean {
  const expected = Buffer.from(issueApprovalToken(secret, decision), "hex");
  const actual = Buffer.from(token, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** SINGIT_HUMAN_APPROVAL_SECRET, read only by the server process and scripts/approve.ts. */
export function approvalSecretFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  const secret = env.SINGIT_HUMAN_APPROVAL_SECRET;
  return secret && secret.length >= 16 ? secret : undefined;
}
