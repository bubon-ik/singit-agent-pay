/**
 * MCP surface for PaymentService. Tool names are the audit action names (hold IS the pay tool —
 * there is no separate `pay`). Amounts cross this boundary as base-unit decimal strings; the
 * service works in bigint. Refusals never throw: they come back as isError + {ok:false, code, reason}.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AmountError, parseUsdc } from "./amount.js";
import type { Principal } from "./principal.js";
import { publicOperation } from "./public-state.js";
import { type Mandate, PaymentService, Refusal } from "./service.js";

type GuardedAction = "hold" | "capture" | "release" | "refund" | "open_dispute";
/** Which agent role may perform each mutating action (MVP-01). Mandate issuance and dispute resolution are human-only. */
const ROLE_FOR: Record<GuardedAction, ReadonlyArray<Principal["role"]>> = {
  hold: ["buyer"],
  open_dispute: ["buyer"],
  capture: ["merchant"],
  refund: ["merchant"],
  release: ["buyer", "merchant"],
};

function forbidden(message: string): Refusal {
  return new Refusal("PRINCIPAL_FORBIDDEN", message);
}

/** Authorization checks bound to the trusted principal. All run before any backend call. */
export function makeGuard(service: PaymentService, principal: Principal | undefined) {
  const canSee = (m: Mandate): boolean =>
    !principal || m.payer === principal.id || m.allowedCounterparties.includes(principal.id);
  const visibleMandateIds = (): Set<string> =>
    new Set(service.listMandates().filter((v) => canSee(v.mandate)).map((v) => v.mandate.id));
  return {
    mandateIssuance(): void {
      if (principal) {
        throw forbidden("mandates are issued only by the human control path (POST /human/mandate), never by an agent principal");
      }
    },
    humanOnly(what: string): void {
      if (principal) throw forbidden(`${what} is human-only; use the /human/* routes or \`npm run approve\``);
    },
    actorFor(action: GuardedAction, claimed: string | undefined, ref: { mandateId?: string; holdId?: string }): string {
      if (!principal) return claimed ?? "";
      if (!ROLE_FOR[action].includes(principal.role)) {
        throw forbidden(`${principal.role} principal may not ${action}`);
      }
      if (claimed !== undefined && claimed !== principal.id) {
        throw forbidden("actor does not match the authenticated principal");
      }
      const mandate = ref.mandateId
        ? service.getMandate(ref.mandateId).mandate
        : service.getMandate(service.getHold(ref.holdId!).mandateId).mandate;
      if (!canSee(mandate)) throw forbidden("object belongs to another principal");
      return principal.id;
    },
    mandateView<T extends { mandate: Mandate }>(view: T): T {
      if (!canSee(view.mandate)) throw forbidden("mandate belongs to another principal");
      return view;
    },
    filterMandates<T extends { mandate: Mandate }>(views: T[]): T[] {
      return views.filter((v) => canSee(v.mandate));
    },
    filterByMandate<T extends { mandateId?: string | null }>(items: T[]): T[] {
      if (!principal) return items;
      const ids = visibleMandateIds();
      return items.filter((i) => typeof i.mandateId === "string" && ids.has(i.mandateId));
    },
  };
}

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
async function run(fn: () => Promise<object>): Promise<CallToolResult> {
  try {
    const data = await fn();
    return toResult({ ok: true, ...data });
  } catch (err) {
    if (err instanceof Refusal) {
      return toResult({ ok: false, code: err.code, reason: err.message, operationId: err.operationId }, true);
    }
    if (err instanceof AmountError) {
      return toResult({ ok: false, code: "INVALID_INPUT", reason: err.message }, true);
    }
    throw err;
  }
}

const amount = z.string().describe('USDC base units (6 decimals) as a decimal string, e.g. "1250000" = 1.25 USDC');
const actor = z
  .string()
  .optional()
  .describe("Optional, informational only. With an authenticated principal it must equal the principal's own id; it never grants authority.");
const mandateId = z.string().describe("Mandate id, e.g. m-1.");
const holdId = z.string().describe("Hold id (capture402 payment PDA, or a mock id).");
const disputeId = z.string().describe("Dispute id, e.g. d-1.");
const unixSeconds = z.number().int().describe("Unix seconds (not milliseconds).");
const idempotencyKey = z
  .string()
  .optional()
  .describe(
    "Stable id for this one payment intent, 1-128 chars of [A-Za-z0-9._:-]. Generate it once and resend it UNCHANGED on every retry " +
      "(lost response, timeout, restart): the server then returns the original outcome instead of paying again. Required on the live backend.",
  );

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
    idempotencyKey,
  },
  capture: {
    actor,
    holdId,
    amount: amount.describe("Amount to capture, base units; must be <= held."),
    releaseRemainder: z.boolean().optional().describe("If true, return any uncaptured remainder to the payer in the same call."),
    idempotencyKey,
  },
  release: {
    actor,
    holdId,
    idempotencyKey,
  },
  refund: {
    actor,
    holdId,
    amount: amount.describe("Amount to refund, base units; must be <= captured - already refunded."),
    idempotencyKey,
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
    idempotencyKey,
  },
  get_operation: {
    operationId: z.string().describe("Operation id from a hold/capture/release/refund result or refusal, e.g. op-3."),
  },
  list_audit_log: {
    mandateId: mandateId.optional(),
    limit: z.number().int().optional().describe("Return only the last N entries."),
  },
};

/**
 * `principal` is the trusted caller identity from the transport (HTTP bearer token / stdio env).
 * Undefined = legacy open mode, allowed only for the local mock demo (see http.ts / index.ts).
 */
export function createMcpServer(service: PaymentService, principal?: Principal): McpServer {
  const server = new McpServer({ name: "singit-mcp", version: "0.1.0" });
  const guard = makeGuard(service, principal);

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
        guard.mandateIssuance();
        const mandate = await service.createMandate({
          actor: args.actor ?? args.payer,
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
    (args) => run(async () => guard.mandateView(service.getMandate(args.mandateId))),
  );

  server.registerTool(
    "list_mandates",
    {
      description: "List every mandate with its remaining budget and holds.",
      inputSchema: toolSchemas.list_mandates,
    },
    () => run(async () => ({ mandates: guard.filterMandates(service.listMandates()) })),
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
        const outcome = await service.holdOp({
          actor: guard.actorFor("hold", args.actor, { mandateId: args.mandateId }),
          mandateId: args.mandateId,
          payee: args.payee,
          amount: parseUsdc(args.amount),
          mint: args.mint,
          captureDeadline: args.captureDeadline,
          refundDeadline: args.refundDeadline,
          idempotencyKey: args.idempotencyKey,
        });
        const { remaining } = service.getMandate(outcome.hold.mandateId);
        return { ...outcome, remaining };
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
        return service.captureOp({
          actor: guard.actorFor("capture", args.actor, { holdId: args.holdId }),
          holdId: args.holdId,
          amount: parseUsdc(args.amount),
          releaseRemainder: args.releaseRemainder,
          idempotencyKey: args.idempotencyKey,
        });
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
        return service.releaseOp({
          actor: guard.actorFor("release", args.actor, { holdId: args.holdId }),
          holdId: args.holdId,
          idempotencyKey: args.idempotencyKey,
        });
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
        return service.refundOp({
          actor: guard.actorFor("refund", args.actor, { holdId: args.holdId }),
          holdId: args.holdId,
          amount: parseUsdc(args.amount),
          idempotencyKey: args.idempotencyKey,
        });
      }),
  );

  server.registerTool(
    "open_dispute",
    {
      description:
        "Open a dispute on a hold. Caller must be the hold's payer. This service then refuses captures until a human resolves it; " +
        "it is not an on-chain freeze and does not guarantee a refund.",
      inputSchema: toolSchemas.open_dispute,
    },
    (args) =>
      run(async () => {
        const dispute = await service.openDispute({
          actor: guard.actorFor("open_dispute", args.actor, { holdId: args.holdId }),
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
    (args) => run(async () => ({ disputes: guard.filterByMandate(service.listDisputes({ status: args.status, mandateId: args.mandateId })) })),
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
        guard.humanOnly("resolve_dispute");
        const dispute = await service.resolveDispute({
          actor: args.actor ?? "human",
          disputeId: args.disputeId,
          outcome: args.outcome,
          refundAmount: args.refundAmount !== undefined ? parseUsdc(args.refundAmount) : undefined,
          approvalToken: args.approvalToken,
          idempotencyKey: args.idempotencyKey,
        });
        const txSig = dispute.txSigs.length > 0 ? dispute.txSigs[dispute.txSigs.length - 1] : null;
        return { dispute, txSig };
      }),
  );

  server.registerTool(
    "get_operation",
    {
      description:
        "Read-only status of one economic operation (pending/unknown/succeeded/failed) by the operationId a write or refusal returned. " +
        "Use it after a lost response or OPERATION_UNKNOWN instead of paying again. Signed wires and private evidence are never returned.",
      inputSchema: toolSchemas.get_operation,
    },
    (args) =>
      run(async () => {
        const op = service.getOperation(args.operationId);
        if (guard.filterByMandate([op]).length === 0) throw new Refusal("PRINCIPAL_FORBIDDEN", "operation belongs to another principal");
        return { operation: publicOperation(op) };
      }),
  );

  server.registerTool(
    "list_audit_log",
    {
      description: "List audit log entries (every create_mandate/hold/capture/release/refund/dispute call and its outcome).",
      inputSchema: toolSchemas.list_audit_log,
    },
    (args) => run(async () => ({ entries: guard.filterByMandate(service.listAuditLog({ mandateId: args.mandateId, limit: args.limit })) })),
  );

  return server;
}
