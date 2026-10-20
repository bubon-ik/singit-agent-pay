import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store, MAXIMUM, PRICE, MINT, paymentClient } from '../common.mjs';
import { ABI, GENESIS, NETWORK, TOKEN_PROGRAM, validateProfile, assertUpstreamProfile } from '../profile.mjs';
import { Merchant } from '../merchant.mjs';
import { BuyerSession } from '../buyer.mjs';

const payer = '11111111111111111111111111111112', merchant = '11111111111111111111111111111113';
const profile = { schema: 1, name: 'devnet', network: NETWORK, genesisHash: GENESIS,
  programId: '11111111111111111111111111111114', programDataAddress: '11111111111111111111111111111115',
  executableSha256: 'ab'.repeat(32), deploymentSlot: '42', upgradeAuthority: null, abiCommit: ABI,
  mint: MINT, tokenProgram: TOKEN_PROGRAM, payer, merchant };
const rows = [{ id: 'invoice-1', category: 'compute', amount: '650' }];
const tx = '1'.repeat(88), captureTx = '2'.repeat(88);
const ok = data => ({ structuredContent: { ok: true, ...data } });

for (const field of ['network', 'genesisHash', 'programId', 'programDataAddress', 'mint', 'payer', 'merchant', 'executableSha256', 'upgradeAuthority', 'deploymentSlot']) {
  test(`runtime ${field} mismatch refuses the profile before economics`, () => {
    assert.throws(() => assertUpstreamProfile(profile, { backend: 'devnet', profile: { ...profile, [field]: 'different' } }), /PAYMENT_PROFILE_DIFFERS/);
  });
}
test('profile rejects a changed role, mint or network before a client is built', () => {
  for (const changes of [{ payer: merchant }, { mint: payer }, { network: 'solana:mainnet' }, { name: 'custom' }]) {
    assert.throws(() => validateProfile({ ...profile, ...changes }, payer, merchant), /PAYMENT_PROFILE_DIFFERS/);
  }
});
test('the actual client refuses a different runtime deployment before connecting or sending a tool', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-client-admission-')), path = join(dir, 'profile.json');
  writeFileSync(path, JSON.stringify(profile), { mode: 0o600 });
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    reads++; assert.equal(options.method, undefined);
    return { ok: true, json: async () => ({ backend: 'devnet', profile: { ...profile, programId: merchant } }) };
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(paymentClient({ PAYMENT_PROFILE: 'devnet', PAYMENT_PROFILE_FILE: path,
    REPORT_PAYER: payer, REPORT_MERCHANT: merchant, PAYMENT_MCP_URL: 'http://127.0.0.1:1/mcp',
    SINGIT_BUYER_TOKEN: 'synthetic-buyer-token', SINGIT_MERCHANT_TOKEN: 'synthetic-merchant-token' }, 'buyer'), /PAYMENT_PROFILE_DIFFERS/);
  assert.equal(reads, 1);
});

function fixture(t, fault) {
  const dir = mkdtempSync(join(tmpdir(), 'merchant-devnet-profile-'));
  const store = new Store(join(dir, 'merchant'));
  let captures = 0;
  const hold = { id: 'h-1', payer, payee: merchant, mint: MINT, held: MAXIMUM, captured: '0', refunded: '0',
    captureDeadline: Math.floor(Date.now() / 1000) + 600, txSigs: [tx] };
  const operations = {
    'op-hold': { id: 'op-hold', action: 'hold', actor: payer, mandateId: 'm-1', holdId: hold.id,
      state: 'succeeded', params: { amount: MAXIMUM }, prepared: { txSig: tx }, result: { txSig: tx } },
    'op-capture': { id: 'op-capture', action: 'capture', actor: merchant, mandateId: 'm-1', holdId: hold.id,
      state: 'succeeded', params: { amount: PRICE }, expected: { held: '0', refundable: PRICE },
      prepared: { txSig: captureTx }, result: { txSig: captureTx } },
  };
  fault?.(operations);
  const payments = { async callTool({ name, arguments: input }) {
    if (name === 'get_mandate') return ok({ mandate: { payer }, holds: [hold] });
    if (name === 'get_operation') return ok({ operation: operations[input.operationId] });
    assert.equal(name, 'capture'); captures++;
    Object.assign(hold, { held: '0', captured: PRICE });
    return ok({ operationId: 'op-capture', hold, txSig: captureTx });
  } };
  const seller = new Merchant({ store, payments, payer, merchant, profile: validateProfile(profile, payer, merchant) });
  const quote = seller.quote({ intent: 'devnet-synthetic-intent', mandateId: 'm-1', rows });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, seller, quote, captures: () => captures };
}
test('devnet delivery binds both original operations, identity and digest and replays exact bytes', async t => {
  const f = fixture(t), args = { orderId: f.quote.orderId, holdId: 'h-1', holdOperationId: 'op-hold' };
  const result = await f.seller.purchase(args);
  assert.deepEqual(result.receipt.identity, profile);
  assert.deepEqual(result.receipt.authorize, { operationId: 'op-hold', txSig: tx, commitment: 'finalized', err: null });
  assert.deepEqual(result.receipt.capture, { operationId: 'op-capture', txSig: captureTx, commitment: 'finalized', err: null });
  assert.equal(result.receipt.artifactSha256, result.artifact.sha256);
  assert.equal(JSON.stringify(await f.seller.purchase(args)), JSON.stringify(result));
  assert.equal(f.captures(), 1);
});
test('unproven authorization cannot reach merchant capture', async t => {
  const f = fixture(t, ops => { ops['op-hold'].state = 'unknown'; });
  await assert.rejects(f.seller.purchase({ orderId: f.quote.orderId, holdId: 'h-1', holdOperationId: 'op-hold' }), /OUTCOME_NOT_PROVEN/);
  assert.equal(f.captures(), 0);
});
test('unproven capture withholds delivery and cannot cause another capture', async t => {
  const f = fixture(t, ops => { ops['op-capture'].result.txSig = tx; });
  const args = { orderId: f.quote.orderId, holdId: 'h-1', holdOperationId: 'op-hold' };
  await assert.rejects(f.seller.purchase(args), /PURCHASE_UNRESOLVED/);
  await assert.rejects(f.seller.purchase(args), /ORIGINAL_OPERATION_UNRESOLVED/);
  assert.equal(f.seller.status(args.orderId).artifact, undefined);
  assert.equal(f.captures(), 1);
});
test('a pre-state or non-atomic capture cannot be mistaken for the service post-state receipt', async t => {
  const f = fixture(t, ops => { ops['op-capture'].expected = { held: MAXIMUM, refundable: '0' }; });
  await assert.rejects(f.seller.purchase({ orderId: f.quote.orderId, holdId: 'h-1', holdOperationId: 'op-hold' }), /PURCHASE_UNRESOLVED/);
  assert.equal(f.captures(), 1);
  assert.equal(f.seller.status(f.quote.orderId).artifact, undefined);
});
test('buyer rejects all model-supplied identities, budgets and keys before any tool call', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'buyer-intent-profile-')), store = new Store(dir);
  let calls = 0;
  const unavailable = { async callTool() { calls++; throw Error('must not call'); } };
  const session = new BuyerSession({ payments: unavailable, merchant: unavailable, store, intent: 'bound-synthetic-intent', mandateId: 'm-1', payer, payee: merchant, rows });
  t.after(() => { session.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  for (const args of [{ payer: merchant }, { amount: '1' }, { mandateId: 'another' }, { idempotencyKey: 'replacement' }]) {
    await assert.rejects(session.step('hold_report', args), /TRUSTED_INTENT_ONLY/);
  }
  await assert.rejects(session.step('create_mandate'), /UNKNOWN_TOOL/);
  assert.equal(calls, 0);
});
