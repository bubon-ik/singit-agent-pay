import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { MockBackend } from "../src/backend/mock.js";
import { createHttpHandler } from "../src/http.js";
import { PaymentService } from "../src/service.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill(); });
}

test("dashboard HTTP state redacts full records received from an older MCP upstream", async () => {
  const wire = "private-legacy-upstream-wire";
  const operations = ["pending", "unknown", "succeeded", "failed"].map((state, index) => ({
    id: `op-${index}`, action: "hold", state, reservation: "1000000",
    params: { amount: "1000000" },
    prepared: {
      txSig: `mock-tx-${index}`, holdId: `payment-${index}`, lastValidBlockHeight: 100,
      evidence: { signedTransaction: wire }, signedTransaction: wire,
    },
    salt: "private-salt", futurePrivateField: wire,
  }));
  const service = new PaymentService({ backend: new MockBackend() });
  const mcp = createHttpHandler({ service, backendName: "mock" });
  const upstream = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/state") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        backend: "devnet", mandates: [], holds: [], disputes: [], audit: [], ops: operations,
      }));
    } else mcp(req, res);
  });
  const upstreamPort = await listen(upstream);
  const reservation = createServer();
  const dashboardPort = await listen(reservation);
  await close(reservation);
  const dashboardRoot = fileURLToPath(new URL("../../demo-dashboard/", import.meta.url));
  const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const child = spawn(process.execPath, [tsx, "server.mjs"], {
    cwd: dashboardRoot,
    env: {
      ...process.env, PORT: String(dashboardPort), SINGIT_BACKEND: "mcp-http",
      SINGIT_MCP_URL: `http://127.0.0.1:${upstreamPort}`, SINGIT_MCP_WAIT_MS: "5000",
      TSX_DISABLE_CACHE: "1",
    },
    stdio: "ignore",
  });
  try {
    let body: { backend?: string; ops?: Record<string, unknown>[] } = {};
    let raw = "";
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${dashboardPort}/api/state`);
        raw = await response.text();
        body = JSON.parse(raw);
        if (body.backend === "mcp-http") break;
      } catch { /* wait for the synthetic bridge to listen/connect */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(body.backend).toBe("mcp-http");
    expect(raw).not.toContain(wire);
    expect(raw).not.toContain('"evidence"');
    expect(raw).not.toContain('"signedTransaction"');
    expect(body.ops).toHaveLength(4);
    body.ops!.forEach((op, index) => {
      expect(op.state).toBe(operations[index].state);
      expect(op.prepared).toEqual({ txSig: `mock-tx-${index}`, holdId: `payment-${index}`, lastValidBlockHeight: 100 });
      expect(op.params).toEqual({ amount: "1000000" });
      expect(op.reservation).toBe("1000000");
      expect(op.salt).toBeUndefined();
      expect(op.futurePrivateField).toBeUndefined();
    });
    expect(operations[0].prepared.evidence.signedTransaction).toBe(wire);
  } finally {
    await stop(child);
    await close(upstream);
  }
}, 10000);
