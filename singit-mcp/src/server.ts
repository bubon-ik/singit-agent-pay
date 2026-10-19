/**
 * MCP surface for PaymentService. Tool names are the audit action names (hold IS the pay tool —
 * there is no separate `pay`). Amounts cross this boundary as base-unit decimal strings; the
 * service works in bigint. Refusals never throw: they come back as isError + {ok:false, code, reason}.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AmountError, parseUsdc } from "./amount.js";
import { PaymentService, Refusal } from "./service.js";

/** Recursively converts bigints to strings so the result is both JSON.stringify-able and a valid structuredContent object. */
function toJSON(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJSON);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = toJSON(v);
    }
    return out;
  }
  return value;
}

function toResult(obj: Record<string, unknown>, isError = false): CallToolResult {
  const structured = toJSON(obj) as Record<string, unknown>;
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    ...(isError ? { isError: true } : {}),
  };
}

/** Runs a tool body; converts Refusal/AmountError into the refusal result shape instead of throwing. */
async function run(fn: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    const data = await fn();
    return toResult({ ok: true, ...data });
  } catch (err) {
    if (err instanceof Refusal) {
      return toResult({ ok: false, code: err.code, reason: err.message }, true);
    }
    if (err instanceof AmountError) {
      return toResult({ ok: false, code: "INVALID_INPUT", reason: err.message }, true);
    }
    throw err;
  }
}

const amount = z.string().describe('USDC base units (6 decimals) as a decimal string, e.g. "1250000" = 1.25 USDC');
const actor = z.string().describe("The calling agent's id/address.");
const mandateId = z.string().describe("Mandate id, e.g. m-1.");
const holdId = z.string().describe("Hold id (capture402 payment PDA, or a mock id).");
const disputeId = z.string().describe("Dispute id, e.g. d-1.");
const unixSeconds = z.number().int().describe("Unix seconds (not milliseconds).");

export const toolSchemas = {
  create_mandate: {
    actor,
    payer: z.string().describe("Paying agent's address."),
    totalBudget: amount.describe("Total USDC budget for this mandate, base units."),
    perTxCap: amount.describe("Maximum USDC per hold, base units."),
    expiresAt: unixSeconds.describe("No new holds after this; also the latest allowed captureDeadline."),
    allowedCounterparties: z.array(z.string()).describe("Payee addresses this mandate may pay."),
    note: z.string().optional().describe("Free-text note."),
  },
  get_mandate: {
    mandateId,
  },
  list_mandates: {},
  hold: {
    actor,
    mandateId,
    payee: z.string().describe("Counterparty to pay; must be in the mandate's allowedCounterparties."),
    amount: amount.describe("Maximum to lock in escrow, base units."),
    mint: z.string().optional().describe("SPL mint; defaults to and must equal devnet USDC."),
    captureDeadline: unixSeconds.optional().describe("Defaults to min(mandate.expiresAt, now + 7 days)."),
    refundDeadline: unixSeconds.optional().describe("Defaults to captureDeadline + 24h; must be 1h-30d after captureDeadline."),
  },
  capture: {
    actor,
    holdId,
    amount: amount.describe("Amount to capture, base units; must be <= held."),
    releaseRemainder: z.boolean().optional().describe("If true, return any uncaptured remainder to the payer in the same call."),
  },
  release: {
    actor,
    holdId,
  },
  refund: {
    actor,
    holdId,
    amount: amount.describe("Amount to refund, base units; must be <= captured - already refunded."),
  },
  open_dispute: {
    actor,
    holdId,
    reason: z.string().describe("Why this hold is disputed."),
    evidence: z.array(z.string()).describe("Evidence references (urls, hashes, free text)."),
  },
  list_disputes: {
    status: z.enum(["open", "resolved"]).optional(),
    mandateId: mandateId.optional(),
  },
  resolve_dispute: {
    actor,
    disputeId,
    outcome: z.enum(["refund", "reject"]),
    refundAmount: amount.optional().describe("Required for outcome=refund; base units."),
    approvalToken: z
      .string()
      .describe(
        "Human approval token for this exact decision, issued out-of-band by `npm run approve` (never by any MCP tool).",
      ),
  },
  list_audit_log: {
    mandateId: mandateId.optional(),
    limit: z.number().int().optional().describe("Return only the last N entries."),
  },
};

export function createMcpServer(service: PaymentService): McpServer {
  const server = new McpServer({ name: "singit-mcp", version: "0.1.0" });

  server.registerTool(
    "create_mandate",
    {
      description:
        "Create a spending mandate: total budget, per-tx cap, expiry, and the counterparties it may pay. " +
        "Required once before any hold/pay against it.",
      inputSchema: toolSchemas.create_mandate,
    },
    (args) =>
      run(async () => {
        const mandate = await service.createMandate({
          actor: args.actor,
          payer: args.payer,
          totalBudget: parseUsdc(args.totalBudget),
          perTxCap: parseUsdc(args.perTxCap),
          expiresAt: args.expiresAt,
          allowedCounterparties: args.allowedCounterparties,
          note: args.note,
        });
        return { mandate, remaining: mandate.totalBudget - mandate.committed };
      }),
  );

  server.registerTool(
    "get_mandate",
    {
      description: "Look up a mandate by id: its terms, remaining budget, and its holds.",
      inputSchema: toolSchemas.get_mandate,
    },
    (args) => run(async () => service.getMandate(args.mandateId)),
  );

  server.registerTool(
    "list_mandates",
    {
      description: "List every mandate with its remaining budget and holds.",
      inputSchema: toolSchemas.list_mandates,
    },
    () => run(async () => ({ mandates: service.listMandates() })),
  );

  server.registerTool(
    "hold",
    {
      description:
        "Pay a counterparty by locking up to `amount` in escrow (capture402 authorize). This IS the pay tool. " +
        "There is no separate `pay` tool. The payee later captures some or all of it, or lets it expire.",
      inputSchema: toolSchemas.hold,
    },
    (args) =>
      run(async () => {
        const hold = await service.hold({
          actor: args.actor,
          mandateId: args.mandateId,
          payee: args.payee,
          amount: parseUsdc(args.amount),
          mint: args.mint,
          captureDeadline: args.captureDeadline,
          refundDeadline: args.refundDeadline,
        });
        const { remaining } = service.getMandate(hold.mandateId);
        return { hold, txSig: hold.lastTxSig, remaining };
      }),
  );

  server.registerTool(
    "capture",
    {
      description: "Capture some or all of a held escrow payment (capture402 capture). Caller must be the hold's payee.",
      inputSchema: toolSchemas.capture,
    },
    (args) =>
      run(async () => {
        const hold = await service.capture({
          actor: args.actor,
          holdId: args.holdId,
          amount: parseUsdc(args.amount),
          releaseRemainder: args.releaseRemainder,
        });
        return { hold, txSig: hold.lastTxSig };
      }),
  );

  server.registerTool(
    "release",
    {
      description: "Release everything still held on a hold back to the payer (capture402 void). Caller must be the payee.",
      inputSchema: toolSchemas.release,
    },
    (args) =>
      run(async () => {
        const hold = await service.release({ actor: args.actor, holdId: args.holdId });
        return { hold, txSig: hold.lastTxSig };
      }),
  );

  server.registerTool(
    "refund",
    {
      description:
        "Refund a previously captured amount back to the payer, paid from the payee's own balance (capture402 refund). " +
        "Caller must be the hold's payee. Does not restore mandate budget.",
      inputSchema: toolSchemas.refund,
    },
    (args) =>
      run(async () => {
        const hold = await service.refund({
          actor: args.actor,
          holdId: args.holdId,
          amount: parseUsdc(args.amount),
        });
        return { hold, txSig: hold.lastTxSig };
      }),
  );

  server.registerTool(
    "open_dispute",
    {
      description: "Open a dispute on a hold. Caller must be the hold's payer. Freezes further captures until resolved.",
      inputSchema: toolSchemas.open_dispute,
    },
    (args) =>
      run(async () => {
        const dispute = await service.openDispute({
          actor: args.actor,
          holdId: args.holdId,
          reason: args.reason,
          evidence: args.evidence,
        });
        return { dispute };
      }),
  );

  server.registerTool(
    "list_disputes",
    {
      description: "List disputes, optionally filtered by status and/or mandate.",
      inputSchema: toolSchemas.list_disputes,
    },
    (args) => run(async () => ({ disputes: service.listDisputes({ status: args.status, mandateId: args.mandateId }) })),
  );

  server.registerTool(
    "resolve_dispute",
    {
      description:
        "Resolve an open dispute as `refund` or `reject`. Requires a human approval token for this exact " +
        "(disputeId, outcome, refundAmount) decision, minted out-of-band by a human running `npm run approve` " +
        "on their own machine. No tool in this server can produce, derive, or guess that token.",
      inputSchema: toolSchemas.resolve_dispute,
    },
    (args) =>
      run(async () => {
        const dispute = await service.resolveDispute({
          actor: args.actor,
          disputeId: args.disputeId,
          outcome: args.outcome,
          refundAmount: args.refundAmount !== undefined ? parseUsdc(args.refundAmount) : undefined,
          approvalToken: args.approvalToken,
        });
        const txSig = dispute.txSigs.length > 0 ? dispute.txSigs[dispute.txSigs.length - 1] : null;
        return { dispute, txSig };
      }),
  );

  server.registerTool(
    "list_audit_log",
    {
      description: "List audit log entries (every create_mandate/hold/capture/release/refund/dispute call and its outcome).",
      inputSchema: toolSchemas.list_audit_log,
    },
    (args) => run(async () => ({ entries: service.listAuditLog({ mandateId: args.mandateId, limit: args.limit }) })),
  );

  return server;
}
