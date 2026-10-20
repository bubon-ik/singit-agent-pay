import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BuyerSession, merchantProcessEnv } from './buyer.mjs';
import { paymentClient, Store } from './common.mjs';
import { profileFromEnv } from './profile.mjs';
import { readRunConfig, buyerProcessEnv } from './run-config.mjs';

export function buyerServer(session) {
  const server = new McpServer({ name: 'mandated-report-buyer', version: '0.1.0' });
  const descriptions = {
    quote_report: 'Get the quote for the one operator-bound expense report. No payment is sent.',
    hold_report: 'Authorize the quoted 1-USDC maximum under the existing human mandate. All identities and keys are fixed by the trusted adapter.',
    purchase_report: 'Ask the separate merchant to capture 0.65 USDC and atomically release 0.35. A completed repeat is read-only; uncertainty blocks further payments.',
    get_report: 'Retrieve the durably completed report bytes and original receipt. Use the artifact to produce a useful expense-quality analysis.',
  };
  for (const [name, description] of Object.entries(descriptions)) {
    server.registerTool(name, { description, inputSchema: z.object({}).strict() }, async args => {
      try {
        const result = await session.step(name, args);
        // Payment credentials, local paths and wire evidence are never model outputs.
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const code = /^[A-Z_]{1,80}$/.test(error?.message ?? '') ? error.message : 'BUYER_STOPPED';
        const result = { ok: false, code, instruction: 'Stop. Preserve the original intent and evidence; do not create another payment or change identity.' };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      }
    });
  }
  return server;
}

export async function startBuyerMcp({ env, inputPath, mandateId, intent }) {
  if (!inputPath || !mandateId || !intent) throw Error('INPUT_MANDATE_INTENT_REQUIRED');
  const profile = profileFromEnv(env);
  const payments = await paymentClient(env, 'buyer');
  const merchant = new Client({ name: 'mandated-report-merchant-client', version: '0.1.0' });
  const store = new Store(env.BUYER_STATE_DIR);
  let session, server;
  const close = async () => {
    await server?.close().catch(() => {}); session?.close();
    await merchant.close().catch(() => {}); await payments.close().catch(() => {}); store.close();
  };
  try {
    await merchant.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('./merchant.mjs', import.meta.url))], env: merchantProcessEnv(env), stderr: 'pipe' }));
    session = new BuyerSession({ payments, merchant, store, intent, mandateId, profile,
      payer: profile.payer, payee: profile.merchant, rows: JSON.parse(readFileSync(inputPath, 'utf8')),
      ...(env.REPORT_CAPTURE_DEADLINE ? { captureDeadline: Number(env.REPORT_CAPTURE_DEADLINE),
        refundDeadline: Number(env.REPORT_REFUND_DEADLINE) } : {}) });
    server = buyerServer(session);
    process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
    process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
    await server.connect(new StdioServerTransport());
  } catch (error) { await close(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [inputPath, mandateId, intent] = process.argv.slice(2);
  const run = async () => {
    if (inputPath === '--run-config') {
      const config = readRunConfig(mandateId);
      return startBuyerMcp({ env: buyerProcessEnv(config), inputPath: config.inputPath, mandateId: config.mandateId, intent: config.intent });
    }
    return startBuyerMcp({ env: process.env, inputPath, mandateId, intent });
  };
  run().catch(() => {
    console.error('Buyer stopped; preserve private intent, journal and originals.'); process.exitCode = 1;
  });
}
