import { lstatSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';

export const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const MAXIMUM = '1000000';
export const PRICE = '650000';

export const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const NETWORK = `solana:${GENESIS.slice(0, 32)}`;
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ABI = '236b09a44240d285ee6f33d2e8dac79f81058e3d';
export const PROFILE_FIELDS = ['schema', 'name', 'network', 'genesisHash', 'programId', 'programDataAddress',
  'executableSha256', 'deploymentSlot', 'upgradeAuthority', 'abiCommit', 'mint', 'tokenProgram', 'payer', 'merchant'];
const publicKey = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);

export function mockProfile(payer, merchant) {
  return Object.freeze({ schema: 1, name: 'mock', network: 'mock:local', genesisHash: null,
    programId: null, programDataAddress: null, executableSha256: null, deploymentSlot: null,
    upgradeAuthority: null, abiCommit: null, mint: MINT, tokenProgram: TOKEN_PROGRAM, payer, merchant });
}

export function validateProfile(input, payer, merchant) {
  if (!input || Object.keys(input).sort().join() !== [...PROFILE_FIELDS].sort().join() || input.schema !== 1 ||
      input.name !== 'devnet' || input.network !== NETWORK || input.genesisHash !== GENESIS ||
      input.abiCommit !== ABI || input.mint !== MINT || input.tokenProgram !== TOKEN_PROGRAM ||
      !publicKey(input.programId) || !publicKey(input.programDataAddress) ||
      !/^[a-f0-9]{64}$/.test(input.executableSha256) || !/^(0|[1-9][0-9]*)$/.test(input.deploymentSlot) ||
      !(input.upgradeAuthority === null || publicKey(input.upgradeAuthority)) ||
      !publicKey(payer) || !publicKey(merchant) || payer === merchant || input.payer !== payer || input.merchant !== merchant) {
    throw Error('PAYMENT_PROFILE_DIFFERS');
  }
  return Object.freeze(Object.fromEntries(PROFILE_FIELDS.map(key => [key, input[key]])));
}

export function profileFromEnv(env) {
  const { REPORT_PAYER: payer, REPORT_MERCHANT: merchant } = env;
  if (!payer || !merchant || payer === merchant) throw Error('SEPARATE_ROLES_REQUIRED');
  if ((env.PAYMENT_PROFILE ?? 'mock') === 'mock') return mockProfile(payer, merchant);
  if (env.PAYMENT_PROFILE !== 'devnet') throw Error('PAYMENT_PROFILE_DIFFERS');
  const path = env.PAYMENT_PROFILE_FILE;
  if (!isAbsolute(path ?? '')) throw Error('PRIVATE_PROFILE_REQUIRED');
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) ||
      info.uid !== process.getuid()) throw Error('PRIVATE_PROFILE_REQUIRED');
  const canonical = realpathSync(path);
  for (let parent = dirname(canonical); ; parent = dirname(parent)) {
    if (existsSync(join(parent, '.git'))) throw Error('PRIVATE_PROFILE_REQUIRED');
    if (parent === dirname(parent)) break;
  }
  return validateProfile(JSON.parse(readFileSync(path, 'utf8')), payer, merchant);
}

export function assertUpstreamProfile(expected, state) {
  if (expected.name === 'mock') {
    if (state.backend !== 'mock') throw Error('MOCK_UPSTREAM_REQUIRED');
  } else if (state.backend !== 'devnet' || !state.profile ||
      PROFILE_FIELDS.some(key => state.profile[key] !== expected[key])) throw Error('PAYMENT_PROFILE_DIFFERS');
}

export function profileDigest(profile) {
  return createHash('sha256').update(JSON.stringify(PROFILE_FIELDS.map(key => [key, profile[key]]))).digest('hex');
}
