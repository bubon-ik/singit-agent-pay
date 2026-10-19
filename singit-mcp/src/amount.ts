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

/** Formats a base-unit USDC bigint for human-readable messages.
 * Output has 2-6 decimal places with trailing zeros trimmed to exactly 2.
 * Examples: 4000000n -> "4.00 USDC", 1250000n -> "1.25 USDC", 1500000n -> "1.50 USDC",
 * 0n -> "0.00 USDC", 1n -> "0.000001 USDC", 1234500n -> "1.2345 USDC",
 * 100000001n -> "100.000001 USDC", 10n**12n -> "1000000.00 USDC". */
export function formatUsdc(b: bigint): string {
  const whole = b / SCALE;
  let frac = (b % SCALE).toString().padStart(DECIMALS, "0");
  // Trim trailing zeros, but keep at least 2 decimal places
  while (frac.length > 2 && frac.endsWith("0")) {
    frac = frac.slice(0, -1);
  }
  return `${whole}.${frac} USDC`;
}
