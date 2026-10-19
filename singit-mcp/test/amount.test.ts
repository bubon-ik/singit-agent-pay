import { expect, test } from "vitest";
import { formatUsdc } from "../src/amount.js";

test("formatUsdc: basic examples", () => {
  expect(formatUsdc(4000000n)).toBe("4.00 USDC");
  expect(formatUsdc(1250000n)).toBe("1.25 USDC");
  expect(formatUsdc(1500000n)).toBe("1.50 USDC");
  expect(formatUsdc(0n)).toBe("0.00 USDC");
});

test("formatUsdc: high precision (6 decimals)", () => {
  expect(formatUsdc(1n)).toBe("0.000001 USDC");
  expect(formatUsdc(1234500n)).toBe("1.2345 USDC");
  expect(formatUsdc(100000001n)).toBe("100.000001 USDC");
});

test("formatUsdc: large amounts", () => {
  expect(formatUsdc(10n ** 12n)).toBe("1000000.00 USDC");
  expect(formatUsdc(10n ** 15n)).toBe("1000000000.00 USDC");
});

test("formatUsdc: edge cases with trailing zeros", () => {
  // Amounts that would naturally produce trailing zeros
  expect(formatUsdc(1000000n)).toBe("1.00 USDC"); // exactly 1, 0 fractional
  expect(formatUsdc(2000000n)).toBe("2.00 USDC"); // exactly 2
  expect(formatUsdc(1500000n)).toBe("1.50 USDC"); // ends with one zero, trimmed to 2 decimals
  expect(formatUsdc(1200000n)).toBe("1.20 USDC"); // ends with one zero
});

test("formatUsdc: various fractional values", () => {
  expect(formatUsdc(1100000n)).toBe("1.10 USDC"); // 1.10
  expect(formatUsdc(1010000n)).toBe("1.01 USDC"); // 1.01
  expect(formatUsdc(1001000n)).toBe("1.001 USDC"); // 1.001 (3 decimals)
  expect(formatUsdc(1000100n)).toBe("1.0001 USDC"); // 1.0001 (4 decimals)
  expect(formatUsdc(1000010n)).toBe("1.00001 USDC"); // 1.00001 (5 decimals)
  expect(formatUsdc(1000001n)).toBe("1.000001 USDC"); // 1.000001 (6 decimals)
});
