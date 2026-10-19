import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { MockBackend } from "../src/backend/mock.js";
import { Capture402Backend } from "../src/backend/capture402.js";
import { createServiceRuntime } from "../src/runtime.js";
import { FileStateStore } from "../src/store.js";
import { FaultyBackend } from "./helpers/faulty-backend.js";

const dirs: string[] = [];
const runtimes: Array<{ close: () => void }> = [];
const now = () => 1_800_000_000;
const payer = "payer", payee = "merchant";
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "singit-runtime-"));
  dirs.push(dir);
  return dir;
}
function backend() {
  return new FaultyBackend(new MockBackend({ now, balances: { [payer]: 10_000_000n, [payee]: 10_000_000n } }));
}
async function start(dir: string, paymentBackend = backend()) {
  const runtime = await createServiceRuntime({ SINGIT_BACKEND: "capture402", SINGIT_STATE_DIR: dir }, { backend: paymentBackend, now });
  runtimes.push(runtime);
  return runtime;
}
async function mandate(runtime: Awaited<ReturnType<typeof start>>) {
  return runtime.service.createMandate({ actor: payer, payer, totalBudget: 2_000_000n, perTxCap: 1_000_000n, expiresAt: now() + 1000, allowedCounterparties: [payee] });
}
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("live startup requires an absolute private directory outside Git", async () => {
  for (const path of [undefined, "relative/state", "/"]) {
    await expect(createServiceRuntime({ SINGIT_BACKEND: "capture402", SINGIT_STATE_DIR: path }, { backend: backend() })).rejects.toMatchObject({ code: "PRIVATE_STATE_REQUIRED" });
  }
  const checkout = directory();
  mkdirSync(join(checkout, ".git"));
  await expect(start(join(checkout, "state"))).rejects.toMatchObject({ code: "PRIVATE_STATE_REQUIRED" });
  expect(existsSync(join(checkout, "state"))).toBe(false);
});

test("private state is locked for the runtime lifetime and restores mandates after close", async () => {
  const dir = directory(), paymentBackend = backend();
  const first = await start(dir, paymentBackend);
  const created = await mandate(first);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, "state.jsonl")).mode & 0o777).toBe(0o600);
  await expect(start(dir, paymentBackend)).rejects.toMatchObject({ code: "STATE_STORE_LOCKED" });
  first.close();
  const second = await start(dir, paymentBackend);
  expect(second.service.getMandate(created.id).remaining).toBe(2_000_000n);
});

test("rejects symlink state directories and journal files before writing private evidence", async () => {
  const parent = directory(), actual = directory();
  const alias = join(parent, "alias");
  symlinkSync(actual, alias);
  await expect(start(alias)).rejects.toMatchObject({ code: "PRIVATE_STATE_REQUIRED" });
  const target = join(actual, "external.jsonl");
  writeFileSync(target, "untouched");
  symlinkSync(target, join(parent, "state.jsonl"));
  await expect(start(parent)).rejects.toMatchObject({ code: "PRIVATE_STATE_REQUIRED" });
  expect(readFileSync(target, "utf8")).toBe("untouched");
});

test("configuration failures release the startup lock", async () => {
  const dir = directory();
  await expect(createServiceRuntime({ SINGIT_BACKEND: "capture402", SINGIT_STATE_DIR: dir })).rejects.toThrow();
  expect(existsSync(join(dir, ".singit-mcp.lock"))).toBe(false);
  await start(dir);
});

test("a failed devnet account/network preflight prevents readiness and releases the state lock", async () => {
  const dir = directory();
  const capture = Object.create(Capture402Backend.prototype) as Capture402Backend;
  vi.spyOn(capture, "preflight").mockRejectedValue(new Error("wrong network"));
  await expect(createServiceRuntime({ SINGIT_BACKEND: "capture402", SINGIT_STATE_DIR: dir, SINGIT_PAYER_ADDRESS: "payer", SINGIT_MERCHANT_ADDRESS: "merchant" }, { backend: capture })).rejects.toThrow("wrong network");
  expect(existsSync(join(dir, ".singit-mcp.lock"))).toBe(false);
});

test("a dangling journal symlink cannot create evidence outside the private store", async () => {
  const dir = directory(), target = join(directory(), "not-created.jsonl");
  symlinkSync(target, join(dir, "state.jsonl"));
  await expect(start(dir)).rejects.toMatchObject({ code: "PRIVATE_STATE_REQUIRED" });
  expect(existsSync(target)).toBe(false);
});

test("restored finalized holds converge before startup returns, with no second send", async () => {
  const dir = directory(), paymentBackend = backend();
  const first = await start(dir, paymentBackend), m = await mandate(first);
  paymentBackend.queueHoldFault("ambiguous-after");
  await expect(first.service.hold({ actor: payer, mandateId: m.id, payee, amount: 400_000n })).rejects.toMatchObject({ code: "OPERATION_UNKNOWN" });
  first.close();
  const second = await start(dir, paymentBackend);
  expect(paymentBackend.holdCalls).toBe(1);
  expect(paymentBackend.releaseCalls).toBe(0);
  expect(second.service.listOperations()[0].state).toBe("succeeded");
  expect(second.service.getMandate(m.id).remaining).toBe(1_600_000n);
});

test("unresolved original outcomes stop startup and preserve reservations without a resend", async () => {
  const dir = directory(), paymentBackend = backend();
  const first = await start(dir, paymentBackend), m = await mandate(first);
  paymentBackend.queueHoldFault("ambiguous-after");
  await expect(first.service.hold({ actor: payer, mandateId: m.id, payee, amount: 400_000n })).rejects.toMatchObject({ code: "OPERATION_UNKNOWN" });
  first.close();
  vi.spyOn(paymentBackend, "getTxOutcome").mockResolvedValue({ status: "pending" });
  await expect(start(dir, paymentBackend)).rejects.toMatchObject({ code: "STARTUP_RECONCILIATION_REQUIRED" });
  expect(paymentBackend.holdCalls).toBe(1);
  const snapshot = new FileStateStore(dir).load();
  expect(snapshot.ops[0]).toMatchObject({ state: "unknown", reservation: "400000" });
  expect(snapshot.mandates[0].committed).toBe("400000");
  expect(existsSync(join(dir, ".singit-mcp.lock"))).toBe(false);
});

test("startup recovery never sends cleanup when a restored hold has mismatched terms", async () => {
  const dir = directory(), paymentBackend = backend();
  const first = await start(dir, paymentBackend), m = await mandate(first);
  paymentBackend.queueStatusFault("throw");
  await expect(first.service.hold({ actor: payer, mandateId: m.id, payee, amount: 400_000n })).rejects.toMatchObject({ code: "OPERATION_UNKNOWN" });
  first.close();
  paymentBackend.queueStatusFault("wrong-mint");
  await expect(start(dir, paymentBackend)).rejects.toMatchObject({ code: "STARTUP_RECONCILIATION_REQUIRED" });
  expect(paymentBackend.releaseCalls).toBe(0);
  expect(new FileStateStore(dir).load().ops).toHaveLength(1);
});

test("startup recovery never retries a previously failed cleanup transaction", async () => {
  const dir = directory(), paymentBackend = backend();
  const first = await start(dir, paymentBackend), m = await mandate(first);
  paymentBackend.queueStatusFault("wrong-mint");
  paymentBackend.queueReleaseFault("ambiguous-before");
  await expect(first.service.hold({ actor: payer, mandateId: m.id, payee, amount: 400_000n })).rejects.toMatchObject({ code: "WRONG_MINT" });
  first.close();
  await expect(start(dir, paymentBackend)).rejects.toMatchObject({ code: "STARTUP_RECONCILIATION_REQUIRED" });
  expect(paymentBackend.releaseCalls).toBe(1);
});

test("mock startup keeps its ephemeral ledger and rejects misleading durable configuration", async () => {
  const runtime = await createServiceRuntime({}, { backend: backend(), now });
  runtimes.push(runtime);
  expect(runtime.backendName).toBe("mock");
  await expect(createServiceRuntime({ SINGIT_STATE_DIR: directory() }, { backend: backend() })).rejects.toMatchObject({ code: "MOCK_STATE_NOT_DURABLE" });
});
