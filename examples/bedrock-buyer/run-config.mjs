import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export const BUYER_ENV = ['PAYMENT_PROFILE', 'PAYMENT_PROFILE_FILE', 'PAYMENT_MCP_URL', 'REPORT_PAYER', 'REPORT_MERCHANT',
  'BUYER_STATE_DIR', 'MERCHANT_STATE_DIR', 'REPORT_CAPTURE_DEADLINE', 'REPORT_REFUND_DEADLINE',
  'SINGIT_BUYER_TOKEN', 'SINGIT_MERCHANT_TOKEN'];
export const STEPS = Object.freeze(['quote_report', 'hold_report', 'purchase_report', 'get_report']);

export function outsideGit(path) {
  for (let parent = path; ; parent = dirname(parent)) {
    if (existsSync(join(parent, '.git'))) throw Error('PRIVATE_RUN_REQUIRED');
    if (parent === dirname(parent)) break;
  }
}

export function readPrivateJson(path) {
  if (!isAbsolute(path ?? '')) throw Error('PRIVATE_RUN_REQUIRED');
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid() ||
      (info.mode & 0o077) || info.size > 65536) throw Error('PRIVATE_RUN_REQUIRED');
  outsideGit(dirname(realpathSync(path)));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    const value = readFileSync(fd, 'utf8');
    const after = fstatSync(fd), current = lstatSync(path);
    if (opened.dev !== info.dev || opened.ino !== info.ino || after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs || current.dev !== info.dev || current.ino !== info.ino) throw Error('PRIVATE_RUN_REQUIRED');
    return JSON.parse(value);
  } finally { closeSync(fd); }
}

export function readRunConfig(path) {
  const value = readPrivateJson(path);
  if (value.schema !== 1 || typeof value.environment !== 'object' || !value.environment || Array.isArray(value.environment) ||
      Object.entries(value.environment).some(([key, item]) => !BUYER_ENV.includes(key) || typeof item !== 'string') ||
      !isAbsolute(value.inputPath ?? '') || !isAbsolute(value.evidenceDir ?? '') ||
      typeof value.mandateId !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(value.intent)) throw Error('PRIVATE_RUN_REQUIRED');
  return value;
}

export function buyerProcessEnv(config, source = process.env) {
  return Object.fromEntries(['PATH', 'HOME', ...BUYER_ENV]
    .filter(key => (BUYER_ENV.includes(key) ? config.environment[key] : source[key]) !== undefined)
    .map(key => [key, BUYER_ENV.includes(key) ? config.environment[key] : source[key]]));
}
