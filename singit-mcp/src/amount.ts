/**
 * USDC amounts at the MCP boundary are decimal strings; everywhere else they are
 * base-unit bigints (6 decimals, 1 USDC = 1_000_000n), per capture402's token precision.
 */

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountError";
  }
}

const DECIMALS = 6;
const SCALE = 10n ** BigInt(DECIMALS);
const U64_MAX = (1n << 64n) - 1n;

/** Parses a base-unit USDC string (e.g. "1250000"). No decimals, no sign, no whitespace. */
export function parseUsdc(s: string): bigint {
  if (!/^\d+$/.test(s)) {
    throw new AmountError(`invalid USDC amount "${s}": expected base units (digits only)`);
  }
  const value = BigInt(s);
  if (value > U64_MAX) {
    throw new AmountError(`invalid USDC amount "${s}": exceeds u64 max`);
  }
  return value;
}

/** Formats a base-unit USDC bigint for human-readable messages, e.g. "1.250000 USDC". */
export function formatUsdc(b: bigint): string {
  const whole = b / SCALE;
  const frac = (b % SCALE).toString().padStart(DECIMALS, "0");
  return `${whole}.${frac} USDC`;
}
