/** Opt-in direct backend acceptance, not a full MCP E2E. Separate owner authorization required. */
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import {
  buildBackendFromEnv,
  assertDevnetRpc,
} from "../src/backend/factory.js";
import { Capture402Backend } from "../src/backend/capture402.js";
import {
  BackendError,
  BackendOutcomeUnknown,
  DEVNET_USDC_MINT,
} from "../src/backend/types.js";
import { evidenceWriter } from "./devnet-evidence.js";

const required = [
  "SINGIT_PAYER_KEYPAIR",
  "SINGIT_MERCHANT_KEYPAIR",
  "SINGIT_PAYER_ADDRESS",
  "SINGIT_MERCHANT_ADDRESS",
  "SINGIT_PROGRAM_ID",
  "SINGIT_PROGRAM_DATA",
  "SINGIT_EXECUTABLE_SHA256",
  "SINGIT_DEPLOYMENT_SLOT",
  "SINGIT_EVIDENCE_DIR",
];
let missing = 0;
for (const name of required) {
  if (!process.env[name]) {
    console.log(`[missing] ${name}`);
    missing++;
  }
}
for (const name of ["SINGIT_PAYER_KEYPAIR", "SINGIT_MERCHANT_KEYPAIR"]) {
  try {
    if (!statSync(process.env[name] ?? "").isFile()) throw Error();
  } catch {
    console.log(`[missing] ${name} readable file path required`);
    missing++;
  }
}
if (process.env.SINGIT_BACKEND !== "capture402") {
  console.log("[missing] SINGIT_BACKEND=capture402");
  missing++;
}
try {
  assertDevnetRpc(process.env.SINGIT_RPC_URL ?? "");
} catch {
  console.log(
    "[missing] SINGIT_RPC_URL: explicit approved HTTPS Helius/QuickNode required; no public/mainnet fallback",
  );
  missing++;
}
console.log(
  "[info] Local devnet throwaway keys only. Payer signs authorize; merchant signs capture/void/refund.",
);
console.log(
  "[info] Smoke requires 1 USDC, both canonical ATAs, payer SOL for payment/vault rent and one fee; merchant SOL for three fees.",
);
if (missing) {
  console.log(
    `devnet smoke: preflight failed (${missing} missing). Nothing was sent.`,
  );
  process.exit(1);
}

let writer: Awaited<ReturnType<typeof evidenceWriter>> | undefined;
let step = "preflight";
const runId = randomBytes(16).toString("hex");
const snapshots: unknown[] = [];
function equal(actual: bigint, expected: bigint, label: string) {
  if (actual !== expected)
    throw Error(`${label}: expected ${expected}, got ${actual}`);
}
try {
  writer = await evidenceWriter(process.env.SINGIT_EVIDENCE_DIR);
  const backend = buildBackendFromEnv(process.env, {
    retainBeforeSend: writer.retainBeforeSend,
    retainFinalized: writer.retainFinalized,
  }) as Capture402Backend;
  const payer = process.env.SINGIT_PAYER_ADDRESS!,
    merchant = process.env.SINGIT_MERCHANT_ADDRESS!;
  const initial = await backend.preflight(payer, merchant);
  if (
    initial.payerUsdc < 1_000_000n ||
    initial.payerLamports < initial.paymentRent + initial.vaultRent + 5_000n ||
    initial.merchantLamports < 15_000n
  ) {
    throw Error(
      "Insufficient USDC or SOL for smoke; fund separately after owner authorization",
    );
  }
  const salt = randomBytes(32).toString("hex");
  const request = {
    payer,
    payee: merchant,
    mint: DEVNET_USDC_MINT,
    maximum: 1_000_000n,
    salt,
    captureDeadline: Number(initial.now + 3600n),
    refundDeadline: Number(initial.now + 90000n),
  };
  await writer.save(`${runId}.intent.json`, { request, initial });
  step = "hold";
  const receipt = await backend.hold(request),
    holdId = receipt.holdId;
  async function snapshot(
    name: string,
    txSig: string,
    held: bigint,
    refundable: bigint,
    payerDelta: bigint,
    merchantDelta: bigint,
  ) {
    const status = await backend.getStatus(holdId),
      balances = await backend.preflight(payer, merchant);
    if (!status) throw Error("Finalized payment disappeared");
    equal(status.maximum, 1_000_000n, "maximum");
    equal(status.held, held, "held");
    equal(status.refundable, refundable, "refundable");
    equal(balances.payerUsdc - initial.payerUsdc, payerDelta, "payer delta");
    equal(
      balances.merchantUsdc - initial.merchantUsdc,
      merchantDelta,
      "merchant delta",
    );
    const record = { name, txSig, holdId, status, balances };
    snapshots.push(record);
    await writer!.save(`${runId}.${name}.json`, record);
    console.log(
      `[${name}] https://explorer.solana.com/tx/${txSig}?cluster=devnet`,
    );
    return status;
  }
  let status = await snapshot(
    "hold",
    receipt.txSig,
    1_000_000n,
    0n,
    -1_000_000n,
    0n,
  );
  step = "capture";
  const capture = await backend.capture({
    holdId,
    amount: 600_000n,
    releaseRemainder: false,
    expectedHeld: status.held,
    expectedRefundable: status.refundable,
  });
  status = await snapshot(
    "capture",
    capture.txSig,
    400_000n,
    600_000n,
    -1_000_000n,
    600_000n,
  );
  step = "stale guards";
  try {
    await backend.release({
      holdId,
      expectedHeld: 1_000_000n,
      expectedRefundable: 0n,
    });
    throw Error("Stale guard unexpectedly accepted");
  } catch (e) {
    if (!(e instanceof BackendError) || e.code !== "unexpected_payment_state")
      throw e;
  }
  step = "release";
  const release = await backend.release({
    holdId,
    expectedHeld: status.held,
    expectedRefundable: status.refundable,
  });
  status = await snapshot(
    "release",
    release.txSig,
    0n,
    600_000n,
    -600_000n,
    600_000n,
  );
  step = "duplicate release";
  try {
    await backend.release({
      holdId,
      expectedHeld: 0n,
      expectedRefundable: 600_000n,
    });
    throw Error("Duplicate release unexpectedly accepted");
  } catch (e) {
    if (!(e instanceof BackendError) || e.code !== "empty_hold") throw e;
  }
  step = "refund";
  const refund = await backend.refund({
    holdId,
    amount: 200_000n,
    expectedHeld: status.held,
    expectedRefundable: status.refundable,
  });
  await snapshot("refund", refund.txSig, 0n, 400_000n, -400_000n, 400_000n);
  step = "stale refund replay";
  try {
    await backend.refund({
      holdId,
      amount: 200_000n,
      expectedHeld: 0n,
      expectedRefundable: 600_000n,
    });
    throw Error("Replay unexpectedly accepted");
  } catch (e) {
    if (!(e instanceof BackendError) || e.code !== "unexpected_payment_state")
      throw e;
  }
  await writer.save(`${runId}.complete.json`, {
    outcome: "DIRECT_BACKEND_SMOKE_PASSED",
    snapshots,
  });
  console.log(
    "Direct backend smoke passed: hold 1 -> capture 0.6 -> release 0.4 -> refund 0.2 USDC. Full MCP E2E remains separate.",
  );
} catch (e) {
  if (writer)
    await writer.save(`${runId}.stopped.json`, {
      step,
      outcome: e instanceof BackendOutcomeUnknown ? "UNKNOWN" : "STOPPED",
      snapshots,
      evidence: e instanceof BackendOutcomeUnknown ? e.evidence : undefined,
    });
  const code =
    e instanceof BackendOutcomeUnknown
      ? "UNKNOWN"
      : e instanceof BackendError
        ? e.code
        : "check_failed";
  console.log(
    `devnet smoke stopped at ${step}: ${code}. Preserve evidence; do not retry, change salt/blockhash/provider or automatically compensate.`,
  );
  process.exit(1);
}
