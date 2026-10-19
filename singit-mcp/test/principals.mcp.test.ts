// MVP-01 (#9): trusted principals over the ACTUAL streamable-HTTP MCP transport.
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { MockBackend } from "../src/backend/mock.js";
import type { PaymentBackend } from "../src/backend/types.js";
import { createHttpHandler } from "../src/http.js";
import type { AgentCredential } from "../src/principal.js";
import { PaymentService } from "../src/service.js";

const BUYER = "buyer-agent";
const MERCHANT = "seller-agent";
const OTHER_BUYER = "other-buyer";
const BUYER_TOKEN = "test-buyer-token-0000000001";
const MERCHANT_TOKEN = "test-merchant-token-00000001";
const OTHER_TOKEN = "test-other-buyer-token-00001";
const ROUTE_SECRET = "test-human-route-secret-0001";
const credentials: AgentCredential[] = [
  { role: "buyer", id: BUYER, token: BUYER_TOKEN },
  { role: "merchant", id: MERCHANT, token: MERCHANT_TOKEN },
  { role: "buyer", id: OTHER_BUYER, token: OTHER_TOKEN },
];

let server: Server;
let base: string;
let sends: number;

function counting(backend: PaymentBackend): PaymentBackend {
  for (const m of ["hold", "capture", "release", "refund"] as const) {
    const orig = (backend as any)[m].bind(backend);
    (backend as any)[m] = (...a: unknown[]) => {
      sends++;
      return orig(...a);
    };
  }
  return backend;
}

beforeEach(async () => {
  sends = 0;
  const service = new PaymentService({
    backend: counting(new MockBackend({ balances: { [BUYER]: 100_000_000n, [MERCHANT]: 20_000_000n, [OTHER_BUYER]: 100_000_000n } })),
  });
  server = createServer(createHttpHandler({ service, backendName: "mock", routeSecret: ROUTE_SECRET, credentials }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

async function client(token?: string): Promise<Client> {
  const c = new Client({ name: "principal-test", version: "1.0.0" });
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = (await c.callTool({ name, arguments: args })) as CallToolResult;
  const item = r.content?.[0];
  if (!item || item.type !== "text") throw new Error("expected text");
  return JSON.parse(item.text);
}
const now = () => Math.floor(Date.now() / 1000);
async function humanMandate(payer: string, totalBudget = "5000000", secret = ROUTE_SECRET): Promise<Response> {
  return fetch(`${base}/human/mandate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-singit-human-secret": secret },
    body: JSON.stringify({ payer, totalBudget, perTxCap: "2000000", expiresAt: now() + 3600, allowedCounterparties: [MERCHANT] }),
  });
}

test("unauthenticated and unknown-token MCP requests are rejected before business logic", async () => {
  await expect(client()).rejects.toThrow();
  await expect(client("not-a-real-token-xxxxxxxx")).rejects.toThrow();
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${base}/mcp`, { method: "POST", headers: { host: "evil.example", authorization: `Bearer ${BUYER_TOKEN}`, "content-type": "application/json" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end("{}");
  });
  expect(status).toBe(403);
  const o = await fetch(`${base}/mcp`, { method: "POST", headers: { origin: "https://evil.example", authorization: `Bearer ${BUYER_TOKEN}`, "content-type": "application/json" }, body: "{}" });
  expect(o.status).toBe(403);
  expect(sends).toBe(0);
});

test("an agent cannot issue or expand a mandate, even with the correct payer string", async () => {
  const buyer = await client(BUYER_TOKEN);
  const r = await call(buyer, "create_mandate", { actor: BUYER, payer: BUYER, totalBudget: "999000000", perTxCap: "999000000", expiresAt: now() + 3600, allowedCounterparties: [MERCHANT] });
  expect(r).toMatchObject({ ok: false, code: "PRINCIPAL_FORBIDDEN" });
  const m = await call(await client(MERCHANT_TOKEN), "create_mandate", { payer: BUYER, totalBudget: "1", perTxCap: "1", expiresAt: now() + 3600, allowedCounterparties: [MERCHANT] });
  expect(m.code).toBe("PRINCIPAL_FORBIDDEN");
  expect((await call(buyer, "list_mandates")).mandates).toHaveLength(0);
  // human path without / with wrong secret is refused
  expect((await humanMandate(BUYER, "5000000", "wrong-secret-wrong-secret")).status).toBe(401);
  expect(sends).toBe(0);
});

test("budget exhaustion cannot be bypassed by issuing another mandate; authorized paths work", async () => {
  const res = await humanMandate(BUYER, "2000000");
  expect(res.status).toBe(200);
  const mandateId = (await res.json()).mandate.id;
  const buyer = await client(BUYER_TOKEN);
  const merchant = await client(MERCHANT_TOKEN);
  const h = await call(buyer, "hold", { mandateId, payee: MERCHANT, amount: "2000000" });
  expect(h.ok).toBe(true);
  const holdId = h.hold.id;
  expect((await call(merchant, "capture", { holdId, amount: "1500000" })).ok).toBe(true);
  expect((await call(merchant, "release", { holdId })).ok).toBe(true);
  const sendsBefore = sends;
  expect((await call(buyer, "hold", { mandateId, payee: MERCHANT, amount: "1000000" })).code).toBe("OVER_BUDGET");
  expect((await call(buyer, "create_mandate", { payer: BUYER, totalBudget: "10000000", perTxCap: "2000000", expiresAt: now() + 3600, allowedCounterparties: [MERCHANT] })).code).toBe("PRINCIPAL_FORBIDDEN");
  expect(sends).toBe(sendsBefore);
});

test("actor substitution, wrong role and foreign ids are refused with send count 0", async () => {
  const mandateId = (await (await humanMandate(BUYER)).json()).mandate.id;
  const otherMandateId = (await (await humanMandate(OTHER_BUYER)).json()).mandate.id;
  const buyer = await client(BUYER_TOKEN);
  const merchant = await client(MERCHANT_TOKEN);
  const other = await client(OTHER_TOKEN);
  const before = sends;
  // buyer claims to be someone else
  expect((await call(buyer, "hold", { actor: OTHER_BUYER, mandateId: otherMandateId, payee: MERCHANT, amount: "1000000" })).code).toBe("PRINCIPAL_FORBIDDEN");
  // buyer uses a foreign mandate id without claiming an actor
  expect((await call(buyer, "hold", { mandateId: otherMandateId, payee: MERCHANT, amount: "1000000" })).code).toBe("PRINCIPAL_FORBIDDEN");
  // merchant cannot hold on behalf of the buyer
  expect((await call(merchant, "hold", { actor: BUYER, mandateId, payee: MERCHANT, amount: "1000000" })).code).toBe("PRINCIPAL_FORBIDDEN");
  expect(sends).toBe(before);
  const holdId = (await call(buyer, "hold", { mandateId, payee: MERCHANT, amount: "1000000" })).hold.id;
  const afterHold = sends;
  // buyer credentials cannot capture or refund
  expect((await call(buyer, "capture", { holdId, amount: "1000000" })).code).toBe("PRINCIPAL_FORBIDDEN");
  expect((await call(buyer, "refund", { holdId, amount: "1" })).code).toBe("PRINCIPAL_FORBIDDEN");
  // another buyer cannot touch or see this hold / mandate
  expect((await call(other, "release", { holdId })).code).toBe("PRINCIPAL_FORBIDDEN");
  expect((await call(other, "open_dispute", { holdId, reason: "x", evidence: [] })).code).toBe("PRINCIPAL_FORBIDDEN");
  expect((await call(other, "get_mandate", { mandateId })).code).toBe("PRINCIPAL_FORBIDDEN");
  expect((await call(other, "list_mandates")).mandates.map((v: any) => v.mandate.id)).toEqual([otherMandateId]);
  expect((await call(other, "list_audit_log")).entries.every((e: any) => e.mandateId === otherMandateId)).toBe(true);
  expect(sends).toBe(afterHold);
});

test("no MCP tool resolves disputes or returns human approval authority", async () => {
  const buyer = await client(BUYER_TOKEN);
  const merchant = await client(MERCHANT_TOKEN);
  for (const c of [buyer, merchant]) {
    const r = await call(c, "resolve_dispute", { disputeId: "d-1", outcome: "refund", refundAmount: "1", approvalToken: "x" });
    expect(r.code).toBe("PRINCIPAL_FORBIDDEN");
  }
  const { tools } = await buyer.listTools();
  const text = JSON.stringify(tools);
  expect(text).not.toContain(ROUTE_SECRET);
  expect(tools.map((t) => t.name)).not.toContain("approve");
});

test("refused agent writes are audited with the real principal, and nothing is sent", async () => {
  const mandateId = (await (await humanMandate(BUYER)).json()).mandate.id;
  const buyer = await client(BUYER_TOKEN);
  const holdId = (await call(buyer, "hold", { mandateId, payee: MERCHANT, amount: "1000000" })).hold.id;
  const before = sends;
  expect((await call(buyer, "capture", { actor: MERCHANT, holdId, amount: "1000000" })).code).toBe("PRINCIPAL_FORBIDDEN");
  expect(sends).toBe(before);
  const merchantView = (await call(await client(MERCHANT_TOKEN), "list_audit_log", { mandateId })).entries;
  expect(merchantView.at(-1)).toMatchObject({ action: "capture", outcome: "blocked", code: "PRINCIPAL_FORBIDDEN", actor: BUYER, holdId, mandateId });
});

test("live backend without agent tokens refuses MCP unless the explicit trusted-operator mode is set", async () => {
  const service = new PaymentService({ backend: new MockBackend() });
  const s = createServer(createHttpHandler({ service, backendName: "devnet" }));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(res.status).toBe(401);
  await new Promise<void>((r) => s.close(() => r()));
});
