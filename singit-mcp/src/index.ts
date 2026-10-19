#!/usr/bin/env node
/**
 * Entry point: picks a backend and a transport, then serves the MCP tools from src/server.ts.
 * stdio by default (never logs to stdout there); --http / SINGIT_MCP_HTTP=1 switches to a
 * stateless streamable-HTTP server on node:http, sharing one PaymentService across requests.
 */
import { createServer } from "node:http";
import { createRateLimiter } from "./ratelimit.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { approvalSecretFromEnv } from "./approval.js";
import { Capture402Backend } from "./backend/capture402.js";
import { MockBackend } from "./backend/mock.js";
import { DEVNET_USDC_MINT, type PaymentBackend } from "./backend/types.js";
import { createMcpServer } from "./server.js";
import { PaymentService } from "./service.js";

function buildBackend(): PaymentBackend {
  if (process.env.SINGIT_BACKEND === "capture402") {
    return new Capture402Backend({
      rpcUrl: process.env.SINGIT_RPC_URL ?? "https://api.devnet.solana.com",
      programId: process.env.SINGIT_PROGRAM_ID ?? "",
      mint: DEVNET_USDC_MINT,
    });
  }
  const raw = process.env.SINGIT_MOCK_BALANCES;
  const balances: Record<string, bigint> = raw
    ? Object.fromEntries(Object.entries(JSON.parse(raw) as Record<string, string>).map(([addr, v]) => [addr, BigInt(v)]))
    : { "buyer-agent": 100_000_000n, "seller-agent": 20_000_000n };
  return new MockBackend({ balances });
}

const backend = buildBackend();
const approvalSecret = approvalSecretFromEnv();
if (!approvalSecret) {
  console.error("WARNING: SINGIT_HUMAN_APPROVAL_SECRET is unset or shorter than 16 chars; resolve_dispute will refuse every call.");
}

const service = new PaymentService({ backend, approvalSecret });

const useHttp = process.argv.includes("--http") || process.env.SINGIT_MCP_HTTP === "1";

if (useHttp) {
  const host = "127.0.0.1"; // always loopback; expose publicly only via a tunnel/reverse proxy
  const port = Number(process.env.PORT ?? 8787);
  const allow = createRateLimiter(Number(process.env.SINGIT_RATE_LIMIT_PER_MIN ?? 120));

  const httpServer = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
          return;
        }
        const client = String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "unknown");
        if (!allow(client)) {
          res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" }).end(JSON.stringify({ ok: false, error: "rate limited" }));
          return;
        }
        if (req.url !== "/mcp") {
          res.writeHead(404).end();
          return;
        }
        const mcpServer = createMcpServer(service);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void transport.close();
          void mcpServer.close();
        });
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        console.error("error handling /mcp request:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "internal error" }));
        }
      }
    })();
  });

  httpServer.listen(port, host, () => {
    console.error(`singit-mcp: streamable HTTP on http://${host}:${port}/mcp (health: /health)`);
  });
} else {
  const mcpServer = createMcpServer(service);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}
