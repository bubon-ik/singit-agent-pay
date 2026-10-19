#!/usr/bin/env node
/**
 * Entry point: picks a backend and a transport, then serves the MCP tools from src/server.ts.
 * stdio by default (never logs to stdout there); --http / SINGIT_MCP_HTTP=1 switches to a
 * stateless streamable-HTTP server on node:http, sharing one PaymentService across requests.
 */
import { createServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { approvalSecretFromEnv } from "./approval.js";
import { mockBalancesFromEnv, MockBackend } from "./backend/mock.js";
import { createHttpHandler } from "./http.js";
import { listFromEnv, principalConfigFromEnv, stdioPrincipalFromEnv } from "./principal.js";
import { createMcpServer } from "./server.js";
import { PaymentService } from "./service.js";
import { createServiceRuntime, StartupError } from "./runtime.js";

const approvalSecret = approvalSecretFromEnv();
if (!approvalSecret) {
  console.error("WARNING: SINGIT_HUMAN_APPROVAL_SECRET is unset or shorter than 16 chars; resolve_dispute will refuse every call.");
}

let runtime;
try {
  runtime = await createServiceRuntime(process.env, { approvalSecret });
} catch (error) {
  // Backend/config errors can contain provider credentials or filesystem paths.
  console.error(error instanceof StartupError ? `${error.code}: ${error.message}` : "MCP startup failed; review private configuration and journal locally");
  process.exit(1);
}
const { service, backendName, close } = runtime;
process.once("exit", close);
process.once("SIGINT", () => process.exit(130));
process.once("SIGTERM", () => process.exit(143));

const useHttp = process.argv.includes("--http") || process.env.SINGIT_MCP_HTTP === "1";

if (useHttp) {
  const host = "127.0.0.1"; // always loopback; expose publicly only via a tunnel/reverse proxy
  const port = Number(process.env.PORT ?? 8787);
  const rawRouteSecret = process.env.SINGIT_HUMAN_ROUTE_SECRET;
  const routeSecret = rawRouteSecret && rawRouteSecret.length >= 16 ? rawRouteSecret : undefined;

  const principals = principalConfigFromEnv(process.env, { mock: backendName === "mock" });
  const handler = createHttpHandler({
    service,
    credentials: principals.credentials,
    trustedOperator: process.env.SINGIT_MCP_TRUSTED_OPERATOR === "1",
    allowedHosts: listFromEnv(process.env.SINGIT_MCP_ALLOWED_HOSTS),
    allowedOrigins: listFromEnv(process.env.SINGIT_MCP_ALLOWED_ORIGINS),
    backendName,
    approvalSecret,
    routeSecret,
    mcpPerMin: Number(process.env.SINGIT_RATE_LIMIT_PER_MIN ?? 120),
    statePerMin: Number(process.env.SINGIT_STATE_RATE_LIMIT_PER_MIN ?? 600),
    resetService:
      backendName === "mock"
        ? () => new PaymentService({ backend: new MockBackend({ balances: mockBalancesFromEnv(process.env) }), approvalSecret })
        : undefined,
  });
  const httpServer = createServer(handler);

  httpServer.listen(port, host, () => {
    console.error(`singit-mcp: streamable HTTP on http://${host}:${port}/mcp (health: /health)`);
  });
} else {
  // stdio: the process boundary is the trust boundary; the principal is fixed by SINGIT_MCP_PRINCIPAL.
  // Unset -> legacy open mode, allowed only with the mock backend.
  let principal;
  if (process.env.SINGIT_MCP_PRINCIPAL || backendName !== "mock") {
    principal = stdioPrincipalFromEnv(process.env, principalConfigFromEnv(process.env, { mock: backendName === "mock" }));
  }
  const mcpServer = createMcpServer(service, principal);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}
