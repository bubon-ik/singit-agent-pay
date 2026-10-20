import assert from 'node:assert/strict';
import test from 'node:test';
import { codexArguments, STEPS, BUYER_ENV, validateModelResult } from '../codex-buyer.mjs';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buyerServer } from '../buyer-mcp.mjs';

test('Codex launch grants only the bounded buyer tools and no shell/apps/secret environment', () => {
  const args = codexArguments('/synthetic/private-run.json', '/synthetic/work', '/synthetic/answer.json', '/synthetic/schema.json');
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(args.includes('--ignore-user-config'));
  for (const name of ['shell_tool', 'apps', 'plugins', 'memories', 'multi_agent', 'browser_use', 'computer_use']) {
    assert.ok(args.some((value, index) => value === '--disable' && args[index + 1] === name));
  }
  assert.deepEqual(STEPS, ['quote_report', 'hold_report', 'purchase_report', 'get_report']);
  assert.ok(BUYER_ENV.every(key => !/HUMAN|RPC|KEYPAIR|OPENAI|SOLANA/.test(key)));
  assert.ok(!args.some(value => /dangerously|workspace-write|danger-full-access/.test(value)));
});

test('a plausible model answer cannot substitute another digest or different retrieval bytes', () => {
  const utf8 = '{"total":"3"}', sha256 = createHash('sha256').update(utf8).digest('hex');
  const data = { stage: 'done', receipt: { profile: 'mock' }, artifact: { utf8, sha256 } };
  const trace = STEPS.map(tool => ({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'report_buyer',
    tool, status: 'completed', arguments: {}, result: { structured_content: data } } }));
  const answer = { profile: 'mock', artifactSha256: sha256, summary: 'Synthetic summary of the purchased expense report. '.repeat(3) };
  const encode = () => trace.map(value => JSON.stringify(value)).join('\n');
  validateModelResult(encode(), answer, 'mock');
  assert.throws(() => validateModelResult(encode(), { ...answer, artifactSha256: '0'.repeat(64) }, 'mock'), /MODEL_REPORT_INCOMPLETE/);
  trace[3].item.result = { structured_content: { ...data, artifact: { utf8: 'different', sha256 } } };
  assert.throws(() => validateModelResult(encode(), answer, 'mock'), /MODEL_REPORT_INCOMPLETE/);
});

test('the actual buyer MCP surface has four empty schemas and rejects model-supplied payment fields', async t => {
  let calls = 0;
  const server = buyerServer({ async step() { calls++; return { ok: true }; } });
  const client = new Client({ name: 'bounded-buyer-test', version: '0.1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...STEPS].sort());
  for (const entry of tools) {
    assert.deepEqual(entry.inputSchema.properties, {});
    assert.equal(entry.inputSchema.additionalProperties, false);
  }
  const refused = await client.callTool({ name: 'hold_report', arguments: { payer: 'replacement', amount: '9999999' } });
  assert.equal(refused.isError, true); assert.equal(calls, 0);
});
