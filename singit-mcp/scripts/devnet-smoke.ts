/**
 * npm run devnet:smoke — end-to-end smoke test of Capture402Backend against Solana devnet:
 * preflight checks, then hold -> capture (partial) -> release (remainder) -> final status,
 * calling the PaymentBackend interface directly (no PaymentService, no mandates).
 *
 * For Kostiantyn's laptop only, with his own devnet throwaway keys. Devnet only — refuses
 * any mainnet-looking SINGIT_RPC_URL (see assertDevnetRpc in src/backend/factory.ts).
 *
 * Required env:
 *   SINGIT_BACKEND=capture402
 *   SINGIT_PAYER_KEYPAIR, SINGIT_MERCHANT_KEYPAIR   file paths to devnet keypairs (never read/logged here)
 *   SINGIT_PAYER_ADDRESS, SINGIT_MERCHANT_ADDRESS   base58 public keys matching the above, must differ
 *   SINGIT_PROGRAM_ID                                capture402 devnet program id (base58)
 *   SINGIT_RPC_URL                                   optional, default https://api.devnet.solana.com
 */
import { statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { formatUsdc } from "../src/amount.js";
import { assertDevnetRpc, buildBackendFromEnv } from "../src/backend/factory.js";
import { BackendError, DEVNET_USDC_MINT, type HoldRequest } from "../src/backend/types.js";

const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function explorerTx(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}
function explorerAddress(addr: string): string {
  return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
}

type Status = "ok" | "missing" | "warn" | "todo";
interface ChecklistItem {
  status: Status;
  line: string;
}
const checklist: ChecklistItem[] = [];
function note(status: Status, line: string): void {
  checklist.push({ status, line });
}

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function checkKeypairFile(envVar: string): void {
  const path = process.env[envVar];
  if (!path) {
    note("missing", `${envVar} is not set — set it to the path of a devnet keypair file`);
    return;
  }
  let st;
  try {
    st = statSync(path);
  } catch {
    note("missing", `${envVar}=${path} — file does not exist`);
    return;
  }
  note("ok", `${envVar}=${path} (exists)`);
  if ((st.mode & 0o077) !== 0) {
    note("warn", `${envVar}=${path} is group/world readable (mode ${(st.mode & 0o777).toString(8)}) — chmod 600 recommended`);
  }
}

function checkAddress(envVar: string): string | undefined {
  const addr = process.env[envVar];
  if (!addr) {
    note("missing", `${envVar} is not set — set it to the matching base58 public key`);
    return undefined;
  }
  if (!BASE58_ADDRESS.test(addr)) {
    note("missing", `${envVar}=${addr} is not a valid base58 public key (32-44 chars of [1-9A-HJ-NP-Za-km-z])`);
    return undefined;
  }
  note("ok", `${envVar}=${addr}`);
  return addr;
}

// ---- 1. preflight checklist ----

if (process.env.SINGIT_BACKEND === "capture402") {
  note("ok", "SINGIT_BACKEND=capture402");
} else {
  note("missing", `SINGIT_BACKEND=${process.env.SINGIT_BACKEND ?? "(unset)"} — set SINGIT_BACKEND=capture402`);
}

checkKeypairFile("SINGIT_PAYER_KEYPAIR");
checkKeypairFile("SINGIT_MERCHANT_KEYPAIR");

const payerAddress = checkAddress("SINGIT_PAYER_ADDRESS");
const merchantAddress = checkAddress("SINGIT_MERCHANT_ADDRESS");
if (payerAddress && merchantAddress) {
  if (payerAddress === merchantAddress) {
    note("missing", "SINGIT_PAYER_ADDRESS and SINGIT_MERCHANT_ADDRESS must differ");
  } else {
    note("ok", "SINGIT_PAYER_ADDRESS and SINGIT_MERCHANT_ADDRESS differ");
  }
}

const programId = process.env.SINGIT_PROGRAM_ID;
if (programId && BASE58_ADDRESS.test(programId)) {
  note("ok", `SINGIT_PROGRAM_ID=${programId}`);
} else {
  note(
    "missing",
    `SINGIT_PROGRAM_ID=${programId ?? "(unset)"} — get the capture402 devnet program id from the teammate (not committed in capture402-solana; see INTERFACE.md)`,
  );
}

const rpcUrl = process.env.SINGIT_RPC_URL ?? "https://api.devnet.solana.com";
/** Never print RPC credentials (e.g. ?api-key=... or user:pass@). */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}${u.search || u.username ? " (credentials/query redacted)" : ""}`;
  } catch {
    return "(unparseable URL)";
  }
}
try {
  assertDevnetRpc(rpcUrl);
  note("ok", `SINGIT_RPC_URL=${redactUrl(rpcUrl)}`);
} catch (err) {
  note("missing", `SINGIT_RPC_URL=${redactUrl(rpcUrl)} — not an allowed devnet RPC URL (mainnet or non-http(s) refused)`);
}

note("todo", `fund SINGIT_PAYER_ADDRESS with devnet SOL for fees + rent (~0.005 SOL per hold; rent is locked forever by capture402, QA L-3)`);
note("todo", `fund SINGIT_MERCHANT_ADDRESS with devnet SOL for fees`);
note(
  "todo",
  `make sure the payer's ATA holds >= 1 devnet USDC (mint ${DEVNET_USDC_MINT})`,
);
note("todo", `make sure the merchant's USDC ATA exists (capture destination) and holds funds for refunds`);

for (const item of checklist) {
  console.log(`[${item.status}] ${item.line}`);
}

const missingCount = checklist.filter((i) => i.status === "missing").length;
if (missingCount > 0) {
  console.log(`devnet smoke: preflight failed (${missingCount} missing). Nothing was sent.`);
  process.exit(1);
}

// ---- 2. on-chain preflight (plain fetch JSON-RPC, no new deps) ----

let rpcId = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) {
    throw new Error(`RPC ${method} failed: ${body.error.message}`);
  }
  return body.result as T;
}

interface TokenAccountsResult {
  value: Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } } }>;
}

const genesisHash = await rpc<string>("getGenesisHash", []);
if (genesisHash !== DEVNET_GENESIS_HASH) {
  console.log(`devnet smoke: RPC genesis hash ${genesisHash} is not devnet (expected ${DEVNET_GENESIS_HASH})`);
  process.exit(1);
}

const payerBalanceLamports = (await rpc<{ value: number }>("getBalance", [payerAddress])).value;
const merchantBalanceLamports = (await rpc<{ value: number }>("getBalance", [merchantAddress])).value;
const payerSol = payerBalanceLamports / 1e9;
const merchantSol = merchantBalanceLamports / 1e9;
console.log(`[info] payer SOL: ${payerSol}`);
console.log(`[info] merchant SOL: ${merchantSol}`);

const payerTokenAccounts = await rpc<TokenAccountsResult>("getTokenAccountsByOwner", [
  payerAddress,
  { mint: DEVNET_USDC_MINT },
  { encoding: "jsonParsed" },
]);
const payerUsdc = payerTokenAccounts.value.reduce(
  (sum, acc) => sum + (acc.account.data.parsed.info.tokenAmount.uiAmount ?? 0),
  0,
);
console.log(`[info] payer USDC: ${payerUsdc}`);

const merchantTokenAccounts = await rpc<TokenAccountsResult>("getTokenAccountsByOwner", [
  merchantAddress,
  { mint: DEVNET_USDC_MINT },
  { encoding: "jsonParsed" },
]);
const merchantUsdc = merchantTokenAccounts.value.reduce(
  (sum, acc) => sum + (acc.account.data.parsed.info.tokenAmount.uiAmount ?? 0),
  0,
);
console.log(`[info] merchant USDC: ${merchantUsdc}${merchantTokenAccounts.value.length === 0 ? " (no ATA)" : ""}`);

if (merchantTokenAccounts.value.length === 0) {
  console.log("[warn] merchant has no USDC ATA — refunds will fail until one exists");
}
if (payerUsdc < 1) {
  console.log(`devnet smoke: payer USDC balance ${payerUsdc} is below the required 1 USDC`);
  process.exit(1);
}
if (payerSol < 0.01) {
  console.log(`devnet smoke: payer SOL balance ${payerSol} is below the required 0.01 SOL`);
  process.exit(1);
}

// ---- 3. flow through the PaymentBackend interface only ----

function printStep(step: string, txSig: string, holdId: string): void {
  console.log(`[${step}] txSig=${txSig}`);
  console.log(`  ${explorerTx(txSig)}`);
  console.log(`  payment account: ${explorerAddress(holdId)}`);
}

const backend = buildBackendFromEnv(process.env);
const salt = randomBytes(32).toString("hex");
const now = Math.floor(Date.now() / 1000);
const captureDeadline = now + 3600;
const refundDeadline = captureDeadline + 86400;

let holdId: string | null = null;
let stepName = "hold";
try {
  const holdReq: HoldRequest = {
    payer: payerAddress as string,
    mint: DEVNET_USDC_MINT,
    payee: merchantAddress as string,
    maximum: 1_000_000n,
    captureDeadline,
    refundDeadline,
    salt,
  };
  const holdReceipt = await backend.hold(holdReq);
  holdId = holdReceipt.holdId;
  printStep("hold", holdReceipt.txSig, holdId);

  stepName = "getStatus (post-hold)";
  const statusAfterHold = await backend.getStatus(holdId);
  if (!statusAfterHold || statusAfterHold.mint !== DEVNET_USDC_MINT) {
    console.log(`[error] WRONG_MINT: hold ${holdId} mint ${statusAfterHold?.mint ?? "unknown"} != ${DEVNET_USDC_MINT}`);
    stepName = "release (wrong mint cleanup)";
    try {
      await backend.release({
        holdId,
        expectedHeld: statusAfterHold?.held ?? 1_000_000n,
        expectedRefundable: statusAfterHold?.refundable ?? 0n,
      });
    } catch {
      // best-effort cleanup; the hold still needs to be voided by hand if this fails
    }
    console.log(`devnet smoke: hold ${holdId} may still need voiding: ${explorerAddress(holdId)}`);
    process.exit(1);
  }

  stepName = "capture";
  const captureReceipt = await backend.capture({
    holdId,
    amount: 600_000n,
    releaseRemainder: false,
    expectedHeld: statusAfterHold.held,
    expectedRefundable: statusAfterHold.refundable,
  });
  printStep("capture", captureReceipt.txSig, holdId);

  stepName = "getStatus (post-capture)";
  const statusAfterCapture = await backend.getStatus(holdId);
  if (!statusAfterCapture) {
    throw new BackendError("payment_not_found", `payment ${holdId} disappeared after capture`);
  }

  stepName = "release";
  const releaseReceipt = await backend.release({
    holdId,
    expectedHeld: statusAfterCapture.held,
    expectedRefundable: statusAfterCapture.refundable,
  });
  printStep("release", releaseReceipt.txSig, holdId);

  stepName = "getStatus (final)";
  const finalStatus = await backend.getStatus(holdId);
  if (!finalStatus) {
    throw new BackendError("payment_not_found", `payment ${holdId} disappeared after release`);
  }

  console.log("\nfinal status");
  const rows: Array<[string, string]> = [
    ["maximum", formatUsdc(finalStatus.maximum)],
    ["held", formatUsdc(finalStatus.held)],
    ["refundable", formatUsdc(finalStatus.refundable)],
    ["captureDeadline", String(finalStatus.captureDeadline)],
    ["refundDeadline", String(finalStatus.refundDeadline)],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(`  ${k.padEnd(w)} : ${v}`);
} catch (err) {
  if (err instanceof BackendError && err.code === "not_implemented") {
    console.log("Capture402Backend is still the stub (teammate's implementation pending). Preflight passed; nothing was sent.");
    process.exit(2);
  }
  const code = err instanceof BackendError ? err.code : "unknown";
  const message = err instanceof Error ? err.message : String(err);
  console.log(`devnet smoke: step failed: ${stepName} code=${code} message=${message}`);
  if (holdId) {
    console.log(`devnet smoke: hold ${holdId} was created and may need voiding by hand: ${explorerAddress(holdId)}`);
  }
  process.exit(1);
}
