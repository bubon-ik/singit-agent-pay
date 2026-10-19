import { createServer, type Server } from "node:http";
import { expect, test } from "vitest";
import { DEFAULT_MOCK_BALANCES, MockBackend } from "../src/backend/mock.js";
import { BackendError, DEVNET_USDC_MINT } from "../src/backend/types.js";
import { createHttpHandler, type HttpHandlerOptions } from "../src/http.js";
import { PaymentService } from "../src/service.js";

const APPROVAL_SECRET = "approval-secret-0123456789";
const ROUTE_SECRET = "route-secret-0123456789abcd";

function freshMockService(): PaymentService {
  return new PaymentService({ backend: new MockBackend({ balances: { ...DEFAULT_MOCK_BALANCES } }), approvalSecret: APPROVAL_SECRET });
}

async function startServer(overrides: Partial<HttpHandlerOptions> = {}) {
  const services: PaymentService[] = [freshMockService()];
  const handler = createHttpHandler({
    service: services[0],
    backendName: "mock",
    approvalSecret: APPROVAL_SECRET,
    routeSecret: ROUTE_SECRET,
    mcpPerMin: 50,
    statePerMin: 50,
    resetService: () => {
      const next = freshMockService();
      services.push(next);
      return next;
    },
    ...overrides,
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, services, base: `http://127.0.0.1:${port}` };
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

async function openDisputeOn(service: PaymentService): Promise<{ disputeId: string }> {
  const mandate = await service.createMandate({
    actor: "buyer-agent",
    payer: "buyer-agent",
    totalBudget: 5_000_000n,
    perTxCap: 5_000_000n,
    expiresAt: Math.floor(Date.now() / 1000) + 100_000,
    allowedCounterparties: ["seller-agent"],
  });
  const hold = await service.hold({ actor: "buyer-agent", mandateId: mandate.id, payee: "seller-agent", amount: 1_000_000n });
  const dispute = await service.openDispute({ actor: "buyer-agent", holdId: hold.id, reason: "bad", evidence: [] });
  return { disputeId: dispute.id };
}

test("/human/reset: no header -> 401", async () => {
  const { server, base } = await startServer();
  try {
    const res = await fetch(`${base}/human/reset`, { method: "POST" });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("HUMAN_AUTH_REQUIRED");
  } finally {
    await closeServer(server);
  }
});

test("/human/reset: wrong header -> 401", async () => {
  const { server, base } = await startServer();
  try {
    const res = await fetch(`${base}/human/reset`, {
      method: "POST",
      headers: { "x-singit-human-secret": "not-the-right-secret-at-all" },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("HUMAN_AUTH_REQUIRED");
  } finally {
    await closeServer(server);
  }
});

test("/human/reset: route secret not configured -> 403", async () => {
  const { server, base } = await startServer({ routeSecret: undefined });
  try {
    const res = await fetch(`${base}/human/reset`, { method: "POST" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("HUMAN_ROUTE_DISABLED");
  } finally {
    await closeServer(server);
  }
});

test("/human/reset: correct secret resets state to defaults", async () => {
  const { server, services, base } = await startServer();
  try {
    await openDisputeOn(services[0]);

    const res = await fetch(`${base}/human/reset`, {
      method: "POST",
      headers: { "x-singit-human-secret": ROUTE_SECRET },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.reset).toBe(true);
    expect(json.audit).toHaveLength(1);
    expect(json.audit[0]).toMatchObject({ seq: 1, action: "reset", actor: "human", outcome: "ok", v: 1 });

    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.mandates).toEqual([]);
    expect(state.holds).toEqual([]);
    expect(state.disputes).toEqual([]);
    expect(state.audit).toHaveLength(1);

    const current = services.at(-1)!;
    const mandate = await current.createMandate({
      actor: "agent:research-bot",
      payer: "agent:research-bot",
      totalBudget: 10_000_000n,
      perTxCap: 10_000_000n,
      expiresAt: Math.floor(Date.now() / 1000) + 100_000,
      allowedCounterparties: ["agent:data-vendor"],
    });
    expect(mandate.id).toBe("m-1");
    const hold = await current.hold({ actor: "agent:research-bot", mandateId: mandate.id, payee: "agent:data-vendor", amount: 5_000_000n });
    expect(hold.held).toBe(5_000_000n);
  } finally {
    await closeServer(server);
  }
});

test("/human/reset: devnet backend -> 409 RESET_MOCK_ONLY", async () => {
  const { server, base } = await startServer({ backendName: "devnet" });
  try {
    const res = await fetch(`${base}/human/reset`, {
      method: "POST",
      headers: { "x-singit-human-secret": ROUTE_SECRET },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("RESET_MOCK_ONLY");
  } finally {
    await closeServer(server);
  }
});

test("/human/reset: mock backend without resetService -> 409 RESET_MOCK_ONLY", async () => {
  const { server, base } = await startServer({ resetService: undefined });
  try {
    const res = await fetch(`${base}/human/reset`, {
      method: "POST",
      headers: { "x-singit-human-secret": ROUTE_SECRET },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("RESET_MOCK_ONLY");
  } finally {
    await closeServer(server);
  }
});

test("MCP tools/list still exactly the 11 tool names (no reset tool)", async () => {
  const { server, base } = await startServer();
  try {
    const res = await toolsListRequest(base);
    expect(res.status).toBe(200);
    const text = await res.text();
    const payload = JSON.parse(text.includes("data:") ? text.slice(text.indexOf("{")) : text);
    const names: string[] = payload.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([
      "create_mandate",
      "get_mandate",
      "list_mandates",
      "hold",
      "capture",
      "release",
      "refund",
      "open_dispute",
      "list_disputes",
      "resolve_dispute",
      "list_audit_log",
    ]);
    expect(names).not.toContain("reset");
  } finally {
    await closeServer(server);
  }
});

test("MockBackend default balances: agent:research-bot can hold 100 USDC but not 100.000001", async () => {
  const now = Math.floor(Date.now() / 1000);
  const ok = new MockBackend();
  await ok.hold({
    payer: "agent:research-bot",
    mint: DEVNET_USDC_MINT,
    payee: "agent:data-vendor",
    maximum: 100_000_000n,
    captureDeadline: now + 3600,
    refundDeadline: now + 7200,
    salt: "s1",
  });

  const tooMuch = new MockBackend();
  await expect(
    tooMuch.hold({
      payer: "agent:research-bot",
      mint: DEVNET_USDC_MINT,
      payee: "agent:data-vendor",
      maximum: 100_000_001n,
      captureDeadline: now + 3600,
      refundDeadline: now + 7200,
      salt: "s2",
    }),
  ).rejects.toThrow(BackendError);
});
