import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { outsideGit } from './run-config.mjs';

function privateDirectory(path) {
  if (!isAbsolute(path ?? '') || realpathSync(path) !== resolve(path)) throw Error('PRIVATE_RUN_REQUIRED');
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('PRIVATE_RUN_REQUIRED');
  outsideGit(path);
  return stat;
}

/** Exclusively create and durably name a directory beneath an existing private parent. */
export function createPrivateDirectory(path) {
  const parentPath = dirname(path), parent = privateDirectory(parentPath);
  mkdirSync(path, { mode: 0o700 });
  // Syncing files inside a new directory does not make its name durable in its parent.
  let fd;
  try {
    fd = openSync(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd), current = privateDirectory(parentPath);
    if (opened.dev !== parent.dev || opened.ino !== parent.ino ||
        current.dev !== parent.dev || current.ino !== parent.ino) throw Error('EVIDENCE_UNAVAILABLE');
    fsyncSync(fd);
  } catch { throw Error('EVIDENCE_UNAVAILABLE'); }
  finally { if (fd !== undefined) closeSync(fd); }
  privateDirectory(path);
}

/** Exclusive new run, including a fresh HOME for tools. Never opens a previous run. */
export function createEvidence(path) {
  createPrivateDirectory(path);
  mkdirSync(join(path, 'tools-home'), { mode: 0o700 });
  return new SyncedLog(join(path, 'model-tool-trace.jsonl'), true);
}

/** Append-only execution evidence / inference admission, never a payment journal. */
export class SyncedLog {
  constructor(path, create = false) {
    this.path = path;
    this.parent = privateDirectory(dirname(path));
    this.fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW |
      (create ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
    try {
      this.stat = fstatSync(this.fd);
      this.check();
      if (create) this.syncParent();
    } catch (error) { this.close(); throw error; }
  }
  check() {
    const stat = fstatSync(this.fd), current = lstatSync(this.path), parent = privateDirectory(dirname(this.path));
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) ||
        stat.dev !== this.stat.dev || stat.ino !== this.stat.ino || stat.size !== this.stat.size ||
        stat.mtimeMs !== this.stat.mtimeMs || stat.ctimeMs !== this.stat.ctimeMs ||
        current.dev !== stat.dev || current.ino !== stat.ino || stat.size > 1024 * 1024 ||
        parent.dev !== this.parent.dev || parent.ino !== this.parent.ino) throw Error('EVIDENCE_UNAVAILABLE');
  }
  read() {
    this.check();
    const text = readFileSync(this.path, 'utf8');
    this.check();
    if (!text.endsWith('\n')) throw Error('EVIDENCE_UNAVAILABLE');
    return text.trimEnd().split('\n').map(line => JSON.parse(line));
  }
  syncParent() {
    const fd = openSync(dirname(this.path), 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  append(value) {
    if (this.failed) throw Error('EVIDENCE_UNAVAILABLE');
    try {
      this.check();
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      if (this.stat.size + bytes.length > 1024 * 1024) throw Error('EVIDENCE_UNAVAILABLE');
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(this.fd, bytes, offset, bytes.length - offset);
        if (!written) throw Error('EVIDENCE_UNAVAILABLE');
        offset += written;
      }
      fsyncSync(this.fd);
      this.stat = fstatSync(this.fd);
      this.check();
    } catch { this.failed = true; throw Error('EVIDENCE_UNAVAILABLE'); }
  }
  close() { if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; } }
}

function binding(settings) {
  return { schema: 1, provider: 'bedrock', awsProfile: settings.awsProfile,
    credentialProvider: settings.credentialProvider ?? 'sso', region: settings.region,
    modelId: settings.modelId, deadlineMs: settings.deadlineMs, maxAttempts: 12 };
}

export function initializeAdmission(settings) {
  const log = new SyncedLog(settings.admissionPath, true);
  try { log.append(binding(settings)); } finally { log.close(); }
}

export class InferenceAdmission {
  constructor(settings, mode) {
    if (!['buyer', 'smoke'].includes(mode)) throw Error('ADMISSION_REFUSED');
    this.settings = settings;
    this.lockPath = `${settings.admissionPath}.lock`;
    privateDirectory(dirname(this.lockPath));
    this.lock = openSync(this.lockPath, 'wx', 0o600);
    this.lockStat = fstatSync(this.lock);
    try {
      fsyncSync(this.lock);
      this.log = new SyncedLog(settings.admissionPath);
      const rows = this.log.read();
      if (JSON.stringify(rows.shift()) !== JSON.stringify(binding(settings))) throw Error('ADMISSION_REFUSED');
      let buyerStarted = false;
      this.used = 0;
      for (const row of rows) {
        if (row.event === 'buyer_started' && !buyerStarted && Object.keys(row).length === 1) buyerStarted = true;
        else if (row.event === 'attempt' && row.attempt === this.used + 1 && Object.keys(row).length === 2) this.used++;
        else throw Error('ADMISSION_REFUSED'); // Includes a previous stop or corrupt/partial history.
      }
      if (this.used > 12 || Date.now() >= settings.deadlineMs || buyerStarted ||
          (mode === 'buyer' && 12 - this.used < settings.limits.maxCalls)) throw Error('ADMISSION_REFUSED');
      if (mode === 'buyer') this.log.append({ event: 'buyer_started' });
    } catch (error) { this.close(); throw error; }
  }
  check() {
    const current = lstatSync(this.lockPath, { throwIfNoEntry: false });
    if (!current?.isFile() || current.dev !== this.lockStat.dev || current.ino !== this.lockStat.ino ||
        current.nlink !== 1 || current.uid !== process.getuid() || (current.mode & 0o077)) throw Error('EVIDENCE_UNAVAILABLE');
    this.log.check();
  }
  consume() {
    this.check();
    if (Date.now() >= this.settings.deadlineMs || this.used >= 12) throw Error('ATTEMPT_LIMIT');
    this.log.append({ event: 'attempt', attempt: this.used + 1 });
    this.used++;
  }
  stop() { this.check(); this.log.append({ event: 'stopped' }); }
  close() {
    this.log?.close();
    if (this.lock !== undefined) {
      closeSync(this.lock); this.lock = undefined;
      const current = lstatSync(this.lockPath, { throwIfNoEntry: false });
      if (current?.dev === this.lockStat.dev && current?.ino === this.lockStat.ino) unlinkSync(this.lockPath);
    }
  }
}
