/**
 * HTTP layer: the MCP streamable-HTTP transport, a read-only dashboard state endpoint, and the
 * human dispute-resolution console. All three share one PaymentService. "mcp" and "state" are
 * separate rate-limit buckets so dashboard polling never starves MCP tool calls.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AmountError, parseUsdc } from "./amount.js";
import { issueApprovalToken } from "./approval.js";
import { createRateLimiter } from "./ratelimit.js";
import { publicOperation } from "./public-state.js";
import { type AgentCredential, hostnameOf, LOOPBACK_HOSTNAMES, principalFromAuthorization } from "./principal.js";
import { createMcpServer } from "./server.js";
import { PaymentService, Refusal } from "./service.js";

const HUMAN_RESOLVE_BODY_LIMIT = 64 * 1024;

export interface HttpHandlerOptions {
  service: PaymentService;
  /** "mock" | "devnet" — reported in GET /api/state. */
  backendName: string;
  /** Validated local runtime identity only; no RPC URL, key path or credential. */
  paymentProfile?: Readonly<Record<string, unknown>>;
  approvalSecret?: string;
  routeSecret?: string;
  /** Requests/min for the "mcp" bucket (POST/GET/DELETE /mcp, POST /human/resolve, POST /human/reset). Default 120. */
  mcpPerMin?: number;
  /** Requests/min for the "state" bucket (GET /api/state). Default 600. */
  statePerMin?: number;
  /** ms clock, for limiter tests. */
  now?: () => number;
  /** Builds a fresh PaymentService for POST /human/reset. Only honored when backendName === "mock". */
  resetService?: () => PaymentService;
  /**
   * MVP-01 trusted principals: bearer tokens for the buyer / merchant agents. When non-empty, every
   * /mcp request must carry a valid `Authorization: Bearer` token and an allowed Host/Origin, and the
   * principal comes from the token, never from tool input. When empty, /mcp is open ONLY for the
   * mock backend (local demo); a live backend refuses unauthenticated MCP (401 AUTH_REQUIRED).
   */
  credentials?: AgentCredential[];
  /**
   * Legacy single-operator mode for a non-mock backend without agent tokens (the demo dashboard
   * bridge still acts all roles through one MCP client). Explicit opt-in only
   * (SINGIT_MCP_TRUSTED_OPERATOR=1); the server still binds loopback. Removed once the dashboard
   * sends per-role tokens.
   */
  trustedOperator?: boolean;
  /** Allowed Host header hostnames for /mcp when credentials are set. Default: loopback only. */
  allowedHosts?: string[];
  /** Allowed Origin values (exact, lowercased) for /mcp. Requests without Origin are allowed (non-browser clients). */
  allowedOrigins?: string[];
}

/** Recursively converts bigints to strings so the result is JSON.stringify-able. */
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

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(toJSON(body)));
}

function sendRateLimited(res: ServerResponse): void {
  sendJson(res, 429, { ok: false, error: "rate limited" }, { "Retry-After": "60" });
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Constant-time string compare; unequal lengths are rejected without a timingSafeEqual call. */
function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Shared /human/* route-secret check: not configured -> 403 HUMAN_ROUTE_DISABLED; missing/wrong
 * `x-singit-human-secret` header -> 401 HUMAN_AUTH_REQUIRED. Sends the error response itself.
 */
function checkHumanRouteSecret(req: IncomingMessage, res: ServerResponse, routeSecret: string | undefined): boolean {
  if (!routeSecret) {
    sendJson(res, 403, { ok: false, code: "HUMAN_ROUTE_DISABLED" });
    return false;
  }
  const header = req.headers["x-singit-human-secret"];
  const provided = typeof header === "string" ? header : "";
  if (!provided || !secretsMatch(provided, routeSecret)) {
    sendJson(res, 401, { ok: false, code: "HUMAN_AUTH_REQUIRED" });
    return false;
  }
  return true;
}

export function createHttpHandler(opts: HttpHandlerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const { backendName, approvalSecret, routeSecret, resetService } = opts;
  let service = opts.service;
  const now = opts.now ?? Date.now;
  const allowMcp = createRateLimiter(opts.mcpPerMin ?? 120, now);
  const allowState = createRateLimiter(opts.statePerMin ?? 600, now);

  function clientKeyOf(req: IncomingMessage): string {
    return String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "unknown");
  }

  async function handleState(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!allowState(clientKeyOf(req))) {
      sendRateLimited(res);
      return;
    }
    const mandates = service.listMandates();
    const holds = mandates.flatMap((m) => m.holds);
    sendJson(
      res,
      200,
      { v: 1, backend: backendName, ...(opts.paymentProfile ? { profile: opts.paymentProfile } : {}), mandates, disputes: service.listDisputes(), audit: service.listAuditLog(), holds, ops: service.listOperations().map(publicOperation) },
      { "Access-Control-Allow-Origin": "*" },
    );
  }

  /**
   * MVP-04: economic readiness, separate from /health liveness. Counts and reason codes only (no
   * wires, salts or evidence). Live backends require the human route secret to read it.
   */
  async function handleReady(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!allowState(clientKeyOf(req))) {
      sendRateLimited(res);
      return;
    }
    if (backendName !== "mock" && !checkHumanRouteSecret(req, res, routeSecret)) return;
    const admission = service.admissionStatus();
    const ready = admission.open && admission.unresolvedOps === 0;
    sendJson(res, ready ? 200 : 503, { ok: true, ready, backend: backendName, admission });
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!allowMcp(clientKeyOf(req))) {
      sendRateLimited(res);
      return;
    }
    const credentials = opts.credentials ?? [];
    let principal;
    if (credentials.length > 0) {
      const host = hostnameOf(String(req.headers.host ?? ""));
      if (!(opts.allowedHosts ?? LOOPBACK_HOSTNAMES).includes(host)) {
        sendJson(res, 403, { ok: false, code: "HOST_NOT_ALLOWED" });
        return;
      }
      const origin = req.headers.origin;
      if (typeof origin === "string" && !(opts.allowedOrigins ?? []).includes(origin.toLowerCase())) {
        sendJson(res, 403, { ok: false, code: "ORIGIN_NOT_ALLOWED" });
        return;
      }
      const header = req.headers.authorization;
      principal = principalFromAuthorization(typeof header === "string" ? header : undefined, credentials);
      if (!principal) {
        sendJson(res, 401, { ok: false, code: "AUTH_REQUIRED" }, { "WWW-Authenticate": "Bearer" });
        return;
      }
    } else if (backendName !== "mock" && !opts.trustedOperator) {
      sendJson(res, 401, { ok: false, code: "AUTH_REQUIRED", reason: "live backend requires SINGIT_BUYER_TOKEN / SINGIT_MERCHANT_TOKEN" });
      return;
    }
    const mcpServer = createMcpServer(service, principal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  }

  async function handleHumanResolve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!allowMcp(clientKeyOf(req))) {
      sendRateLimited(res);
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req, HUMAN_RESOLVE_BODY_LIMIT);
    } catch {
      sendJson(res, 400, { ok: false, code: "INVALID_INPUT", reason: "body too large" });
      return;
    }

    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { ok: false, code: "INVALID_INPUT", reason: "invalid JSON body" });
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      sendJson(res, 400, { ok: false, code: "INVALID_INPUT", reason: "body must be a JSON object" });
      return;
    }
    const body = parsed as Record<string, unknown>;
    const { disputeId, outcome, refundAmount: refundAmountRaw, actor, approvalToken: suppliedToken, idempotencyKey: suppliedKey } = body;
    if (typeof disputeId !== "string" || !disputeId || (outcome !== "refund" && outcome !== "reject")) {
      sendJson(res, 400, { ok: false, code: "INVALID_INPUT", reason: 'disputeId (string) and outcome ("refund"|"reject") are required' });
      return;
    }

    let refundAmount: bigint | undefined;
    if (refundAmountRaw !== undefined) {
      try {
        if (typeof refundAmountRaw !== "string") throw new AmountError("refundAmount must be a base-unit string");
        refundAmount = parseUsdc(refundAmountRaw);
      } catch (err) {
        sendJson(res, 400, { ok: false, code: "INVALID_INPUT", reason: err instanceof AmountError ? err.message : "invalid refundAmount" });
        return;
      }
    }

    if (!checkHumanRouteSecret(req, res, routeSecret)) return;

    let approvalToken: string | undefined;
    if (typeof suppliedToken === "string" && suppliedToken) {
      // Token from `npm run approve` is itself the proof; pass it through as-is.
      approvalToken = suppliedToken;
    } else if (approvalSecret) {
      approvalToken = issueApprovalToken(approvalSecret, { disputeId, outcome, refundAmount: refundAmount ?? 0n });
    }
    // else: no approvalSecret configured; let the service refuse with HUMAN_APPROVAL_REQUIRED.

    // One human decision = one intent (MVP-02): a retried click or lost response replays the
    // original resolution instead of acting twice. Clients may pass their own key instead.
    const idempotencyKey =
      typeof suppliedKey === "string" && suppliedKey
        ? suppliedKey
        : `human-${createHash("sha256").update(`${disputeId}|${outcome}|${refundAmount ?? 0n}`).digest("hex").slice(0, 40)}`;

    try {
      const dispute = await service.resolveDispute({
        actor: typeof actor === "string" && actor ? actor : "human",
        disputeId,
        outcome,
        refundAmount,
        approvalToken,
        idempotencyKey,
      });
      sendJson(res, 200, { ok: true, dispute, txSig: dispute.txSigs.at(-1) ?? null });
    } catch (err) {
      if (err instanceof Refusal) {
        sendJson(res, 409, { ok: false, code: err.code, reason: err.message });
        return;
      }
      throw err;
    }
  }

  async function handleHumanReset(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!allowMcp(clientKeyOf(req))) {
      sendRateLimited(res);
      return;
    }
    if (!checkHumanRouteSecret(req, res, routeSecret)) return;

    if (backendName !== "mock" || !resetService) {
      sendJson(res, 409, { ok: false, code: "RESET_MOCK_ONLY", reason: "reset only in mock mode" });
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req, HUMAN_RESOLVE_BODY_LIMIT);
    } catch {
      sendJson(res, 400, { ok: false, code: "INVALID_INPUT", reason: "body too large" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { ok: false, code: "INVALID_INPUT", reason: "invalid JSON body" });
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      sendJson(res, 400, { ok: false, code: "INVALID_INPUT", reason: "body must be a JSON object" });
      return;
    }
    const { actor } = parsed as Record<string, unknown>;

    service = resetService();
    service.recordReset(typeof actor === "string" && actor ? actor : "human");
    sendJson(res, 200, { ok: true, reset: true, audit: service.listAuditLog() });
  }

  /** MVP-01: the human control path for mandate issuance. Guarded by the human route secret, never by an agent token. */
  async function handleHumanMandate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!allowMcp(clientKeyOf(req))) {
      sendRateLimited(res);
      return;
    }
    if (!checkHumanRouteSecret(req, res, routeSecret)) return;
    let body: Record<string, unknown>;
    try {
      const raw = await readBody(req, HUMAN_RESOLVE_BODY_LIMIT);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { ok: false, code: "INVALID_INPUT", reason: "JSON object body required" });
      return;
    }
    const { payer, totalBudget, perTxCap, expiresAt, allowedCounterparties, note } = body;
    if (
      typeof payer !== "string" || typeof totalBudget !== "string" || typeof perTxCap !== "string" ||
      typeof expiresAt !== "number" || !Array.isArray(allowedCounterparties) ||
      !allowedCounterparties.every((c) => typeof c === "string") || (note !== undefined && typeof note !== "string")
    ) {
      sendJson(res, 400, { ok: false, code: "INVALID_INPUT", reason: "payer, totalBudget, perTxCap (strings), expiresAt (unix s), allowedCounterparties (string[]) required" });
      return;
    }
    try {
      const mandate = await service.createMandate({
        actor: payer,
        payer,
        totalBudget: parseUsdc(totalBudget),
        perTxCap: parseUsdc(perTxCap),
        expiresAt,
        allowedCounterparties: allowedCounterparties as string[],
        note: note as string | undefined,
      });
      sendJson(res, 200, { ok: true, mandate, remaining: mandate.totalBudget - mandate.committed });
    } catch (err) {
      if (err instanceof AmountError) {
        sendJson(res, 400, { ok: false, code: "INVALID_INPUT", reason: err.message });
        return;
      }
      if (err instanceof Refusal) {
        sendJson(res, 409, { ok: false, code: err.code, reason: err.message });
        return;
      }
      throw err;
    }
  }

  return function httpHandler(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      try {
        const method = req.method ?? "GET";
        const url = req.url ?? "/";

        if (method === "GET" && url === "/health") {
          // Liveness only: the process answers. It says nothing about permission to send (see /ready).
          sendJson(res, 200, { ok: true });
          return;
        }
        if (method === "GET" && url === "/ready") {
          await handleReady(req, res);
          return;
        }
        if (method === "GET" && url === "/api/state") {
          await handleState(req, res);
          return;
        }
        if (url === "/mcp" && (method === "POST" || method === "GET" || method === "DELETE")) {
          await handleMcp(req, res);
          return;
        }
        if (method === "POST" && url === "/human/resolve") {
          await handleHumanResolve(req, res);
          return;
        }
        if (method === "POST" && url === "/human/mandate") {
          await handleHumanMandate(req, res);
          return;
        }
        if (method === "POST" && url === "/human/reset") {
          await handleHumanReset(req, res);
          return;
        }
        res.writeHead(404).end();
      } catch (err) {
        console.error("error handling request:", err);
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: "internal error" });
        }
      }
    })();
  };
}
