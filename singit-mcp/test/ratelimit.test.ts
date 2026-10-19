import { expect, test } from "vitest";
import { createRateLimiter } from "../src/ratelimit.js";

test("rate limiter blocks after N requests per minute per client and resets", () => {
  let t = 0;
  const allow = createRateLimiter(3, () => t);
  expect([allow("a"), allow("a"), allow("a"), allow("a")]).toEqual([true, true, true, false]);
  expect(allow("b")).toBe(true);
  t = 60_000;
  expect(allow("a")).toBe(true);
});
