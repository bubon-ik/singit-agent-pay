#!/usr/bin/env node
/**
 * Entry point: picks a backend and a transport, then serves the MCP tools from src/server.ts.
 * stdio by default (never logs to stdout there); --http / SINGIT_MCP_HTTP=1 switches to a
 * stateless streamable-HTTP server on node:http, sharing one PaymentService across requests.
 */
import { createServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { approvalSecretFromEnv } from "./approval.js";
import { Capture402Backend } from "./backend/capture402.js";
import { MockBackend } from "./backend/mock.js";
import { DEVNET_USDC_MINT, type PaymentBackend } from "./backend/types.js";
import { createHttpHandler } from "./http.js";
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
  const backendName = process.env.SINGIT_BACKEND === "capture402" ? "devnet" : "mock";
  const rawRouteSecret = process.env.SINGIT_HUMAN_ROUTE_SECRET;
  const routeSecret = rawRouteSecret && rawRouteSecret.length >= 16 ? rawRouteSecret : undefined;

  const handler = createHttpHandler({
    service,
    backendName,
    approvalSecret,
    routeSecret,
    mcpPerMin: Number(process.env.SINGIT_RATE_LIMIT_PER_MIN ?? 120),
    statePerMin: Number(process.env.SINGIT_STATE_RATE_LIMIT_PER_MIN ?? 600),
  });
  const httpServer = createServer(handler);

  httpServer.listen(port, host, () => {
    console.error(`singit-mcp: streamable HTTP on http://${host}:${port}/mcp (health: /health)`);
  });
} else {
  const mcpServer = createMcpServer(service);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}
