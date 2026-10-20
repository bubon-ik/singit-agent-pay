import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { digest, MAXIMUM, MINT, paymentClient, PRICE, report, Store, tool } from './common.mjs';
import { mockProfile, profileDigest, profileFromEnv, validateProfile } from './profile.mjs';
import { proveOperation } from './proof.mjs';

export class Merchant {
  busy = false;
  constructor({ store, payments, payer, merchant, profile = mockProfile(payer, merchant) }) {
    if (!payer || !merchant || payer === merchant) throw Error('SEPARATE_ROLES_REQUIRED');
    if (profile.name !== 'mock') validateProfile(profile, payer, merchant);
    Object.assign(this, { store, payments, payer, merchant, profile });
  }
  quote({ intent, mandateId, rows }) {
    const { input, artifact } = report(rows);
    const id = digest(['merchant-report-v1', this.payer, intent]);
    const commitment = digest([mandateId, input, this.payer, this.merchant, MINT, MAXIMUM, PRICE, profileDigest(this.profile)]);
    let record = this.store.read(id);
    const legacy = this.profile.name === 'mock' && record && !record.profile &&
      record.commitment === digest([mandateId, input, this.payer, this.merchant, MINT, MAXIMUM, PRICE]);
    if (record && record.commitment !== commitment && !legacy) throw Error('INTENT_CONFLICT');
    if (!record) {
      if (this.store.blocked) throw Error('ORIGINAL_OPERATION_UNRESOLVED');
      record = { schema: 1, id, commitment, intent, mandateId, profile: this.profile, stage: 'quoted', artifact };
      this.store.save(record);
    }
    return { ok: true, orderId: id, maximum: MAXIMUM, price: PRICE, mint: MINT,
      payer: this.payer, merchant: this.merchant, profile: this.profile, profileSha256: profileDigest(this.profile),
      inputSha256: digest(input), artifactSha256: artifact.sha256 };
  }
  status(orderId) {
    const record = this.store.read(orderId);
    if (!record) throw Error('ORDER_NOT_FOUND');
    if (record.profile && profileDigest(record.profile) !== profileDigest(this.profile)) throw Error('PAYMENT_PROFILE_DIFFERS');
    return record.stage === 'done' ? { ok: true, orderId, stage: record.stage, artifact: record.artifact, receipt: record.receipt }
      : { ok: true, orderId, stage: record.stage, nextAction: 'Observe original payment; never retry a purchase after uncertainty.' };
  }
  async purchase({ orderId, holdId, holdOperationId }) {
    const record = this.store.read(orderId);
    if (!record) throw Error('ORDER_NOT_FOUND');
    if (record.profile && profileDigest(record.profile) !== profileDigest(this.profile)) throw Error('PAYMENT_PROFILE_DIFFERS');
    if (record.holdId && record.holdId !== holdId) throw Error('HOLD_CONFLICT');
    if (record.stage === 'done') return this.status(orderId);
    if (this.busy || this.store.blocked || record.stage !== 'quoted') throw Error('ORIGINAL_OPERATION_UNRESOLVED');
    this.busy = true;
    try {
      if (this.store.all().some(other => other.id !== orderId && other.holdId === holdId)) throw Error('HOLD_ALREADY_BOUND');
      const state = await tool(this.payments, 'get_mandate', { mandateId: record.mandateId });
      const hold = state.holds?.find(item => item.id === holdId);
      if (!hold || state.mandate?.payer !== this.payer || hold.payer !== this.payer || hold.payee !== this.merchant ||
          hold.mint !== MINT || hold.held !== MAXIMUM || hold.captured !== '0' || hold.refunded !== '0' ||
          hold.quarantined || hold.disputeId || hold.captureDeadline <= Math.floor(Date.now() / 1000)) throw Error('PAYMENT_TERMS_DIFFER');
      const authorize = this.profile.name === 'devnet'
        ? await proveOperation(this.payments, holdOperationId, { action: 'hold', profile: this.profile,
          mandateId: record.mandateId, holdId, txSig: hold.txSigs?.[0] }) : undefined;
      record.holdId = holdId;
      record.authorize = authorize;
      record.stage = 'capture_pending';
      this.store.save(record); // Durable application attempt before the one MCP call.
      try {
        const result = await tool(this.payments, 'capture', { actor: this.merchant, holdId, amount: PRICE,
          releaseRemainder: true, idempotencyKey: `report:${orderId}:capture` });
        if (result.hold?.id !== holdId || result.hold?.held !== '0' || result.hold?.captured !== PRICE ||
            result.hold?.refunded !== '0' || typeof result.txSig !== 'string' || !result.txSig) throw Error('OUTCOME_NOT_PROVEN');
        const capture = this.profile.name === 'devnet'
          ? await proveOperation(this.payments, result.operationId, { action: 'capture', profile: this.profile,
            mandateId: record.mandateId, holdId, txSig: result.txSig }) : undefined;
        record.stage = 'done';
        record.receipt = { profile: this.profile.name, identity: this.profile, profileSha256: profileDigest(this.profile),
          holdId, authorize, capture, txSig: result.txSig, grossCaptured: PRICE, released: '350000',
          artifactSha256: record.artifact.sha256 };
        this.store.save(record);
      } catch {
        this.store.blocked = true; // Pending record remains original evidence, even if a later write fails.
        throw Error('PURCHASE_UNRESOLVED_NO_RETRY');
      }
      return this.status(orderId);
    } finally { this.busy = false; }
  }
}

export function merchantServer(merchant) {
  const server = new McpServer({ name: 'capture402-expense-report', version: '0.1.0' });
  const key = z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/);
  const order = z.string().regex(/^[a-f0-9]{64}$/);
  const wrap = fn => async args => {
    try {
      const data = await fn(args);
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    } catch (error) {
      const code = /^[A-Z_]{1,80}$/.test(error?.message ?? '') ? error.message : 'MERCHANT_UNAVAILABLE';
      const data = { ok: false, code };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    }
  };
  server.registerTool('quote_report', { description: 'Quote an exact expense-quality report; creates no payment.', inputSchema: {
    intent: key, mandateId: z.string().min(1).max(128), rows: z.array(z.object({ id: z.string(), category: z.string(), amount: z.string() })).min(1).max(200),
  } }, wrap(args => merchant.quote(args)));
  server.registerTool('purchase_report', { description: 'Capture 0.65 USDC in the selected profile and atomically release 0.35 from one existing 1-USDC hold. Never retry after uncertainty.',
    inputSchema: { orderId: order, holdId: z.string().min(1).max(128), holdOperationId: z.string().min(1).max(128).optional() } }, wrap(args => merchant.purchase(args)));
  server.registerTool('get_report', { description: 'Read an existing order and replay identical purchased bytes; never sends a payment.',
    inputSchema: { orderId: order } }, wrap(({ orderId }) => merchant.status(orderId)));
  return server;
}

async function main() {
  const payments = await paymentClient(process.env, 'merchant');
  const store = new Store(process.env.MERCHANT_STATE_DIR);
  const merchant = new Merchant({ payments, store, payer: process.env.REPORT_PAYER, merchant: process.env.REPORT_MERCHANT,
    profile: profileFromEnv(process.env) });
  const server = merchantServer(merchant);
  const close = async () => { await server.close().catch(() => {}); await payments.close().catch(() => {}); store.close(); };
  process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
  process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
  await server.connect(new StdioServerTransport());
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Merchant unavailable; inspect private configuration and original records.'); process.exit(1); });
}
