import { statSync } from "node:fs";
import { expect, test } from "vitest";
import { buildBackendFromEnv } from "../src/backend/factory.js";
import { runBackendContract, type ContractFixture } from "./backend-contract.js";

function fileExists(path: string | undefined): boolean {
  if (!path) return false;
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Never opens the keypair files — only confirms they exist on disk (key material is never read/logged). */
function computeSkipReason(env: NodeJS.ProcessEnv): string {
  const missing: string[] = [];
  if (env.SINGIT_CONTRACT_DEVNET !== "1") missing.push("SINGIT_CONTRACT_DEVNET=1");
  if (!fileExists(env.SINGIT_PAYER_KEYPAIR)) missing.push("SINGIT_PAYER_KEYPAIR (file path)");
  if (!fileExists(env.SINGIT_MERCHANT_KEYPAIR)) missing.push("SINGIT_MERCHANT_KEYPAIR (file path)");
  if (!env.SINGIT_PAYER_ADDRESS) missing.push("SINGIT_PAYER_ADDRESS");
  if (!env.SINGIT_MERCHANT_ADDRESS) missing.push("SINGIT_MERCHANT_ADDRESS");
  if (!env.SINGIT_PROGRAM_ID) missing.push("SINGIT_PROGRAM_ID");
  if (missing.length === 0) return "";
  return `devnet contract suite skipped, missing: ${missing.join(", ")}`;
}

const skipReason = computeSkipReason(process.env);
const skip = skipReason !== "";

/** A fixed, valid base58 address that is not a capture402 payment PDA. */
const UNKNOWN_HOLD_ID = "11111111111111111111111111111112";

function makeFixture(): ContractFixture {
  const backend = buildBackendFromEnv({ ...process.env, SINGIT_BACKEND: "capture402" });
  const unit = BigInt(process.env.SINGIT_CONTRACT_UNIT ?? "100000");
  return {
    backend,
    payer: process.env.SINGIT_PAYER_ADDRESS as string,
    payee: process.env.SINGIT_MERCHANT_ADDRESS as string,
    unit,
    now: () => Math.floor(Date.now() / 1000),
    unknownHoldId: UNKNOWN_HOLD_ID,
  };
}

runBackendContract("Capture402Backend (devnet)", makeFixture, { skip, timeoutMs: 120_000 });

test("devnet contract suite skip reason lists missing env vars when skipped (no network)", () => {
  if (skip) {
    expect(skipReason).toContain("missing:");
  } else {
    expect(skipReason).toBe("");
  }
});
