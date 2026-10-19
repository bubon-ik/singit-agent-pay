import { createServer, type Server } from "node:http";
import { expect, test } from "vitest";
import { issueApprovalToken } from "../src/approval.js";
import { MockBackend } from "../src/backend/mock.js";
import { createHttpHandler, type HttpHandlerOptions } from "../src/http.js";
import { PaymentService } from "../src/service.js";

const APPROVAL_SECRET = "approval-secret-0123456789";
const ROUTE_SECRET = "route-secret-0123456789abcd";

async function startServer(overrides: Partial<HttpHandlerOptions> = {}) {
  const backend = new MockBackend({ balances: { payer: 1_000_000_000n, payee: 1_000_000_000n } });
  const service = overrides.service ?? new PaymentService({ backend, approvalSecret: APPROVAL_SECRET });
  const handler = createHttpHandler({
    service,
    backendName: "mock",
    approvalSecret: APPROVAL_SECRET,
    routeSecret: ROUTE_SECRET,
    mcpPerMin: 3,
    statePerMin: 50,
    ...overrides,
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, service, base: `http://127.0.0.1:${port}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function toolsListRequest(base: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

async function openDisputeOn(service: PaymentService, payee: string): Promise<{ holdId: string; disputeId: string }> {
  const mandate = await service.createMandate({
    actor: "payer",
    payer: "payer",
    totalBudget: 5_000_000n,
    perTxCap: 5_000_000n,
    expiresAt: Math.floor(Date.now() / 1000) + 100_000,
    allowedCounterparties: [payee],
  });
  const hold = await service.hold({ actor: "payer", mandateId: mandate.id, payee, amount: 1_000_000n });
  await service.capture({ actor: payee, holdId: hold.id, amount: 1_000_000n });
  const dispute = await service.openDispute({ actor: "payer", holdId: hold.id, reason: "bad", evidence: [] });
  return { holdId: hold.id, disputeId: dispute.id };
}

test("GET /api/state has the right shape and reflects a mandate+hold created directly", async () => {
  const { server, service, base } = await startServer();
  try {
    const empty = await (await fetch(`${base}/api/state`)).json();
    expect(empty.v).toBe(1);
    expect(empty.backend).toBe("mock");
    expect(empty.mandates).toEqual([]);
    expect(empty.disputes).toEqual([]);
    expect(empty.audit).toEqual([]);
    expect(empty.holds).toEqual([]);
    expect(empty.ops).toEqual([]);

    const mandate = await service.createMandate({
      actor: "payer",
      payer: "payer",
      totalBudget: 1_000_000n,
      perTxCap: 1_000_000n,
      expiresAt: Math.floor(Date.now() / 1000) + 100_000,
      allowedCounterparties: ["payee"],
    });
    const hold = await service.hold({ actor: "payer", mandateId: mandate.id, payee: "payee", amount: 500_000n });

    const res = await fetch(`${base}/api/state`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const state = await res.json();
    expect(state.mandates).toHaveLength(1);
    expect(state.mandates[0].mandate.id).toBe(mandate.id);
    expect(state.mandates[0].mandate.totalBudget).toBe("1000000");
    expect(state.holds).toHaveLength(1);
    expect(state.holds[0].id).toBe(hold.id);
    expect(state.holds[0].maximum).toBe("500000");
    expect(state.audit.length).toBeGreaterThan(0);
    expect(state.ops).toHaveLength(1);
    expect(state.ops[0].action).toBe("hold");
    expect(state.ops[0].state).toBe("succeeded");
    expect(state.ops[0].holdId).toBe(hold.id);
    expect(state.ops[0].reservation).toBe("0");
  } finally {
    await closeServer(server);
  }
});

test("polling /api/state does not consume the mcp bucket, and each bucket enforces its own limit", async () => {
  const { server, base } = await startServer({ mcpPerMin: 3, statePerMin: 22 });
  try {
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`${base}/api/state`);
      expect(res.status).toBe(200);
    }

    const mcpStatuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      mcpStatuses.push((await toolsListRequest(base)).status);
    }
    expect(mcpStatuses).toEqual([200, 200, 200, 429]);
    const fourth = await toolsListRequest(base);
    expect(fourth.status).toBe(429);
    expect(fourth.headers.get("retry-after")).toBe("60");

    const stateStatuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      stateStatuses.push((await fetch(`${base}/api/state`)).status);
    }
    expect(stateStatuses).toContain(429);
  } finally {
    await closeServer(server);
  }
});

test("/human/resolve: no header -> 401", async () => {
  const { server, service, base } = await startServer();
  try {
    const { disputeId } = await openDisputeOn(service, "payee");
    const res = await fetch(`${base}/human/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disputeId, outcome: "reject" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("HUMAN_AUTH_REQUIRED");
  } finally {
    await closeServer(server);
  }
});

test("/human/resolve: wrong header -> 401", async () => {
  const { server, service, base } = await startServer();
  try {
    const { disputeId } = await openDisputeOn(service, "payee");
    const res = await fetch(`${base}/human/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-singit-human-secret": "not-the-right-secret-at-all" },
      body: JSON.stringify({ disputeId, outcome: "reject" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("HUMAN_AUTH_REQUIRED");
  } finally {
    await closeServer(server);
  }
});

test("/human/resolve: route secret not configured -> 403", async () => {
  const { server, service, base } = await startServer({ routeSecret: undefined });
  try {
    const { disputeId } = await openDisputeOn(service, "payee");
    const res = await fetch(`${base}/human/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disputeId, outcome: "reject" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("HUMAN_ROUTE_DISABLED");
  } finally {
    await closeServer(server);
  }
});

test("/human/resolve: valid header resolves the dispute and audits as human-approved", async () => {
  const { server, service, base } = await startServer();
  try {
    const { disputeId } = await openDisputeOn(service, "payee");
    const res = await fetch(`${base}/human/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-singit-human-secret": ROUTE_SECRET },
      body: JSON.stringify({ disputeId, outcome: "reject" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.dispute.status).toBe("resolved");

    const log = service.listAuditLog();
    const last = log.at(-1)!;
    expect(last.actor).toBe("human-approved:human");
    expect(last.outcome).toBe("ok");

    // Replay on the now-resolved dispute.
    const replay = await fetch(`${base}/human/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-singit-human-secret": ROUTE_SECRET },
      body: JSON.stringify({ disputeId, outcome: "reject" }),
    });
    expect(replay.status).toBe(409);
    expect((await replay.json()).code).toBe("DISPUTE_ALREADY_RESOLVED");
  } finally {
    await closeServer(server);
  }
});

test("/human/resolve: approvalToken with no header -> 401 HUMAN_AUTH_REQUIRED", async () => {
  const { server, service, base } = await startServer();
  try {
    const { disputeId } = await openDisputeOn(service, "payee-2");
    const validToken = issueApprovalToken(APPROVAL_SECRET, { disputeId, outcome: "reject", refundAmount: 0n });
    const res = await fetch(`${base}/human/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disputeId, outcome: "reject", approvalToken: validToken }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("HUMAN_AUTH_REQUIRED");
    expect(service.getDispute(disputeId).status).toBe("open");
  } finally {
    await closeServer(server);
  }
});

test("/human/resolve: forged approvalToken WITH valid route secret -> 409 HUMAN_APPROVAL_REQUIRED", async () => {
  const { server, service, base } = await startServer();
  try {
    const { disputeId } = await openDisputeOn(service, "payee-2");
    const forgedToken = issueApprovalToken("not-the-real-secret-at-all", { disputeId, outcome: "reject", refundAmount: 0n });
    const res = await fetch(`${base}/human/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-singit-human-secret": ROUTE_SECRET },
      body: JSON.stringify({ disputeId, outcome: "reject", approvalToken: forgedToken }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("HUMAN_APPROVAL_REQUIRED");
    expect(service.getDispute(disputeId).status).toBe("open");
  } finally {
    await closeServer(server);
  }
});

test("/human/resolve: valid approvalToken WITH valid route secret -> 200 resolved", async () => {
  const { server, service, base } = await startServer();
  try {
    const { disputeId } = await openDisputeOn(service, "payee-2");
    const validToken = issueApprovalToken(APPROVAL_SECRET, { disputeId, outcome: "reject", refundAmount: 0n });
    const res = await fetch(`${base}/human/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-singit-human-secret": ROUTE_SECRET },
      body: JSON.stringify({ disputeId, outcome: "reject", approvalToken: validToken }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.dispute.status).toBe("resolved");
    expect(service.getDispute(disputeId).status).toBe("resolved");
  } finally {
    await closeServer(server);
  }
});

test("unknown routes 404, /health is never rate limited", async () => {
  const { server, base } = await startServer();
  try {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    for (let i = 0; i < 5; i++) {
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
    }
  } finally {
    await closeServer(server);
  }
});
