import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { assertUpstreamProfile, profileFromEnv } from './profile.mjs';

export { MINT, MAXIMUM, PRICE } from './profile.mjs';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const profileGuards = new WeakMap();

export function normalizeRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 200) throw Error('INVALID_ROWS');
  return rows.map(row => {
    if (!row || Object.keys(row).sort().join() !== 'amount,category,id' ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(row.id) || typeof row.category !== 'string' ||
        !/^[A-Za-z0-9 _-]{1,64}$/.test(row.category) || typeof row.amount !== 'string' ||
        !/^(0|[1-9][0-9]{0,17})$/.test(row.amount)) throw Error('INVALID_ROWS');
    return { id: row.id, category: row.category, amount: row.amount };
  });
}

export function report(rows) {
  const normalized = normalizeRows(rows);
  const ids = new Set(), duplicates = [], totals = new Map();
  let total = 0n;
  for (const row of normalized) {
    if (ids.has(row.id)) duplicates.push(row.id);
    ids.add(row.id);
    const value = BigInt(row.amount);
    total += value;
    totals.set(row.category, (totals.get(row.category) ?? 0n) + value);
  }
  const result = { schema: 1, kind: 'expense-quality-report', inputSha256: digest(normalized),
    rowCount: rows.length, uniqueIds: ids.size, duplicateIds: [...new Set(duplicates)].sort(),
    total: total.toString(), categories: Object.fromEntries([...totals].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, v.toString()])),
    amountUnit: 'caller-supplied integer units; duplicate rows are included in totals' };
  const utf8 = JSON.stringify(result);
  return { input: normalized, artifact: { mimeType: 'application/json', utf8,
    sha256: createHash('sha256').update(utf8).digest('hex') } };
}

function syncDirectory(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** One process owns each private application store. This is not wallet custody. */
export class Store {
  blocked = false;
  constructor(path) {
    if (!isAbsolute(path ?? '') || path === parse(path).root) throw Error('PRIVATE_STORE_REQUIRED');
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (lstatSync(path).isSymbolicLink() || (lstatSync(path).mode & 0o077)) throw Error('PRIVATE_STORE_REQUIRED');
    this.path = realpathSync(path);
    for (let p = this.path; ; p = dirname(p)) {
      if (existsSync(join(p, '.git'))) throw Error('STORE_MUST_BE_OUTSIDE_GIT');
      if (p === dirname(p)) break;
    }
    this.lock = join(this.path, '.lock');
    this.fd = openSync(this.lock, 'wx', 0o600);
    this.lockIdentity = fstatSync(this.fd);
    writeFileSync(this.fd, `${process.pid}\n`);
    fsyncSync(this.fd);
    // Any interrupted application operation blocks new purchases, not just its own key.
    this.blocked = this.all().some(record => ['hold_pending', 'held', 'purchase_pending', 'capture_pending', 'unknown'].includes(record.stage));
  }
  read(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error('INVALID_ORDER');
    // A completion candidate cannot supersede its original pending record until committed.
    const pending = join(this.path, `${id}.pending.json`);
    const file = existsSync(pending) ? pending : join(this.path, `${id}.json`);
    if (!existsSync(file)) return undefined;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077)) throw Error('INVALID_PRIVATE_RECORD');
    const record = JSON.parse(readFileSync(file, 'utf8'));
    if (record.id !== id || record.schema !== 1 || !['quoted', 'prepared', 'hold_pending', 'held', 'purchase_pending', 'capture_pending', 'unknown', 'done'].includes(record.stage)) throw Error('INVALID_PRIVATE_RECORD');
    return record;
  }
  all() {
    const ids = new Set(readdirSync(this.path).map(name => /^([a-f0-9]{64})(?:\.pending)?\.json$/.exec(name)?.[1]).filter(Boolean));
    return [...ids].map(id => this.read(id));
  }
  save(record) {
    if (!/^[a-f0-9]{64}$/.test(record.id)) throw Error('INVALID_ORDER');
    const file = join(this.path, `${record.id}.json`);
    const pending = join(this.path, `${record.id}.pending.json`);
    const temp = join(this.path, `${record.id}.${randomUUID()}.tmp`);
    let fd;
    try {
      if (existsSync(pending)) throw Error('ORIGINAL_OPERATION_UNRESOLVED');
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); closeSync(fd); fd = undefined;
      if (record.stage === 'done') {
        // Keep the original attempt durable and readable across any failed terminal write.
        renameSync(file, pending);
        syncDirectory(this.path);
      }
      renameSync(temp, file);
      syncDirectory(this.path);
      if (record.stage === 'done') {
        unlinkSync(pending);
        // Completion is already durable. A failed cleanup flush can only restore the
        // conservative pending guard after a crash; it cannot admit an unflushed result.
        try { syncDirectory(this.path); } catch {}
      }
    } catch {
      this.blocked = true;
      if (fd !== undefined) closeSync(fd);
      throw Error('STORE_FAILED_PRESERVE_ORIGINALS');
    }
  }
  close() {
    if (this.fd === undefined) return;
    closeSync(this.fd); this.fd = undefined;
    const current = lstatSync(this.lock, { throwIfNoEntry: false });
    if (current?.dev === this.lockIdentity.dev && current?.ino === this.lockIdentity.ino) unlinkSync(this.lock);
  }
}

export async function tool(client, name, args) {
  if (['hold', 'capture', 'release'].includes(name) && (typeof args?.idempotencyKey !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(args.idempotencyKey))) throw Error('IDEMPOTENCY_KEY_REQUIRED');
  await profileGuards.get(client)?.();
  const result = await client.callTool({ name, arguments: args });
  const data = result.structuredContent ?? JSON.parse(result.content?.find(item => item.type === 'text')?.text ?? '{}');
  if (result.isError || data.ok !== true) throw Error(typeof data.code === 'string' && /^[A-Z_]{1,80}$/.test(data.code) ? data.code : 'MCP_REFUSED');
  return data;
}

/** Both profiles use the authenticated local service; credentials stay outside the model. */
export async function paymentClient(env, role) {
  if (role !== 'buyer' && role !== 'merchant') throw Error('PAYMENT_ROLE_REQUIRED');
  // Preserve the explicit profile opt-in and refuse an incomplete live selection.
  if (env.PAYMENT_PROFILE !== 'mock' && env.PAYMENT_PROFILE !== 'devnet') throw Error('LIVE_BLOCKED_PENDING_MVP_01_TO_06');
  const profile = env.PAYMENT_PROFILE === 'devnet' ? profileFromEnv(env) : { name: 'mock' };
  const token = env[role === 'buyer' ? 'SINGIT_BUYER_TOKEN' : 'SINGIT_MERCHANT_TOKEN'];
  if (typeof token !== 'string' || !/^[\x21-\x7e]{16,4096}$/.test(token)) throw Error('PAYMENT_TOKEN_REQUIRED');
  if (env.SINGIT_BUYER_TOKEN === env.SINGIT_MERCHANT_TOKEN) throw Error('SEPARATE_PAYMENT_TOKENS_REQUIRED');
  const url = new URL(env.PAYMENT_MCP_URL);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) throw Error('LOOPBACK_MOCK_REQUIRED');
  const headers = { Authorization: `Bearer ${token}` };
  const check = async () => {
    const state = await fetch(new URL('/api/state', url), { headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!state.ok) throw Error('PAYMENT_PROFILE_DIFFERS');
    assertUpstreamProfile(profile, await state.json());
  };
  await check();
  const client = new Client({ name: 'capture402-merchant-example', version: '0.1.0' });
  try { await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers, redirect: 'error' } })); profileGuards.set(client, check); return client; }
  catch { await client.close().catch(() => {}); throw Error('MCP_UNAVAILABLE'); }
}
