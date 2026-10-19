// MVP-02 (#10), MVP-04 (#12), MVP-05 (#13) over the ACTUAL streamable-HTTP MCP transport, with the
// live policy on (PaymentService({ live: true }), as createServiceRuntime sets it for capture402).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { issueApprovalToken } from "../src/approval.js";
import { MockBackend } from "../src/backend/mock.js";
import { createHttpHandler } from "../src/http.js";
import type { AgentCredential } from "../src/principal.js";
import { PaymentService } from "../src/service.js";
import { MemoryStateStore, type StateStore } from "../src/store.js";
import { FaultyBackend, makeGate } from "./helpers/faulty-backend.js";

const BUYER = "buyer-agent";
const MERCHANT = "seller-agent";
const OTHER_BUYER = "other-buyer";
const ROUTE_SECRET = "test-human-route-secret-0002";
const APPROVAL_SECRET = "test-approval-secret-00000002";
const credentials: AgentCredential[] = [
  { role: "buyer", id: BUYER, token: "test-buyer-token-0000000002" },
  { role: "merchant", id: MERCHANT, token: "test-merchant-token-00000002" },
  { role: "buyer", id: OTHER_BUYER, token: "test-other-buyer-token-00002" },
];
const [BUYER_TOKEN, MERCHANT_TOKEN, OTHER_TOKEN] = credentials.map((c) => c.token);

let clock: number;
let backend: FaultyBackend;
let service: PaymentService;
let server: Server;
let base: string;

const now = () => clock;
const sends = () => backend.holdCalls + backend.captureCalls + backend.releaseCalls + backend.refundCalls;

test("agreed one-report scenario uses one hold and one atomic capture/remainder release over authenticated MCP", async () => {
  const response = await fetch(`${base}/human/mandate`, { method: "POST",
    headers: { "content-type": "application/json", "x-singit-human-secret": ROUTE_SECRET },
    body: JSON.stringify({ payer: BUYER, totalBudget: "1000000", perTxCap: "1000000", expiresAt: clock + 900, allowedCounterparties: [MERCHANT] }) });
  const mandateId = (await response.json()).mandate.id;
  const held = await call(BUYER_TOKEN, "hold", { mandateId, payee: MERCHANT, amount: "1000000",
    captureDeadline: clock + 600, refundDeadline: clock + 4200, idempotencyKey: "report:synthetic-intent:hold" });
  expect(held.ok).toBe(true);
  const args = { holdId: held.hold.id, amount: "650000", releaseRemainder: true, idempotencyKey: "report:synthetic-intent:capture" };
  const captured = await call(MERCHANT_TOKEN, "capture", args);
  expect(captured).toMatchObject({ ok: true, hold: { held: "0", captured: "650000", refunded: "0" } });
  const state = await call(BUYER_TOKEN, "get_mandate", { mandateId });
  expect(state).toMatchObject({ remaining: "350000", reserved: "0" });
  expect(state.mandate.committed).toBe("650000");
  expect(await call(MERCHANT_TOKEN, "capture", args)).toMatchObject({ ok: true, replay: true, operationId: captured.operationId, txSig: captured.txSig });
  expect([backend.holdCalls, backend.captureCalls, backend.releaseCalls, backend.refundCalls]).toEqual([1, 1, 0, 0]);
  expect(service.listOperations()).toHaveLength(2);
});

beforeEach(async () => {
  clock = 1_800_000_000;
  backend = new FaultyBackend(new MockBackend({ now, balances: { [BUYER]: 100_000_000n, [MERCHANT]: 20_000_000n, [OTHER_BUYER]: 100_000_000n } }));
  service = new PaymentService({ backend, now, live: true, approvalSecret: APPROVAL_SECRET });
  server = createServer(createHttpHandler({ service, backendName: "devnet", routeSecret: ROUTE_SECRET, approvalSecret: APPROVAL_SECRET, credentials }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

/** Each call opens an independent client connection, as a retrying agent after a lost response would. */
async function client(token: string): Promise<Client> {
  const c = new Client({ name: "safety-test", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}
async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = (await (await client(token)).callTool({ name, arguments: args })) as CallToolResult;
  return r.structuredContent;
}
function mandate(payer = BUYER, totalBudget = 5_000_000n) {
  return service.createMandate({ actor: payer, payer, totalBudget, perTxCap: 2_000_000n, expiresAt: clock + 3600, allowedCounterparties: [MERCHANT] });
}
async function holdOf(amount: string, key: string, extra: Record<string, unknown> = {}) {
  const m = await mandate();
  const r = await call(BUYER_TOKEN, "hold", { mandateId: m.id, payee: MERCHANT, amount, idempotencyKey: key, ...extra });
  expect(r.ok).toBe(true);
  return { mandateId: m.id, holdId: r.hold.id as string };
}

test("live economic writes without an idempotencyKey are refused before any send", async () => {
  const m = await mandate();
  expect(await call(BUYER_TOKEN, "hold", { mandateId: m.id, payee: MERCHANT, amount: "1000000" })).toMatchObject({ ok: false, code: "IDEMPOTENCY_KEY_REQUIRED" });
  expect(sends()).toBe(0);
});

test("a hold retried on an independent connection after a lost response is one operation and one send", async () => {
  const m = await mandate();
  const args = { mandateId: m.id, payee: MERCHANT, amount: "1000000", idempotencyKey: "intent-a" };
  const first = await call(BUYER_TOKEN, "hold", args);
  const retry = await call(BUYER_TOKEN, "hold", args);
  expect(first).toMatchObject({ ok: true, replay: false });
  expect(retry).toMatchObject({ ok: true, replay: true, operationId: first.operationId, remaining: "4000000" });
  expect(retry.hold.id).toBe(first.hold.id);
  expect(backend.holdCalls).toBe(1);
});

test("full capture, release and refund replay their original outcome instead of failing on the state they produced", async () => {
  const { holdId } = await holdOf("1000000", "h-1");
  const capture = await call(MERCHANT_TOKEN, "capture", { holdId, amount: "600000", idempotencyKey: "c-1" });
  const release = await call(MERCHANT_TOKEN, "release", { holdId, idempotencyKey: "r-1" });
  const refund = await call(MERCHANT_TOKEN, "refund", { holdId, amount: "600000", idempotencyKey: "f-1" });
  expect([capture.ok, release.ok, refund.ok]).toEqual([true, true, true]);
  const before = sends();

  // The hold is now empty and fully refunded: fresh calls would be CAPTURE_EXCEEDS_HOLD / NOTHING_HELD / REFUND_EXCEEDS_CAPTURED.
  const c = await call(MERCHANT_TOKEN, "capture", { holdId, amount: "600000", idempotencyKey: "c-1" });
  expect(c).toMatchObject({ ok: true, replay: true, operationId: capture.operationId, txSig: capture.txSig });
  expect(c.hold).toMatchObject({ held: "400000", captured: "600000", refunded: "0" }); // as the capture left it
  expect(await call(MERCHANT_TOKEN, "release", { holdId, idempotencyKey: "r-1" })).toMatchObject({ ok: true, replay: true, operationId: release.operationId });
  const f = await call(MERCHANT_TOKEN, "refund", { holdId, amount: "600000", idempotencyKey: "f-1" });
  expect(f).toMatchObject({ ok: true, replay: true, operationId: refund.operationId, hold: { refunded: "600000" } });
  expect(sends()).toBe(before);

  // Same key, changed parameters: a conflict, never a silent replay.
  expect(await call(MERCHANT_TOKEN, "capture", { holdId, amount: "500000", idempotencyKey: "c-1" })).toMatchObject({ ok: false, code: "IDEMPOTENCY_KEY_REUSED" });
  expect(sends()).toBe(before);
});

test("two different intents with identical parameters both execute: no false deduplication", async () => {
  const { holdId } = await holdOf("1000000", "h-2");
  const a = await call(MERCHANT_TOKEN, "capture", { holdId, amount: "300000", idempotencyKey: "job-1" });
  const b = await call(MERCHANT_TOKEN, "capture", { holdId, amount: "300000", idempotencyKey: "job-2" });
  expect([a.replay, b.replay]).toEqual([false, false]);
  expect(a.operationId).not.toBe(b.operationId);
  expect(b.hold.captured).toBe("600000");
  expect(backend.captureCalls).toBe(2);
});

test("a repeat after the capture deadline returns the prior result; a new late capture is refused", async () => {
  const { holdId } = await holdOf("1000000", "h-3", { captureDeadline: clock + 100 });
  const original = await call(MERCHANT_TOKEN, "capture", { holdId, amount: "200000", idempotencyKey: "late-1" });
  clock += 200;
  expect(await call(MERCHANT_TOKEN, "capture", { holdId, amount: "200000", idempotencyKey: "late-1" })).toMatchObject({ ok: true, replay: true, operationId: original.operationId });
  expect(await call(MERCHANT_TOKEN, "capture", { holdId, amount: "200000", idempotencyKey: "late-2" })).toMatchObject({ ok: false, code: "CAPTURE_DEADLINE_PASSED" });
  expect(backend.captureCalls).toBe(1);
});

test("concurrent identical requests: one send; the second observes the in-flight operationId", async () => {
  const { holdId } = await holdOf("1000000", "h-4");
  const gate = makeGate();
  backend.setGate("capture", gate.promise);
  const args = { holdId, amount: "500000", idempotencyKey: "same-intent" };
  const first = call(MERCHANT_TOKEN, "capture", args);
  while (backend.captureCalls === 0) await new Promise((r) => setTimeout(r, 5));
  const second = await call(MERCHANT_TOKEN, "capture", args);
  expect(second).toMatchObject({ ok: false, code: "OPERATION_PENDING" });
  gate.release();
  backend.clearGate("capture");
  const done = await first;
  expect(second.operationId).toBe(done.operationId);
  expect(await call(MERCHANT_TOKEN, "capture", args)).toMatchObject({ ok: true, replay: true, operationId: done.operationId });
  expect(backend.captureCalls).toBe(1);
});

test("UNKNOWN keeps its operationId, closes live admission, and its status is redacted and principal-scoped", async () => {
  const m = await mandate();
  backend.queueHoldFault("ambiguous-after");
  const unknown = await call(BUYER_TOKEN, "hold", { mandateId: m.id, payee: MERCHANT, amount: "1000000", idempotencyKey: "u-1" });
  expect(unknown).toMatchObject({ ok: false, code: "OPERATION_UNKNOWN" });
  expect(unknown.operationId).toMatch(/^op-/);

  const status = await call(BUYER_TOKEN, "get_operation", { operationId: unknown.operationId });
  expect(status).toMatchObject({ ok: true, operation: { id: unknown.operationId, state: "unknown", reservation: "1000000" } });
  expect(JSON.stringify(status)).not.toMatch(/evidence|signedTransaction|salt|paramsHash/);
  expect(await call(OTHER_TOKEN, "get_operation", { operationId: unknown.operationId })).toMatchObject({ ok: false, code: "PRINCIPAL_FORBIDDEN" });

  // Admission is closed for NEW economic writes...
  expect(await call(BUYER_TOKEN, "hold", { mandateId: m.id, payee: MERCHANT, amount: "1000000", idempotencyKey: "u-2" })).toMatchObject({ ok: false, code: "ADMISSION_CLOSED" });
  expect(backend.holdCalls).toBe(1);
  // ...and readiness says so, while liveness stays green.
  expect((await fetch(`${base}/health`)).status).toBe(200);
  expect((await fetch(`${base}/ready`)).status).toBe(401);
  const ready = await fetch(`${base}/ready`, { headers: { "x-singit-human-secret": ROUTE_SECRET } });
  expect(ready.status).toBe(503);
  expect(await ready.json()).toMatchObject({ ready: false, admission: { open: false, code: "ADMISSION_CLOSED", unresolvedOps: 1 } });

  // Retrying the ORIGINAL key observes the original transaction; nothing is resent.
  expect(await call(BUYER_TOKEN, "hold", { mandateId: m.id, payee: MERCHANT, amount: "1000000", idempotencyKey: "u-1" })).toMatchObject({ ok: true, replay: true, operationId: unknown.operationId });
  expect(backend.holdCalls).toBe(1);
});

test("a durable-write failure closes economic admission before anything is sent", async () => {
  let broken = false;
  const inner = new MemoryStateStore();
  const failing: StateStore = {
    load: () => inner.load(),
    putMandate: (m) => (broken ? fail() : inner.putMandate(m)),
    putHold: (h) => (broken ? fail() : inner.putHold(h)),
    putDispute: (d) => (broken ? fail() : inner.putDispute(d)),
    putOp: (op) => (broken ? fail() : inner.putOp(op)),
    putOpCommit: (c) => (broken ? fail() : inner.putOpCommit(c)),
    putStateCommit: (c) => (broken ? fail() : inner.putStateCommit(c)),
    appendAudit: (e) => (broken ? fail() : inner.appendAudit(e)),
  };
  function fail(): never {
    throw new Error("ENOSPC: no space left on device");
  }
  const svc = new PaymentService({ backend, now, live: true, store: failing });
  const m = await svc.createMandate({ actor: BUYER, payer: BUYER, totalBudget: 5_000_000n, perTxCap: 2_000_000n, expiresAt: clock + 3600, allowedCounterparties: [MERCHANT] });
  broken = true;
  await expect(svc.hold({ actor: BUYER, mandateId: m.id, payee: MERCHANT, amount: 1_000_000n, idempotencyKey: "s-1" })).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
  broken = false;
  await expect(svc.hold({ actor: BUYER, mandateId: m.id, payee: MERCHANT, amount: 1_000_000n, idempotencyKey: "s-2" })).rejects.toMatchObject({ code: "ADMISSION_CLOSED" });
  expect(backend.holdCalls).toBe(0);
  expect(svc.admissionStatus()).toMatchObject({ open: false, code: "STORAGE_FAILURE" });
});

test("live mode refuses a two-step dispute refund server-side; the single-step resolution still works", async () => {
  const { holdId } = await holdOf("1000000", "h-5");
  await call(MERCHANT_TOKEN, "capture", { holdId, amount: "400000", idempotencyKey: "c-5" });
  const dispute = (await call(BUYER_TOKEN, "open_dispute", { holdId, reason: "empty result", evidence: ["job: 0 rows"] })).dispute;
  const decision = { disputeId: dispute.id, outcome: "refund" as const, refundAmount: 400_000n };
  const approvalToken = issueApprovalToken(APPROVAL_SECRET, decision);
  const before = sends();
  await expect(service.resolveDispute({ actor: "human", ...decision, approvalToken, idempotencyKey: "d-5" })).rejects.toMatchObject({ code: "ACTION_DISABLED" });
  expect(sends()).toBe(before);

  await call(MERCHANT_TOKEN, "release", { holdId, idempotencyKey: "r-5" });
  const resolved = await service.resolveDispute({ actor: "human", ...decision, approvalToken, idempotencyKey: "d-5b" });
  expect(resolved).toMatchObject({ status: "resolved", outcome: "refund" });
  expect(service.getHold(holdId).refunded).toBe(400_000n);
});
