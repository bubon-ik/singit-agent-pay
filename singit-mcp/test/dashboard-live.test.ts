/** Synthetic devnet-declared MCP fixtures only. No RPC, key loading or chain transactions. */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { getAddressDecoder } from "@solana/kit";
import { expect, test } from "vitest";
import { MockBackend } from "../src/backend/mock.js";
import { createHttpHandler } from "../src/http.js";
import { PaymentService } from "../src/service.js";
import { FaultyBackend } from "./helpers/faulty-backend.js";

const payer = getAddressDecoder().decode(new Uint8Array(32).fill(7));
const merchant = getAddressDecoder().decode(new Uint8Array(32).fill(8));
const secret = "synthetic-human-secret-0123456789";
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill(); });
}
async function fixture(chain: "devnet" | "mock" | null, configured = true) {
  const backend = new FaultyBackend(new MockBackend({ balances: { [payer]: 20_000_000n, [merchant]: 20_000_000n } }));
  const service = new PaymentService({ backend, approvalSecret: secret });
  const upstream = createServer(createHttpHandler({ service, backendName: chain ?? "devnet", approvalSecret: secret, routeSecret: secret }));
  const upstreamPort = await listen(upstream);
  if (chain === null) await close(upstream);
  const reservation = createServer(), port = await listen(reservation);
  await close(reservation);
  const root = fileURLToPath(new URL("../../demo-dashboard/", import.meta.url));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), SINGIT_BACKEND: "mcp-http", SINGIT_REQUIRE_DEVNET: "1", SINGIT_MCP_WAIT_MS: "0", SINGIT_MCP_URL: `http://127.0.0.1:${upstreamPort}`, SINGIT_HUMAN_ROUTE_SECRET: secret, SINGIT_PAYER_ADDRESS: configured ? payer : "", SINGIT_MERCHANT_ADDRESS: configured ? merchant : "" },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  const state = async () => (await fetch(`${base}/api/state`)).json();
  const post = async (path: string, body: Record<string, unknown> = {}) => {
    const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const until = async (predicate: (state: any) => boolean) => {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const current = await state().catch(() => null);
      if (current && predicate(current)) return current;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw Error("Synthetic dashboard timed out");
  };
  const dispose = async () => { await stop(child); if (chain !== null) await close(upstream); };
  try { await until(s => s.backend !== "connecting"); } catch (error) { await dispose(); throw error; }
  return { service, backend, state, post, until, dispose };
}

for (const chain of [null, "mock"] as const) test(`live bridge refuses fallback when upstream is ${chain ?? "unreachable"}`, async () => {
  const app = await fixture(chain);
  try {
    const state = await app.state();
    expect(state.backend).toBe("mcp-http");
    expect(state.chain).toBe("unavailable");
    expect((await app.post("/api/story")).status).toBe(503);
    expect(app.service.listMandates()).toHaveLength(0);
  } finally { await app.dispose(); }
}, 10000);

test("live story requires matching public-wallet configuration before any mandate", async () => {
  const app = await fixture("devnet", false);
  try {
    expect((await app.post("/api/story", { confirmedDevnet: true })).status).toBe(503);
    expect(app.service.listMandates()).toHaveLength(0);
  } finally { await app.dispose(); }
}, 10000);

test("synthetic live bridge uses configured wallets through MCP and requires a separate human decision", async () => {
  const app = await fixture("devnet");
  try {
    expect((await app.post("/api/story")).body.code).toBe("DEVNET_CONFIRMATION_REQUIRED");
    expect((await app.post("/api/story", { confirmedDevnet: true, autoApprove: true })).status).toBe(409);
    expect(app.service.listMandates()).toHaveLength(0);
    expect((await app.post("/api/story", { confirmedDevnet: true, delay: 0 })).status).toBe(202);
    const waiting = await app.until(s => s.story.state === "awaiting-human" || s.story.state === "error");
    expect(waiting.story.state).toBe("awaiting-human");
    expect(waiting.mandates[0].payer).toBe(payer);
    expect(waiting.mandates[0].allowedCounterparties).toEqual([merchant]);
    expect(waiting.mandates[0].holds.map((h: { payee: string }) => h.payee)).toEqual([merchant, merchant]);
    expect(waiting.timeline.filter((e: { kind: string }) => e.kind === "blocked").map((e: { code: string }) => e.code)).toEqual(["OVER_PER_TX_CAP", "COUNTERPARTY_NOT_ALLOWED", "OVER_BUDGET", "HUMAN_APPROVAL_REQUIRED", "HUMAN_APPROVAL_REQUIRED"]);
    const resolution = await app.post("/api/human/resolve", { disputeId: waiting.disputes[0].id, outcome: "refund", refundAmount: "4000000" });
    expect(resolution.body.ok).toBe(true);
    const done = await app.state();
    expect(done.story.state).toBe("done");
    expect(done.disputes[0].refundAmount).toBe("4000000");
    expect(done.mandates[0].remaining).toBe("3500000");
    expect(app.backend.holdCalls).toBe(2);
  } finally { await app.dispose(); }
}, 10000);

test("unexpected payment failure stops the story without later economic steps", async () => {
  const app = await fixture("devnet");
  try {
    app.backend.queueCaptureFault("definite-before");
    await app.post("/api/story", { confirmedDevnet: true, delay: 0 });
    const failed = await app.until(s => s.story.state === "error");
    expect(failed.story.step).toBe(3);
    expect(app.backend.holdCalls).toBe(1);
    expect(app.backend.captureCalls).toBe(1);
    expect(app.backend.releaseCalls).toBe(0);
    expect(app.backend.refundCalls).toBe(0);
  } finally { await app.dispose(); }
}, 10000);
