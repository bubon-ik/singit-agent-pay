/**
 * Human-run CLI that mints a dispute approval token. The only place SINGIT_HUMAN_APPROVAL_SECRET
 * is read outside the server process; no MCP tool can produce this token.
 *
 * Usage: npm run approve -- <disputeId> <refund|reject> [refundAmountBaseUnits]
 */
import { issueApprovalToken } from "../src/approval.js";
import { AmountError, parseUsdc } from "../src/amount.js";

const [disputeId, outcome, refundAmountArg] = process.argv.slice(2);

if (!disputeId || (outcome !== "refund" && outcome !== "reject")) {
  console.error("usage: npm run approve -- <disputeId> <refund|reject> [refundAmountBaseUnits]");
  process.exit(1);
}

const secret = process.env.SINGIT_HUMAN_APPROVAL_SECRET;
if (!secret || secret.length < 16) {
  console.error("BLOCKED: SINGIT_HUMAN_APPROVAL_SECRET is missing or shorter than 16 characters");
  process.exit(1);
}

let refundAmount = 0n;
if (outcome === "refund") {
  try {
    refundAmount = parseUsdc(refundAmountArg ?? "0");
  } catch (err) {
    console.error(`BLOCKED: ${err instanceof AmountError ? err.message : String(err)}`);
    process.exit(1);
  }
}

const token = issueApprovalToken(secret, { disputeId, outcome, refundAmount });
console.error("Reminder: this is a human action — verify the dispute and amount out-of-band before approving.");
console.log(token);
