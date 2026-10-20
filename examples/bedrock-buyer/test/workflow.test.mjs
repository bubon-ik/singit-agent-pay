import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buy, BuyerSession, merchantProcessEnv } from '../buyer.mjs';
import { MAXIMUM, MINT, paymentClient, PRICE, report, Store, tool } from '../common.mjs';
import { Merchant } from '../merchant.mjs';

const rows = [{ id: 'a', category: 'compute', amount: '9007199254740993' }, { id: 'a', category: 'data', amount: '2' }];
const intent = 'synthetic-intent-0001';
const args = { intent, mandateId: 'm-1', rows };
const ok = value => ({ structuredContent: { ok: true, ...value } });
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'capture402-merchant-test-'));
  const store = new Store(dir);
  let captures = 0;
  const hold = { id: 'h-1', payer: 'buyer-test', payee: 'seller-test', mint: MINT, maximum: MAXIMUM,
    held: MAXIMUM, captured: '0', refunded: '0', captureDeadline: Math.floor(Date.now() / 1000) + 100, ...options.hold };
  const payments = { async callTool({ name }) {
    if (name === 'get_mandate') return ok({ mandate: { payer: 'buyer-test' }, holds: [hold] });
    assert.equal(name, 'capture'); captures++;
    if (options.lostReply) throw Error('synthetic lost reply after send');
    Object.assign(hold, { held: '0', captured: PRICE });
    return ok({ hold, txSig: 'mock-tx-2' });
  } };
  const merchant = new Merchant({ store, payments, payer: 'buyer-test', merchant: 'seller-test' });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { merchant, store, dir, captures: () => captures };
}

function buyerFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'capture402-buyer-test-'));
  const store = new Store(join(dir, 'buyer')), merchantStore = new Store(join(dir, 'merchant'));
  const holds = [];
  let captures = 0;
  const payments = { async callTool({ name, arguments: input }) {
    if (name === 'hold') {
      const hold = { id: `h-${holds.length + 1}`, payer: 'buyer-test', payee: 'seller-test', mint: MINT,
        maximum: MAXIMUM, held: MAXIMUM, captured: '0', refunded: '0', captureDeadline: Math.floor(Date.now() / 1000) + 100 };
      holds.push(hold);
      return ok({ hold });
    }
    if (name === 'get_mandate') return ok({ mandate: { payer: 'buyer-test' }, holds });
    assert.equal(name, 'capture'); captures++;
    const hold = holds.find(item => item.id === input.holdId);
    Object.assign(hold, { held: '0', captured: PRICE });
    return ok({ hold, txSig: `mock-capture-${captures}` });
  } };
  const merchant = new Merchant({ store: merchantStore, payments, payer: 'buyer-test', merchant: 'seller-test' });
  const client = { async callTool({ name, arguments: input }) {
    if (name === 'quote_report') return ok(merchant.quote(input));
    assert.equal(name, 'purchase_report');
    return ok(await merchant.purchase(input));
  } };
  const request = { payments, merchant: client, store, intent, mandateId: 'm-1', payer: 'buyer-test', payee: 'seller-test', rows };
  t.after(() => { store.close(); merchantStore.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir: store.path, store, merchant, holds, captures: () => captures, request };
}

async function failCompletionDirectorySync(store, run, phase = 'completion') {
  const originalSync = fs.fsyncSync;
  let failures = 0;
  fs.fsyncSync = fd => {
    if (fs.fstatSync(fd).isDirectory()) {
      const names = fs.readdirSync(store.path);
      const pending = names.some(name => /^[a-f0-9]{64}\.pending\.json$/.test(name));
      const completed = names.some(name => /^[a-f0-9]{64}\.json$/.test(name) &&
        JSON.parse(fs.readFileSync(join(store.path, name), 'utf8')).stage === 'done');
      if (phase === 'completion' ? completed : phase === 'pending' ? pending && !completed : completed && !pending) {
        failures++;
        throw Error(`synthetic directory fsync failure during ${phase}`);
      }
    }
    return originalSync(fd);
  };
  syncBuiltinESMExports();
  try { await run(); assert.equal(failures, 1, `inject exactly during ${phase}`); }
  finally { fs.fsyncSync = originalSync; syncBuiltinESMExports(); }
}

test('report preserves integer precision and exposes duplicate rows without silently deduplicating totals', () => {
  const artifact = report(rows).artifact;
  const parsed = JSON.parse(artifact.utf8);
  assert.equal(parsed.total, '9007199254740995');
  assert.deepEqual(parsed.duplicateIds, ['a']);
  assert.deepEqual(parsed.categories, { compute: '9007199254740993', data: '2' });
  assert.deepEqual(report(rows).artifact, artifact);
  assert.throws(() => report([{ id: 'a', category: 'data', amount: '-1' }]), /INVALID_ROWS/);
});

test('quotes bind the original intent to exact input and mandate', t => {
  const f = fixture(t);
  assert.deepEqual(f.merchant.quote(args), f.merchant.quote(args));
  assert.throws(() => f.merchant.quote({ ...args, mandateId: 'm-2' }), /INTENT_CONFLICT/);
  assert.throws(() => f.merchant.quote({ ...args, rows: [rows[0]] }), /INTENT_CONFLICT/);
  assert.equal(f.captures(), 0);
});

test('foreign merchant or changed hold terms refuse before capture', async t => {
  const f = fixture(t, { hold: { payee: 'another-seller' } });
  const quote = f.merchant.quote(args);
  await assert.rejects(f.merchant.purchase({ orderId: quote.orderId, holdId: 'h-1' }), /PAYMENT_TERMS_DIFFER/);
  assert.equal(f.captures(), 0);
});

test('identical artifact survives restart and redelivery never recaptures', async t => {
  const f = fixture(t), quote = f.merchant.quote(args);
  const first = await f.merchant.purchase({ orderId: quote.orderId, holdId: 'h-1' });
  assert.equal(first.receipt.released, '350000');
  assert.equal(f.captures(), 1);
  f.store.close();
  const restored = new Store(f.dir);
  try {
    const m = new Merchant({ store: restored, payments: { callTool() { throw Error('no payment expected'); } }, payer: 'buyer-test', merchant: 'seller-test' });
    assert.deepEqual(await m.purchase({ orderId: quote.orderId, holdId: 'h-1' }), first);
    assert.deepEqual(m.status(quote.orderId).artifact, first.artifact);
  } finally { restored.close(); }
});

test('a consumed hold cannot purchase a second artifact', async t => {
  const f = fixture(t), one = f.merchant.quote(args), two = f.merchant.quote({ ...args, intent: 'synthetic-intent-0002' });
  await f.merchant.purchase({ orderId: one.orderId, holdId: 'h-1' });
  await assert.rejects(f.merchant.purchase({ orderId: two.orderId, holdId: 'h-1' }), /HOLD_ALREADY_BOUND/);
  assert.equal(f.captures(), 1);
});

test('lost capture response retains original pending record and blocks all new purchases after restart', async t => {
  const f = fixture(t, { lostReply: true }), quote = f.merchant.quote(args);
  await assert.rejects(f.merchant.purchase({ orderId: quote.orderId, holdId: 'h-1' }), /NO_RETRY/);
  assert.equal(f.merchant.status(quote.orderId).artifact, undefined);
  await assert.rejects(f.merchant.purchase({ orderId: quote.orderId, holdId: 'h-1' }), /UNRESOLVED/);
  assert.equal(f.captures(), 1);
  f.store.close();
  const restored = new Store(f.dir);
  try {
    const m = new Merchant({ store: restored, payments: {}, payer: 'buyer-test', merchant: 'seller-test' });
    assert.throws(() => m.quote({ ...args, intent: 'synthetic-intent-0002' }), /UNRESOLVED/);
    assert.equal(restored.all()[0].stage, 'capture_pending');
  } finally { restored.close(); }
});

test('post-capture persistence failure withholds delivery and never retries', async t => {
  const f = fixture(t), quote = f.merchant.quote(args), save = f.store.save.bind(f.store);
  f.store.save = record => { if (record.stage === 'done') throw Error('synthetic fsync failure'); save(record); };
  await assert.rejects(f.merchant.purchase({ orderId: quote.orderId, holdId: 'h-1' }), /NO_RETRY/);
  assert.equal(f.store.read(quote.orderId).stage, 'capture_pending');
  await assert.rejects(f.merchant.purchase({ orderId: quote.orderId, holdId: 'h-1' }), /UNRESOLVED/);
  assert.equal(f.captures(), 1);
});

test('post-rename fsync failure preserves pending evidence and withholds merchant delivery after restart', async t => {
  const f = fixture(t), quote = f.merchant.quote(args);
  const purchase = { orderId: quote.orderId, holdId: 'h-1' };
  await failCompletionDirectorySync(f.store, async () => {
    await assert.rejects(f.merchant.purchase(purchase), /NO_RETRY/);
  });
  assert.equal(f.store.blocked, true);
  assert.equal(f.store.read(quote.orderId).stage, 'capture_pending');
  assert.equal(f.merchant.status(quote.orderId).artifact, undefined);
  await assert.rejects(f.merchant.purchase(purchase), /UNRESOLVED/);
  assert.equal(JSON.parse(fs.readFileSync(join(f.dir, `${quote.orderId}.json`), 'utf8')).stage, 'done',
    'retain the failed completion candidate as evidence');
  f.store.close();
  const restored = new Store(f.dir);
  try {
    const merchant = new Merchant({ store: restored, payments: { callTool() { throw Error('no payment expected'); } },
      payer: 'buyer-test', merchant: 'seller-test' });
    assert.equal(restored.blocked, true);
    assert.equal(restored.read(quote.orderId).stage, 'capture_pending');
    assert.equal(merchant.status(quote.orderId).artifact, undefined);
    await assert.rejects(merchant.purchase(purchase), /UNRESOLVED/);
    assert.throws(() => merchant.quote({ ...args, intent: 'synthetic-intent-0002' }), /UNRESOLVED/);
    assert.equal(f.captures(), 1);
  } finally { restored.close(); }
});

test('failed pending-guard fsync leaves a discoverable original even without the canonical record', async t => {
  const f = fixture(t), quote = f.merchant.quote(args);
  await failCompletionDirectorySync(f.store, async () => {
    await assert.rejects(f.merchant.purchase({ orderId: quote.orderId, holdId: 'h-1' }), /NO_RETRY/);
  }, 'pending');
  assert.equal(fs.existsSync(join(f.dir, `${quote.orderId}.json`)), false);
  assert.equal(f.store.all()[0].stage, 'capture_pending');
  assert.equal(f.merchant.status(quote.orderId).artifact, undefined);
  f.store.close();
  const restored = new Store(f.dir);
  try {
    assert.equal(restored.blocked, true);
    assert.equal(restored.all()[0].holdId, 'h-1');
    assert.equal(f.captures(), 1);
  } finally { restored.close(); }
});

test('cleanup fsync failure cannot invalidate an already durable completion', async t => {
  const f = fixture(t), quote = f.merchant.quote(args);
  let delivered;
  await failCompletionDirectorySync(f.store, async () => {
    delivered = await f.merchant.purchase({ orderId: quote.orderId, holdId: 'h-1' });
  }, 'cleanup');
  assert.equal(delivered.stage, 'done');
  assert.equal(f.store.blocked, false);
  f.store.close();
  const restored = new Store(f.dir);
  try {
    const merchant = new Merchant({ store: restored, payments: { callTool() { throw Error('no payment expected'); } },
      payer: 'buyer-test', merchant: 'seller-test' });
    assert.deepEqual(merchant.status(quote.orderId), delivered);
    assert.equal(f.captures(), 1);
  } finally { restored.close(); }
});

test('buyer completion fsync failure cannot replay candidate bytes or create another hold after restart', async t => {
  const f = buyerFixture(t);
  await failCompletionDirectorySync(f.store, async () => {
    await assert.rejects(buy(f.request), /NO_RETRY/);
  });
  assert.equal(f.store.all()[0].stage, 'purchase_pending');
  assert.equal(f.store.all()[0].holdId, 'h-1');
  await assert.rejects(buy(f.request), /UNRESOLVED/);
  f.store.close();
  const restored = new Store(f.dir);
  try {
    assert.equal(restored.blocked, true);
    await assert.rejects(buy({ ...f.request, store: restored }), /UNRESOLVED/);
    await assert.rejects(buy({ ...f.request, store: restored, intent: 'synthetic-intent-0002' }), /UNRESOLVED/);
    assert.equal(f.holds.length, 1);
    assert.equal(f.captures(), 1);
  } finally { restored.close(); }
});

test('overlapping buyer calls create one hold and retain its original identity', async t => {
  for (const overlappingIntent of [intent, 'synthetic-intent-0002']) {
    await t.test(overlappingIntent === intent ? 'same intent' : 'different intent in the same store', async t => {
      const f = buyerFixture(t);
      const outcomes = await Promise.allSettled([buy(f.request), buy({ ...f.request, intent: overlappingIntent })]);
      assert.equal(outcomes[0].status, 'fulfilled');
      assert.equal(outcomes[1].status, 'rejected');
      assert.match(outcomes[1].reason.message, /UNRESOLVED/);
      assert.equal(f.holds.length, 1);
      assert.equal(f.captures(), 1);
      assert.equal(f.store.all().length, 1);
      assert.equal(f.store.all()[0].holdId, f.holds[0].id);
      assert.deepEqual(await buy(f.request), outcomes[0].value, 'the completed original remains replayable');
      assert.equal(f.holds.length, 1);
    });
  }
});

test('a quote refusal releases the buyer guard before any economic operation', async t => {
  const f = buyerFixture(t);
  await assert.rejects(buy({ ...f.request, merchant: { async callTool() { throw Error('QUOTE_UNAVAILABLE'); } } }), /QUOTE_UNAVAILABLE/);
  assert.equal(f.holds.length, 0);
  assert.equal(f.store.all().length, 0);
  assert.equal((await buy(f.request)).stage, 'done');
  assert.equal(f.holds.length, 1);
  assert.equal(f.captures(), 1);
});

test('the same model session cannot deliver a candidate after its terminal storage write fails', async t => {
  const f = buyerFixture(t), session = new BuyerSession(f.request);
  t.after(() => session.close());
  await session.step('quote_report'); await session.step('hold_report');
  const save = f.store.save.bind(f.store);
  t.mock.method(f.store, 'save', record => { if (record.stage === 'done') throw Error('synthetic terminal failure'); save(record); });
  await assert.rejects(session.step('purchase_report'), /NO_RETRY/);
  await assert.rejects(session.step('get_report'), /DURABLE_COMPLETION_REQUIRED/);
  await assert.rejects(session.step('purchase_report'), /ORIGINAL_OPERATION_UNRESOLVED/);
  assert.equal(f.holds.length, 1); assert.equal(f.captures(), 1);
});

test('buyer lost hold reply cannot create a second hold on rerun', async t => {
  const f = fixture(t), q = f.merchant.quote(args);
  let sends = 0;
  const request = { store: f.store, intent, mandateId: 'm-1', payer: 'buyer-test', payee: 'seller-test', rows,
    merchant: { callTool: async () => ok(q) }, payments: { callTool: async () => { sends++; throw Error('lost hold response'); } } };
  await assert.rejects(buy(request), /NO_RETRY/);
  await assert.rejects(buy(request), /UNRESOLVED/);
  assert.equal(sends, 1);
});

test('incomplete devnet profile refuses before any network request or payment', async () => {
  await assert.rejects(paymentClient({ PAYMENT_PROFILE: 'devnet', REPORT_PAYER: 'payer', REPORT_MERCHANT: 'merchant' }, 'buyer'), /PRIVATE_PROFILE_REQUIRED/);
});

test('payment roles and tokens are required before any network request', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw Error('NO_NETWORK_EXPECTED'); });
  const env = { PAYMENT_PROFILE: 'mock', PAYMENT_MCP_URL: 'http://127.0.0.1:1/mcp' };
  for (const role of ['buyer', 'merchant']) {
    for (const token of [undefined, 'short', 'synthetic token with spaces', 'synthetic-token\nwith-newline']) {
      await assert.rejects(paymentClient({ ...env, [`SINGIT_${role.toUpperCase()}_TOKEN`]: token }, role), /PAYMENT_TOKEN_REQUIRED/);
    }
  }
  await assert.rejects(paymentClient(env, 'human'), /PAYMENT_ROLE_REQUIRED/);
  await assert.rejects(paymentClient({ ...env, SINGIT_BUYER_TOKEN: 'synthetic-shared-token', SINGIT_MERCHANT_TOKEN: 'synthetic-shared-token' }, 'buyer'), /SEPARATE_PAYMENT_TOKENS_REQUIRED/);
  assert.equal(requests, 0);
});

test('merchant child receives only its own token and no buyer, human or wallet secrets', () => {
  const env = merchantProcessEnv({ PAYMENT_PROFILE: 'mock', PAYMENT_MCP_URL: 'http://127.0.0.1:1/mcp',
    SINGIT_MERCHANT_TOKEN: 'synthetic-merchant-token', SINGIT_BUYER_TOKEN: 'synthetic-buyer-token',
    SINGIT_HUMAN_ROUTE_SECRET: 'synthetic-human-route', SINGIT_HUMAN_APPROVAL_SECRET: 'synthetic-human-approval',
    SINGIT_PAYER_KEYPAIR: 'synthetic-wallet-file', SINGIT_RPC_URL: 'synthetic-provider', NODE_OPTIONS: 'synthetic-options' });
  assert.deepEqual(env, { PAYMENT_PROFILE: 'mock', PAYMENT_MCP_URL: 'http://127.0.0.1:1/mcp', SINGIT_MERCHANT_TOKEN: 'synthetic-merchant-token' });
});

test('all hold, capture and release calls require a valid stable idempotency key before sending', async () => {
  let sends = 0;
  const client = { async callTool() { sends++; return ok({}); } };
  for (const name of ['hold', 'capture', 'release']) {
    for (const idempotencyKey of [undefined, '', 'unstable key', 'x'.repeat(129)]) {
      await assert.rejects(tool(client, name, { idempotencyKey }), /IDEMPOTENCY_KEY_REQUIRED/);
    }
    await tool(client, name, { idempotencyKey: `synthetic-intent:${name}` });
  }
  assert.equal(sends, 3);
});

test('authenticated SingIt HTTP → merchant stdio → buyer, human mandate, idempotency and exact accounting', async t => {
  const checkout = process.env.SINGIT_CHECKOUT ?? fileURLToPath(new URL('../../..', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'capture402-mcp-test-'));
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const buyerToken = randomUUID(), merchantToken = randomUUID(), humanSecret = randomUUID();
  const upstream = spawn(process.execPath, [join(checkout, 'singit-mcp/node_modules/tsx/dist/cli.mjs'), join(checkout, 'singit-mcp/src/index.ts'), '--http'],
    { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), SINGIT_BACKEND: 'mock',
      SINGIT_BUYER_TOKEN: buyerToken, SINGIT_MERCHANT_TOKEN: merchantToken, SINGIT_HUMAN_ROUTE_SECRET: humanSecret,
      SINGIT_PAYER_ADDRESS: 'buyer-agent', SINGIT_MERCHANT_ADDRESS: 'seller-agent' }, stdio: ['ignore', 'ignore', 'ignore'] });
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, PAYMENT_PROFILE: 'mock', PAYMENT_MCP_URL: `http://127.0.0.1:${port}/mcp`,
    REPORT_PAYER: 'buyer-agent', REPORT_MERCHANT: 'seller-agent', MERCHANT_STATE_DIR: join(root, 'merchant'),
    SINGIT_BUYER_TOKEN: buyerToken, SINGIT_MERCHANT_TOKEN: merchantToken };
  let payments, merchantPayments, merchant, buyerStore;
  t.after(async () => { await merchant?.close().catch(() => {}); await payments?.close().catch(() => {}); await merchantPayments?.close().catch(() => {});
    buyerStore?.close(); upstream.kill('SIGTERM'); rmSync(root, { recursive: true, force: true }); });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) { ready = true; break; } } catch {}
    if (upstream.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(ready, 'external SingIt mock entrypoint must start');
  payments = await paymentClient(env, 'buyer');
  merchantPayments = await paymentClient(env, 'merchant');
  await assert.rejects(paymentClient({ ...env, SINGIT_BUYER_TOKEN: randomUUID() }, 'buyer'), /MCP_UNAVAILABLE/);
  const mandateTerms = { payer: 'buyer-agent', totalBudget: '2000000', perTxCap: MAXIMUM,
    expiresAt: Math.floor(Date.now() / 1000) + 300, allowedCounterparties: ['seller-agent'] };
  for (const client of [payments, merchantPayments]) {
    await assert.rejects(tool(client, 'create_mandate', mandateTerms), /PRINCIPAL_FORBIDDEN/);
  }
  const agentIssuance = await fetch(`http://127.0.0.1:${port}/human/mandate`, { method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${buyerToken}` }, body: JSON.stringify(mandateTerms) });
  assert.equal(agentIssuance.status, 401, 'an agent token never authorizes human mandate issuance');
  const beforeHuman = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  assert.equal(beforeHuman.mandates.length, 0);
  assert.equal(beforeHuman.ops.length, 0);
  // Human mandate setup belongs to the test/operator, never the buyer/merchant tools.
  const issuedResponse = await fetch(`http://127.0.0.1:${port}/human/mandate`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-singit-human-secret': humanSecret },
    body: JSON.stringify(mandateTerms) });
  assert.equal(issuedResponse.status, 200);
  const issued = await issuedResponse.json();
  assert.equal(issued.ok, true);
  await assert.rejects(tool(merchantPayments, 'hold', { actor: 'buyer-agent', mandateId: issued.mandate.id,
    payee: 'seller-agent', amount: MAXIMUM, mint: MINT, idempotencyKey: 'synthetic-forbidden-hold' }), /PRINCIPAL_FORBIDDEN/);
  merchant = new Client({ name: 'fixture-buyer', version: '0.1.0' });
  await merchant.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../merchant.mjs', import.meta.url))], env: merchantProcessEnv(env), stderr: 'pipe' }));
  buyerStore = new Store(join(root, 'buyer'));
  const request = { payments, merchant, store: buyerStore, intent, mandateId: issued.mandate.id, payer: 'buyer-agent', payee: 'seller-agent', rows };
  const attempts = await Promise.allSettled([buy(request), buy(request)]);
  assert.equal(attempts[0].status, 'fulfilled');
  assert.equal(attempts[1].status, 'rejected');
  assert.match(attempts[1].reason.message, /UNRESOLVED/);
  const first = attempts[0].value;
  assert.equal(first.stage, 'done');
  assert.equal(JSON.parse(first.artifact.utf8).total, '9007199254740995');
  assert.deepEqual(await buy(request), first);
  assert.deepEqual(await tool(merchant, 'get_report', { orderId: first.orderId }), first);
  const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  assert.equal(state.ops.length, 2);
  assert.deepEqual(state.ops.map(op => op.action).sort(), ['capture', 'hold']);
  assert.equal(state.holds[0].held, '0');
  assert.equal(state.holds[0].captured, PRICE);
  assert.equal(state.mandates[0].mandate.committed, PRICE);
  await assert.rejects(tool(payments, 'capture', { actor: 'seller-agent', holdId: first.receipt.holdId, amount: PRICE,
    releaseRemainder: true, idempotencyKey: 'synthetic-forbidden-capture' }), /PRINCIPAL_FORBIDDEN/);
  // Replay only known successful synthetic outcomes to prove the keys reach the new MCP service.
  const orderId = buyerStore.all()[0].quote.orderId;
  const holdReplay = await tool(payments, 'hold', { actor: 'buyer-agent', mandateId: issued.mandate.id, payee: 'seller-agent',
    amount: MAXIMUM, mint: MINT, idempotencyKey: `report:${orderId}:hold` });
  assert.equal(holdReplay.replay, true);
  assert.equal(holdReplay.hold.id, first.receipt.holdId);
  assert.equal(holdReplay.operationId, state.ops.find(op => op.action === 'hold').id);
  const captureReplay = await tool(merchantPayments, 'capture', { actor: 'seller-agent', holdId: first.receipt.holdId,
    amount: PRICE, releaseRemainder: true, idempotencyKey: `report:${orderId}:capture` });
  assert.equal(captureReplay.replay, true);
  assert.equal(captureReplay.operationId, state.ops.find(op => op.action === 'capture').id);
  assert.equal(captureReplay.txSig, first.receipt.txSig);
  await assert.rejects(tool(payments, 'hold', { actor: 'buyer-agent', mandateId: issued.mandate.id, payee: 'seller-agent',
    amount: '900000', mint: MINT, idempotencyKey: `report:${orderId}:hold` }), /IDEMPOTENCY_KEY_REUSED/);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()).ops.length, 2);
  await merchant.close();
  const cliEnv = { ...env, BUYER_STATE_DIR: join(root, 'buyer-cli') };
  async function runCli() {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../buyer.mjs', import.meta.url)), fileURLToPath(new URL('../sample.json', import.meta.url)),
      issued.mandate.id, 'synthetic-cli-intent-0002'], { env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    assert.equal(exit, 0, stderr);
    for (const credential of [buyerToken, merchantToken, humanSecret]) {
      assert.equal((stdout + stderr).includes(credential), false, 'CLI output must not expose credentials');
    }
    return JSON.parse(stdout);
  }
  const cliFirst = await runCli();
  assert.equal(JSON.parse(cliFirst.artifact.utf8).total, '2800');
  assert.deepEqual(await runCli(), cliFirst);
  const afterCli = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  assert.equal(afterCli.ops.length, 4, 'one additional hold/capture for the new CLI intent; none for replay');
  assert.equal(afterCli.mandates[0].mandate.committed, '1300000');
  await t.test('standalone release uses the merchant token and replays its original stable key', async () => {
    const held = await tool(payments, 'hold', { actor: 'buyer-agent', mandateId: issued.mandate.id, payee: 'seller-agent',
      amount: '100000', mint: MINT, idempotencyKey: 'synthetic-release-contract:hold' });
    const releaseArgs = { actor: 'seller-agent', holdId: held.hold.id, idempotencyKey: 'synthetic-release-contract:release' };
    const released = await tool(merchantPayments, 'release', releaseArgs);
    assert.equal(released.hold.held, '0');
    const replay = await tool(merchantPayments, 'release', releaseArgs);
    assert.equal(replay.replay, true);
    assert.equal(replay.operationId, released.operationId);
    assert.equal(replay.txSig, released.txSig);
    const afterRelease = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(afterRelease.ops.length, 6, 'one synthetic hold/release pair and no operation for replay');
    assert.equal(afterRelease.mandates[0].mandate.committed, '1300000');
  });
});
