const base = (process.env.SINGIT_MCP_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const sdkRoot = new URL("../../singit-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/", import.meta.url);
const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
  import(new URL("client/index.js", sdkRoot).href),
  import(new URL("client/streamableHttp.js", sdkRoot).href),
]);
const client = new Client({ name: "singit-mcp-smoke", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));

function report(name, result) {
  const data = result?.structuredContent ?? {};
  console.log(`${name}: ${data.ok === true ? "ok" : data.code ?? "ERROR"}`);
  return data;
}

const tools = await client.listTools();
console.log(`list_tools: ${tools.tools?.length ? "ok" : "ERROR"}`);
const listed = report("list_mandates", await client.callTool({ name: "list_mandates", arguments: {} }));
const now = Math.floor(Date.now() / 1000);
const created = report("create_mandate", await client.callTool({ name: "create_mandate", arguments: {
  actor: "smoke-payer", payer: "smoke-payer", totalBudget: "1000000", perTxCap: "1000000",
  expiresAt: now + 3600, allowedCounterparties: ["smoke-payee"],
} }));
const mandateId = created.mandate?.id ?? created.id;
let held = { ok: false, code: "CREATE_MANDATE_FAILED" };
if (mandateId) held = report("hold", await client.callTool({ name: "hold", arguments: { actor: "smoke-payer", mandateId, payee: "smoke-payee", amount: "500000" } }));
else console.log("hold: CREATE_MANDATE_FAILED");
try {
  const state = await fetch(`${base}/api/state`);
  console.log(`api_state: HTTP ${state.status}`);
} catch (e) { console.log(`api_state: ERROR ${e.message}`); }
await client.close();
if (listed.ok !== true || created.ok !== true || held.ok !== true) process.exitCode = 1;
