import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expect, test } from "vitest";
import { issueApprovalToken } from "../src/approval.js";
import { buildBackendFromEnv } from "../src/backend/factory.js";
import { MockBackend } from "../src/backend/mock.js";
import type { PaymentBackend } from "../src/backend/types.js";
import { createHttpHandler } from "../src/http.js";
import { PaymentService } from "../src/service.js";

const APPROVAL_SECRET = "approval-secret-e2e-0123456789";
const ROUTE_SECRET = "route-secret-e2e-0123456789abcd";
const BUYER = "buyer-e2e";
const SELLER = "seller-e2e";

interface StoryOptions {
  backend: PaymentBackend;
  backendName: "mock" | "devnet";
  base: string;
  amountScale: bigint;
}

function body(result: CallToolResult): any {
  const item = result.content?.[0];
  if (!item || item.type !== "text") throw new Error("expected text content");
  return JSON.parse(item.text);
}

async function withMcp<T>(base: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "singit-e2e-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ result: CallToolResult; parsed: any }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { result, parsed: body(result) };
}

async function runStory({ backend, backendName, base, amountScale }: StoryOptions): Promise<void> {
  const budget = 10n * amountScale;
  const perTxCap = 5n * amountScale;
  const initialHold = 4n * amountScale;
  const capturedAmount = amountScale === 1n ? 2n : 2_500_000n;
  const releasedAmount = initialHold - capturedAmount;

  const listed = await withMcp(base, async (client) => client.listTools());
  const toolNames = listed.tools.map((tool) => tool.name);
  for (const name of [
    "create_mandate", "hold", "capture", "release", "refund",
    "open_dispute", "resolve_dispute", "list_audit_log",
  ]) expect(toolNames).toContain(name);
  expect(toolNames.some((name) => /approve|token|secret/i.test(name))).toBe(false);

  const created = await withMcp(base, (client) => call(client, "create_mandate", {
    actor: BUYER, payer: BUYER, totalBudget: budget.toString(), perTxCap: perTxCap.toString(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600, allowedCounterparties: [SELLER],
  }));
  expect(created.parsed.ok).toBe(true);
  const mandateId = created.parsed.mandate.id as string;

  const held = await withMcp(base, (client) => call(client, "hold", {
    actor: BUYER, mandateId, payee: SELLER, amount: initialHold.toString(),
  }));
  expect(held.result.isError).toBeFalsy();
  expect(held.parsed.ok).toBe(true);
  expect(typeof held.parsed.txSig).toBe("string");
  expect(held.parsed.txSig.length).toBeGreaterThan(0);
  expect(held.parsed.hold.held).toBe(initialHold.toString());
  expect(held.parsed.hold.held).toBe((4n * amountScale).toString());
  expect(held.parsed.remaining).toBe((budget - initialHold).toString());
  const holdId = held.parsed.hold.id as string;

  const captured = await withMcp(base, (client) => call(client, "capture", {
    actor: SELLER, holdId, amount: capturedAmount.toString(),
  }));
  expect(captured.parsed.ok).toBe(true);
  expect(captured.parsed.hold.captured).toBe(capturedAmount.toString());
  expect(captured.parsed.hold.held).toBe(releasedAmount.toString());
  expect(typeof captured.parsed.txSig).toBe("string");
  expect(captured.parsed.txSig.length).toBeGreaterThan(0);
  expect(captured.parsed.txSig).not.toBe(held.parsed.txSig);

  const released = await withMcp(base, (client) => call(client, "release", { actor: SELLER, holdId }));
  expect(released.parsed.ok).toBe(true);
  expect(released.parsed.hold.held).toBe("0");
  expect(typeof released.parsed.txSig).toBe("string");
  expect(released.parsed.txSig.length).toBeGreaterThan(0);
  // Release removes the remaining held amount from committed, returning it to mandate budget.
  const afterRelease = await withMcp(base, (client) => call(client, "get_mandate", { mandateId }));
  expect(afterRelease.parsed.remaining).toBe((budget - capturedAmount).toString());

  const opened = await withMcp(base, (client) => call(client, "open_dispute", {
    actor: BUYER, holdId, reason: "E2E refund request", evidence: [],
  }));
  expect(opened.parsed.ok).toBe(true);
  expect(opened.parsed.dispute.status).toBe("open");
  const disputeId = opened.parsed.dispute.id as string;

  // approvalToken is required by the tool schema; a forged token must still be refused.
  const forged = issueApprovalToken("not-the-real-approval-secret", {
    disputeId, outcome: "refund", refundAmount: capturedAmount,
  });
  const attempted = await withMcp(base, (client) => call(client, "resolve_dispute", {
    actor: BUYER, disputeId, outcome: "refund", refundAmount: capturedAmount.toString(), approvalToken: forged,
  }));
  expect(attempted.result.isError).toBe(true);
  expect(attempted.parsed.code).toBe("HUMAN_APPROVAL_REQUIRED");
  expect((await withMcp(base, (client) => call(client, "list_disputes", { status: "open" }))).parsed.disputes)
    .toContainEqual(expect.objectContaining({ id: disputeId, status: "open" }));

  const human = await fetch(`${base}/human/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-singit-human-secret": ROUTE_SECRET },
    body: JSON.stringify({ disputeId, outcome: "refund", refundAmount: capturedAmount.toString(), actor: "human:e2e" }),
  });
  expect(human.status).toBe(200);
  const humanBody = await human.json() as any;
  expect(humanBody.dispute.status).toBe("resolved");
  expect(typeof humanBody.txSig).toBe("string");
  expect(humanBody.txSig.length).toBeGreaterThan(0);

  const finalHold = await withMcp(base, (client) => call(client, "get_mandate", { mandateId }));
  const hold = finalHold.parsed.holds.find((item: any) => item.id === holdId);
  expect(hold.refunded).toBe(capturedAmount.toString());
  // Refunds debit the seller and do not re-open the mandate budget.
  expect(finalHold.parsed.remaining).toBe((budget - capturedAmount).toString());
  const audit = await withMcp(base, (client) => call(client, "list_audit_log", { mandateId }));
  expect(audit.parsed.entries).toContainEqual(expect.objectContaining({
    actor: "human-approved:human:e2e", action: "resolve_dispute", outcome: "ok",
  }));

  const stateResponse = await fetch(`${base}/api/state`);
  expect(stateResponse.status).toBe(200);
  const state = await stateResponse.json() as any;
  expect(state.ops.length).toBeGreaterThan(0);
  expect(state.ops.every((op: any) => op.state === "succeeded")).toBe(true);
  expect(state.ops.every((op: any) => op.reservation === "0")).toBe(true);
  expect(state.mandates.find((item: any) => item.mandate.id === mandateId).reserved).toBe("0");

  // Second independent hold/dispute exercises the out-of-band approval-token form.
  const tokenHoldAmount = amountScale === 1n ? 1n : 1_000_000n;
  const secondHold = await withMcp(base, (client) => call(client, "hold", {
    actor: BUYER, mandateId, payee: SELLER, amount: tokenHoldAmount.toString(),
  }));
  expect(secondHold.parsed.ok).toBe(true);
  const secondHoldId = secondHold.parsed.hold.id as string;
  const secondCapture = await withMcp(base, (client) => call(client, "capture", {
    actor: SELLER, holdId: secondHoldId, amount: tokenHoldAmount.toString(),
  }));
  expect(secondCapture.parsed.ok).toBe(true);
  const secondOpen = await withMcp(base, (client) => call(client, "open_dispute", {
    actor: BUYER, holdId: secondHoldId, reason: "Token approval E2E", evidence: [],
  }));
  const secondDisputeId = secondOpen.parsed.dispute.id as string;
  const token = issueApprovalToken(APPROVAL_SECRET, {
    disputeId: secondDisputeId, outcome: "refund", refundAmount: tokenHoldAmount,
  });
  const tokenResponse = await fetch(`${base}/human/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-singit-human-secret": ROUTE_SECRET },
    body: JSON.stringify({
      disputeId: secondDisputeId, outcome: "refund", refundAmount: tokenHoldAmount.toString(),
      actor: "human:e2e-token", approvalToken: token,
    }),
  });
  expect(tokenResponse.status).toBe(200);
  const tokenBody = await tokenResponse.json() as any;
  expect(tokenBody.dispute.status).toBe("resolved");
  expect(typeof tokenBody.txSig).toBe("string");
  expect(tokenBody.txSig.length).toBeGreaterThan(0);
  const stateAfterTokenResolution = await (await fetch(`${base}/api/state`)).json() as any;
  expect(stateAfterTokenResolution.ops.every((op: any) => op.state === "succeeded")).toBe(true);
  expect(stateAfterTokenResolution.ops.every((op: any) => op.reservation === "0")).toBe(true);
  expect(stateAfterTokenResolution.mandates.find((item: any) => item.mandate.id === mandateId).reserved).toBe("0");

  const wrongPayee = await withMcp(base, (client) => call(client, "capture", {
    actor: "intruder-e2e", holdId: secondHoldId, amount: "1",
  }));
  expect(wrongPayee.result.isError).toBe(true);
  expect(wrongPayee.parsed.code).toBe("NOT_PAYEE");

  const excessiveAmount = budget + 1n;
  const overCap = await withMcp(base, (client) => call(client, "hold", {
    actor: BUYER, mandateId, payee: SELLER, amount: excessiveAmount.toString(),
  }));
  expect(overCap.result.isError).toBe(true);
  expect(["OVER_BUDGET", "OVER_PER_TX_CAP"]).toContain(overCap.parsed.code);

  // The service is shared by the HTTP handler. This sanity check also documents the mock/live
  // backend identifier configured for GET /api/state.
  expect(state.backend).toBe(backendName);
}

async function startServer(backend: PaymentBackend, backendName: "mock" | "devnet") {
  const service = new PaymentService({ backend, approvalSecret: APPROVAL_SECRET });
  const handler = createHttpHandler({
    service, backendName, approvalSecret: APPROVAL_SECRET, routeSecret: ROUTE_SECRET,
    mcpPerMin: 1000, statePerMin: 1000,
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

test("MCP E2E over streamable HTTP with MockBackend", async () => {
  const backend = new MockBackend({
    balances: { [BUYER]: 100_000_000_000n, [SELLER]: 100_000_000_000n },
  });
  const { server, base } = await startServer(backend, "mock");
  try {
    await runStory({ backend, backendName: "mock", base, amountScale: 1_000_000n });
  } finally {
    await closeServer(server);
  }
});

const DEVNET_REQUIRED_ENV = [
  "SINGIT_RPC_URL", "SINGIT_PROGRAM_ID", "SINGIT_PROGRAM_DATA",
  "SINGIT_EXECUTABLE_SHA256", "SINGIT_DEPLOYMENT_SLOT", "SINGIT_PAYER_KEYPAIR",
  "SINGIT_MERCHANT_KEYPAIR", "SINGIT_PAYER_ADDRESS", "SINGIT_MERCHANT_ADDRESS",
  "SINGIT_EVIDENCE_DIR",
];
const devnetEnabled = process.env.SINGIT_E2E_DEVNET === "1" && DEVNET_REQUIRED_ENV.every((key) => !!process.env[key]);

test.skipIf(!devnetEnabled)("MCP E2E over streamable HTTP with Capture402Backend (devnet)", async () => {
  // The caller explicitly enabled this test and supplied all required env. Backend creation
  // happens only inside the enabled body; buildBackendFromEnv does not open key files.
  const backend = buildBackendFromEnv({ ...process.env, SINGIT_BACKEND: "capture402" });
  const { server, base } = await startServer(backend, "devnet");
  try {
    await runStory({ backend, backendName: "devnet", base, amountScale: 1n });
  } finally {
    await closeServer(server);
  }
}, 30_000);
