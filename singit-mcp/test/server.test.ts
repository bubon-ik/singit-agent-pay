import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expect, test } from "vitest";
import { issueApprovalToken } from "../src/approval.js";
import { MockBackend } from "../src/backend/mock.js";
import { createMcpServer } from "../src/server.js";
import { PaymentService } from "../src/service.js";

const SECRET = "test-secret-0123456789";
const TOOL_NAMES = [
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
  "get_operation",
  "list_audit_log",
];

async function connectedClient() {
  let t = 1_800_000_000;
  const now = () => t;
  const backend = new MockBackend({ now, balances: { payer: 1_000_000_000n, payee: 1_000_000_000n } });
  const service = new PaymentService({ backend, now, approvalSecret: SECRET });
  const mcpServer = createMcpServer(service);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);
  return { client, now };
}

function body(result: CallToolResult): any {
  const text = result.content?.[0];
  if (!text || text.type !== "text") throw new Error("expected text content");
  return JSON.parse(text.text);
}

test("lists exactly the 12 tools, none exposing approve/token/secret", async () => {
  const { client } = await connectedClient();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);

  expect(names.sort()).toEqual([...TOOL_NAMES].sort());
  for (const name of names) {
    expect(name).not.toMatch(/approve|token|secret/i);
  }
});

test("full flow via callTool, including an OVER_BUDGET refusal", async () => {
  const { client, now } = await connectedClient();

  const created = body(
    (await client.callTool({
      name: "create_mandate",
      arguments: {
        actor: "payer",
        payer: "payer",
        totalBudget: "1000000",
        perTxCap: "700000",
        expiresAt: now() + 1000,
        allowedCounterparties: ["payee"],
      },
    })) as CallToolResult,
  );
  expect(created.ok).toBe(true);
  const mandateId = created.mandate.id;

  const held = (await client.callTool({
    name: "hold",
    arguments: { actor: "payer", mandateId, payee: "payee", amount: "600000" },
  })) as CallToolResult;
  expect(held.isError).toBeFalsy();
  const heldBody = body(held);
  expect(heldBody.ok).toBe(true);
  expect(typeof heldBody.txSig).toBe("string");
  const holdId = heldBody.hold.id;

  const overBudget = (await client.callTool({
    name: "hold",
    arguments: { actor: "payer", mandateId, payee: "payee", amount: "500000" },
  })) as CallToolResult;
  expect(overBudget.isError).toBe(true);
  const overBudgetBody = body(overBudget);
  expect(overBudgetBody.ok).toBe(false);
  expect(overBudgetBody.code).toBe("OVER_BUDGET");

  const captured = body((await client.callTool({ name: "capture", arguments: { actor: "payee", holdId, amount: "300000" } })) as CallToolResult);
  expect(captured.ok).toBe(true);

  const refunded = body((await client.callTool({ name: "refund", arguments: { actor: "payee", holdId, amount: "100000" } })) as CallToolResult);
  expect(refunded.ok).toBe(true);

  const log = body((await client.callTool({ name: "list_audit_log", arguments: { mandateId } })) as CallToolResult);
  expect(log.ok).toBe(true);
  expect(log.entries.length).toBeGreaterThan(0);
});

test("resolve_dispute with a self-made token fails", async () => {
  const { client, now } = await connectedClient();

  const created = body(
    (await client.callTool({
      name: "create_mandate",
      arguments: {
        actor: "payer",
        payer: "payer",
        totalBudget: "1000000",
        perTxCap: "1000000",
        expiresAt: now() + 1000,
        allowedCounterparties: ["payee"],
      },
    })) as CallToolResult,
  );
  const mandateId = created.mandate.id;

  const held = body(
    (await client.callTool({ name: "hold", arguments: { actor: "payer", mandateId, payee: "payee", amount: "500000" } })) as CallToolResult,
  );
  const holdId = held.hold.id;

  await client.callTool({ name: "capture", arguments: { actor: "payee", holdId, amount: "400000" } });

  const disputed = body(
    (await client.callTool({ name: "open_dispute", arguments: { actor: "payer", holdId, reason: "bad", evidence: [] } })) as CallToolResult,
  );
  const disputeId = disputed.dispute.id;

  const forgedToken = issueApprovalToken("not-the-real-secret-at-all", {
    disputeId,
    outcome: "refund",
    refundAmount: 400_000n,
  });
  const resolved = (await client.callTool({
    name: "resolve_dispute",
    arguments: { actor: "payer", disputeId, outcome: "refund", refundAmount: "400000", approvalToken: forgedToken },
  })) as CallToolResult;

  expect(resolved.isError).toBe(true);
  expect(body(resolved).code).toBe("HUMAN_APPROVAL_REQUIRED");
});
