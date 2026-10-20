import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { digest, MAXIMUM, MINT, normalizeRows, paymentClient, PRICE, Store, tool } from './common.mjs';
import { mockProfile, profileDigest, profileFromEnv, validateProfile } from './profile.mjs';
import { proveOperation } from './proof.mjs';

const activeStores = new WeakSet();

/** Trusted intent holder. The model selects steps, never wallet/mandate/amount/key inputs. */
export class BuyerSession {
  busy = false;
  constructor({ payments, merchant, store, intent, mandateId, payer, payee, rows,
    profile = mockProfile(payer, payee), captureDeadline, refundDeadline }) {
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(intent)) throw Error('STABLE_INTENT_REQUIRED');
    if (profile.name !== 'mock') validateProfile(profile, payer, payee);
    const input = normalizeRows(rows), id = digest(['buyer-report-v1', payer, intent]);
    const commitment = digest([mandateId, payer, payee, input, profileDigest(profile), captureDeadline ?? null, refundDeadline ?? null]);
    const record = store.read(id);
    const legacy = profile.name === 'mock' && record && !record.profile && record.commitment === digest([mandateId, payer, payee, input]);
    if (record && record.commitment !== commitment && !legacy) throw Error('INTENT_CONFLICT');
    if (activeStores.has(store) || (record?.stage !== 'done' && (record || store.blocked))) throw Error('ORIGINAL_OPERATION_UNRESOLVED');
    Object.assign(this, { payments, merchant, store, intent, mandateId, payer, payee, input, id, commitment,
      profile, captureDeadline, refundDeadline, record });
    activeStores.add(store);
  }
  close() { activeStores.delete(this.store); }
  async step(name, args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw Error('TRUSTED_INTENT_ONLY');
    if (this.busy) throw Error('ORIGINAL_OPERATION_UNRESOLVED');
    this.busy = true;
    try {
      if (name === 'quote_report') return await this.quote();
      if (name === 'hold_report') return await this.hold();
      if (name === 'purchase_report') return await this.purchase();
      if (name === 'get_report') return await this.result();
      throw Error('UNKNOWN_TOOL');
    } finally { this.busy = false; }
  }
  async quote() {
    if (this.record) return this.record.quote;
    const quote = await tool(this.merchant, 'quote_report', { intent: this.intent, mandateId: this.mandateId, rows: this.input });
    if (quote.payer !== this.payer || quote.merchant !== this.payee || quote.mint !== MINT || quote.maximum !== MAXIMUM ||
        quote.price !== PRICE || quote.inputSha256 !== digest(this.input) ||
        quote.profileSha256 !== profileDigest(this.profile)) throw Error('QUOTE_DIFFERS');
    this.record = { schema: 1, id: this.id, commitment: this.commitment, profile: this.profile, stage: 'quoted', quote };
    this.store.save(this.record);
    return quote;
  }
  async hold() {
    const record = this.record;
    if (!record) throw Error('QUOTE_REQUIRED');
    if (record.stage === 'done') return record.held;
    if (record.stage === 'held' && !this.store.blocked) return record.held;
    if (record.stage !== 'quoted' || this.store.blocked) throw Error('ORIGINAL_OPERATION_UNRESOLVED');
    record.stage = 'hold_pending'; this.store.save(record);
    try {
      const held = await tool(this.payments, 'hold', { actor: this.payer, mandateId: this.mandateId, payee: this.payee,
        amount: MAXIMUM, mint: MINT, idempotencyKey: `report:${record.quote.orderId}:hold`,
        ...(this.captureDeadline === undefined ? {} : { captureDeadline: this.captureDeadline, refundDeadline: this.refundDeadline }) });
      if (typeof held.hold?.id !== 'string') throw Error('HOLD_UNPROVEN');
      if (this.profile.name === 'devnet') await proveOperation(this.payments, held.operationId,
        { action: 'hold', profile: this.profile, mandateId: this.mandateId, holdId: held.hold.id, txSig: held.txSig });
      record.holdId = held.hold.id; record.held = held; record.stage = 'held'; this.store.save(record);
      return held;
    } catch {
      this.store.blocked = true;
      throw Error('PURCHASE_UNRESOLVED_NO_RETRY');
    }
  }
  validateResult(result) {
    const record = this.record;
    if (result.orderId !== record.quote.orderId || result.stage !== 'done' || result.receipt?.profile !== this.profile.name ||
        result.receipt?.holdId !== record.holdId || result.receipt?.grossCaptured !== PRICE || result.receipt?.released !== '350000' ||
        result.receipt?.profileSha256 !== profileDigest(this.profile) ||
        (this.profile.name === 'devnet' && (result.receipt?.authorize?.operationId !== record.held.operationId ||
          result.receipt?.authorize?.txSig !== record.held.txSig || !result.receipt?.capture?.operationId ||
          result.receipt?.capture?.txSig !== result.receipt?.txSig)) ||
        result.artifact?.sha256 !== record.quote.artifactSha256 || typeof result.artifact?.utf8 !== 'string' ||
        createHash('sha256').update(result.artifact.utf8).digest('hex') !== result.artifact.sha256) throw Error('ARTIFACT_DIFFERS');
  }
  async purchase() {
    const record = this.record;
    if (record?.stage === 'done') return record.result;
    if (record?.stage !== 'held' || this.store.blocked) throw Error('ORIGINAL_OPERATION_UNRESOLVED');
    record.stage = 'purchase_pending'; this.store.save(record);
    try {
      const result = await tool(this.merchant, 'purchase_report', { orderId: record.quote.orderId, holdId: record.holdId,
        ...(record.held.operationId ? { holdOperationId: record.held.operationId } : {}) });
      this.validateResult(result);
      const completed = { ...record, stage: 'done', result };
      this.store.save(completed); this.record = completed;
      return result;
    } catch {
      this.store.blocked = true;
      throw Error('PURCHASE_UNRESOLVED_NO_RETRY');
    }
  }
  async result() {
    if (this.record?.stage !== 'done') throw Error('DURABLE_COMPLETION_REQUIRED');
    const result = await tool(this.merchant, 'get_report', { orderId: this.record.quote.orderId });
    if (JSON.stringify(result) !== JSON.stringify(this.record.result)) throw Error('ARTIFACT_DIFFERS');
    return result;
  }
}

export async function buy(args) {
  const session = new BuyerSession(args);
  try {
    if (session.record?.stage === 'done') return session.record.result;
    await session.step('quote_report'); await session.step('hold_report');
    return await session.step('purchase_report');
  } finally { session.close(); }
}

export function merchantProcessEnv(source) {
  // The child receives only its own role token, never buyer or human credentials.
  return Object.fromEntries(['PATH', 'HOME', 'PAYMENT_PROFILE', 'PAYMENT_PROFILE_FILE', 'PAYMENT_MCP_URL', 'MERCHANT_STATE_DIR', 'REPORT_PAYER', 'REPORT_MERCHANT', 'SINGIT_MERCHANT_TOKEN']
    .filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}

async function main() {
  const [inputPath, mandateId, intent] = process.argv.slice(2);
  if (!inputPath || !mandateId || !intent) throw Error('INPUT_MANDATE_INTENT_REQUIRED');
  const payments = await paymentClient(process.env, 'buyer');
  const store = new Store(process.env.BUYER_STATE_DIR);
  const merchant = new Client({ name: 'expense-report-buyer', version: '0.1.0' });
  const env = merchantProcessEnv(process.env);
  try {
    await merchant.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./merchant.mjs', import.meta.url))], env, stderr: 'pipe' }));
    const result = await buy({ payments, merchant, store, intent, mandateId, payer: process.env.REPORT_PAYER,
      payee: process.env.REPORT_MERCHANT, profile: profileFromEnv(process.env), rows: JSON.parse(readFileSync(inputPath, 'utf8')) });
    console.log(JSON.stringify(result));
  } finally { await merchant.close().catch(() => {}); await payments.close().catch(() => {}); store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Buyer stopped; preserve original intent and private state. No automatic retry.'); process.exit(1); });
}
