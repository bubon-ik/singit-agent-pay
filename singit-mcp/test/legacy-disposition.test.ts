import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { address, blockhash, compileTransaction, createKeyPairSignerFromPrivateKeyBytes, createTransactionMessage,
  appendTransactionMessageInstructions, getAddressDecoder, getBase64EncodedWireTransaction,
  getSignatureFromTransaction, partiallySignTransaction, pipe, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, type Instruction } from "@solana/kit";
import { authorizeInstruction, captureInstruction, refundInstruction } from "../src/backend/capture402-abi/instructions.js";
import { paymentAddress } from "../src/backend/capture402-abi/program.js";
import { CAPTURE402_ABI_COMMIT, DEVNET_GENESIS_HASH } from "../src/backend/capture402-evidence.js";
import { DEVNET_USDC_MINT, type UnknownOperation } from "../src/backend/types.js";
import { MockBackend } from "../src/backend/mock.js";
import { JournalError, legacySnapshotSha256, parseJournal, type LegacyReview } from "../src/journal.js";
import { reviewLegacyJournal } from "../src/legacy-disposition.js";
import { FileStateStore, type OperationRecord, type StoredHold, type StoredMandate } from "../src/store.js";
import { PaymentService } from "../src/service.js";
import { createServiceRuntime } from "../src/runtime.js";

const dirs: string[] = [], hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const proof = "a".repeat(64), now = 1_800_000_000;
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "singit-legacy-review-")); dirs.push(dir);
  const file = join(dir, "state.jsonl"), reviewFile = join(dir, "review.json"), locks = join(dir, "locks");
  const payer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(1));
  const merchant = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(2));
  const program = getAddressDecoder().decode(new Uint8Array(32).fill(40)), salt = new Uint8Array(32).fill(3);
  const id = await paymentAddress(program, payer.address, salt), lifetime = { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 99n };
  const base: StoredHold = { id, mandateId: "m-2", payer: payer.address, payee: merchant.address, mint: DEVNET_USDC_MINT,
    maximum: "1000000", held: "0", captured: "0", refunded: "0", captureDeadline: now + 1000,
    refundDeadline: now + 5000, txSigs: [], lastTxSig: null };
  const m: StoredMandate = { id: "m-2", payer: payer.address, totalBudget: "10000000", perTxCap: "4000000",
    expiresAt: now + 1000, allowedCounterparties: [merchant.address], committed: "650000", createdAt: now };
  const failed: OperationRecord = { id: "op-1", action: "hold", key: `hold:${payer.address}:failed`, actor: payer.address,
    mandateId: "m-1", holdId: null, params: { paramsHash: proof, amount: "3000000" }, state: "failed", reservation: "3000000",
    error: { code: "synthetic-validation-failure", message: "retained historical refusal" }, createdAt: now, updatedAt: now };
  const records: object[] = [{ t: "mandate", v: 1, data: { ...m, id: "m-1", committed: "3000000" } },
    { t: "mandate", v: 1, data: m }, { t: "op", v: 1, data: failed }];
  const outcomes: LegacyReview["outcomes"] = [{ operationId: failed.id, kind: "retained_failure", txSig: null,
    reason: "Original failure and committed reservation retained; no retry or budget repair", evidenceSha256: proof }];
  let previous = base;
  const add = async (action: "hold" | "capture" | "refund" | "resolve_refund", ix: Instruction, values: Partial<StoredHold>, params: Record<string, unknown>) => {
    const signer = action === "hold" ? payer : merchant;
    const message = pipe(createTransactionMessage({ version: "legacy" }), msg => setTransactionMessageFeePayer(signer.address, msg),
      msg => setTransactionMessageLifetimeUsingBlockhash(lifetime, msg), msg => appendTransactionMessageInstructions([ix], msg));
    const tx = await partiallySignTransaction([signer.keyPair], compileTransaction(message));
    const sig = getSignatureFromTransaction(tx), receipt = { ...previous, ...values, txSigs: [...previous.txSigs, sig], lastTxSig: sig };
    const canonical = Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
    const evidence: UnknownOperation = { operation: action === "resolve_refund" ? "refund" : action, holdId: id,
      ...(action === "hold" ? { salt: Buffer.from(salt).toString("hex") } :
        { expectedHeld: previous.held, expectedRefundable: (BigInt(previous.captured) - BigInt(previous.refunded)).toString() }),
      amount: String(params.amount), signature: sig, signedTransaction: getBase64EncodedWireTransaction(tx), blockhash: lifetime.blockhash,
      lastValidBlockHeight: "99", programId: program, genesisHash: DEVNET_GENESIS_HASH, abiCommit: CAPTURE402_ABI_COMMIT };
    const op: OperationRecord = { id: `op-${outcomes.length + 1}`, key: `${action}:${signer.address}:${action}`, action,
      actor: action === "resolve_refund" ? "human:synthetic-review" : signer.address, mandateId: m.id, holdId: id,
      params: { ...canonical, paramsHash: hash(JSON.stringify(canonical)) }, state: "succeeded", reservation: "0",
      result: { txSig: sig, ...(action === "hold" ? { holdId: id } : {}) },
      prepared: { txSig: sig, holdId: id, lastValidBlockHeight: 99, evidence: { ...evidence } },
      createdAt: now, updatedAt: now };
    records.push({ t: "hold", v: 1, data: receipt }, { t: "op", v: 1, data: op });
    outcomes.push({ operationId: op.id, kind: "finalized_success", txSig: sig, finality: "finalized", err: null, receipt, evidenceSha256: proof });
    previous = receipt;
  };
  const s = { programId: program, payment: id, payer: payer.address, server: merchant.address, mint: address(DEVNET_USDC_MINT) };
  await add("hold", await authorizeInstruction({ ...s, funder: payer.address, salt, maximum: 1_000_000n,
    captureDeadline: BigInt(base.captureDeadline), refundDeadline: BigInt(base.refundDeadline) }), { held: "1000000" },
    { mandateId: m.id, payee: merchant.address, amount: "1000000" });
  await add("capture", await captureInstruction(s, 650_000n, true, 1_000_000n, 0n), { held: "0", captured: "650000" },
    { holdId: id, amount: "650000", releaseRemainder: true });
  await add("refund", await refundInstruction(s, 100_000n, 0n, 650_000n), { refunded: "100000" }, { holdId: id, amount: "100000" });
  await add("resolve_refund", await refundInstruction(s, 550_000n, 0n, 550_000n), { refunded: "650000" },
    { holdId: id, amount: "550000", disputeId: "d-1" });
  records.push({ t: "dispute", v: 1, data: { id: "d-1", holdId: id, mandateId: m.id, openedBy: payer.address,
    reason: "synthetic human decision", evidence: [], status: "resolved", outcome: "refund", refundAmount: "550000",
    resolvedAt: now, txSigs: [previous.lastTxSig] } });
  const raw = records.map(record => JSON.stringify(record)).join("\n") + "\n";
  writeFileSync(file, raw, { mode: 0o600 });
  let snapshot;
  try { parseJournal(raw); throw Error("fixture must require review"); }
  catch (error) { if (!(error instanceof JournalError) || !error.snapshot || error.line !== 0) throw error; snapshot = error.snapshot; }
  const review: LegacyReview = { prefixSha256: hash(raw), prefixBytes: Buffer.byteLength(raw), snapshotSha256: legacySnapshotSha256(snapshot),
    namespace: { programId: program, genesisHash: DEVNET_GENESIS_HASH, payer: payer.address, merchant: merchant.address },
    operator: "synthetic-operator", reviewer: "synthetic-independent-reviewer", reviewedAt: new Date(now * 1000).toISOString(),
    evidenceSha256: proof, outcomes };
  const save = () => writeFileSync(reviewFile, JSON.stringify(review), { mode: 0o600 }); save();
  return { dir, file, reviewFile, locks, raw, review, save, snapshot, payer, merchant, id, s, lifetime };
}

test("explicit disposition preserves all original bytes, committed liabilities and immutable receipts across restart/replay", async () => {
  const f = await fixture();
  await expect(reviewLegacyJournal(f.dir, f.reviewFile, false, f.locks)).resolves.toMatchObject({ applied: false });
  expect(readFileSync(f.file, "utf8")).toBe(f.raw);
  await expect(reviewLegacyJournal(f.dir, f.reviewFile, true, f.locks)).resolves.toMatchObject({ applied: true, operations: 5 });
  expect(readFileSync(f.file, "utf8").startsWith(f.raw)).toBe(true);
  const store = new FileStateStore(f.dir), restored = store.load();
  expect(restored.mandates).toEqual(f.snapshot.mandates);
  expect(restored.holds).toEqual(f.snapshot.holds);
  expect(restored.disputes).toEqual(f.snapshot.disputes);
  expect(restored.ops[0]).toEqual(f.snapshot.ops[0]);
  expect(restored.reviewedNamespace).toEqual(f.review.namespace);
  const backend = new Proxy(new MockBackend(), { get(target, key) {
    if (["hold", "capture", "release", "refund", "getTxOutcome"].includes(String(key))) return () => { throw Error("no backend call permitted"); };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const service = new PaymentService({ backend, store, now: () => now, live: true });
  const replay = await service.captureOp({ actor: f.merchant.address, holdId: f.id, amount: 650_000n, releaseRemainder: true, idempotencyKey: "capture" });
  expect(replay).toMatchObject({ replay: true, operationId: "op-3", hold: { held: 0n, captured: 650_000n, refunded: 0n } });
  expect(service.getHold(f.id).refunded).toBe(650_000n);
  expect(service.getMandate("m-1").mandate.committed).toBe(3_000_000n);
  const again = new PaymentService({ backend, store: new FileStateStore(f.dir), now: () => now, live: true });
  expect(again.listAuditLog().filter(row => row.action === "operation_outcome")).toHaveLength(5);
  await expect(reviewLegacyJournal(f.dir, f.reviewFile, true, f.locks)).rejects.toBeDefined();
});

test.each(["SINGIT_PROGRAM_ID", "SINGIT_PAYER_ADDRESS", "SINGIT_MERCHANT_ADDRESS"])("reviewed namespace drift in %s refuses startup before accounting/audit or backend work", async field => {
  const f = await fixture(); await reviewLegacyJournal(f.dir, f.reviewFile, true, f.locks);
  const before = readFileSync(f.file);
  const env = { SINGIT_BACKEND: "capture402", SINGIT_STATE_DIR: f.dir, SINGIT_NAMESPACE_LOCK_DIR: f.locks,
    SINGIT_PROGRAM_ID: f.review.namespace.programId, SINGIT_PAYER_ADDRESS: f.payer.address, SINGIT_MERCHANT_ADDRESS: f.merchant.address,
    [field]: "different-synthetic-namespace" };
  await expect(createServiceRuntime(env, { backend: new MockBackend() })).rejects.toMatchObject({ code: "JOURNAL_NAMESPACE_MISMATCH" });
  expect(readFileSync(f.file)).toEqual(before);
});

test.each(["prefix", "snapshot", "namespace", "reviewer", "receipt", "missing", "duplicate"])("%s mismatch refuses without changing a journal byte", async fault => {
  const f = await fixture();
  if (fault === "prefix") f.review.prefixSha256 = "b".repeat(64);
  if (fault === "snapshot") f.review.snapshotSha256 = "b".repeat(64);
  if (fault === "namespace") f.review.namespace.programId = f.payer.address;
  if (fault === "reviewer") f.review.reviewer = f.review.operator;
  if (fault === "receipt" && f.review.outcomes[2].kind === "finalized_success") f.review.outcomes[2].receipt.refunded = "1";
  if (fault === "missing") f.review.outcomes.pop();
  if (fault === "duplicate") f.review.outcomes.push(f.review.outcomes[0]);
  f.save();
  await expect(reviewLegacyJournal(f.dir, f.reviewFile, true, f.locks)).rejects.toBeDefined();
  expect(readFileSync(f.file, "utf8")).toBe(f.raw);
});

test.each(["state", "namespace"])("%s custody lock refuses before disposition append", async kind => {
  const f = await fixture();
  const { mkdirSync } = await import("node:fs"); mkdirSync(f.locks, { mode: 0o700 });
  const name = hash(`singit-namespace-v1|${[f.review.namespace.programId, f.payer.address, f.merchant.address].join("|")}`).slice(0, 32);
  writeFileSync(kind === "state" ? join(f.dir, ".singit-mcp.lock") : join(f.locks, `${name}.lock`), "999\n", { mode: 0o600 });
  await expect(reviewLegacyJournal(f.dir, f.reviewFile, true, f.locks)).rejects.toBeDefined();
  expect(readFileSync(f.file, "utf8")).toBe(f.raw);
});

test("unresolved, modified or partly appended histories cannot acquire a review disposition", async () => {
  const f = await fixture();
  const record = JSON.stringify({ t: "legacyreview", v: 2, data: f.review }) + "\n";
  expect(() => parseJournal(f.raw + record.slice(0, -1))).toThrow(JournalError);
  expect(() => parseJournal(f.raw + record + record)).toThrow(JournalError);
  expect(() => parseJournal(f.raw + record + f.raw.split("\n")[0] + "\n")).toThrow(JournalError);
  const rows = f.raw.trim().split("\n").map(line => JSON.parse(line));
  rows.find(row => row.t === "op" && row.data.id === "op-2").data.state = "unknown";
  const changed = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  f.review.prefixSha256 = hash(changed); f.review.prefixBytes = Buffer.byteLength(changed);
  try { parseJournal(changed); } catch (error) { if (error instanceof JournalError && error.snapshot) f.review.snapshotSha256 = legacySnapshotSha256(error.snapshot); }
  writeFileSync(f.file, changed); f.save();
  await expect(reviewLegacyJournal(f.dir, f.reviewFile, true, f.locks)).rejects.toBeDefined();
  expect(readFileSync(f.file, "utf8")).toBe(changed);
});

test.each(["wire", "budget"])("a rehashed %s substitution still refuses and preserves the original", async fault => {
  const f = await fixture(), rows = f.raw.trimEnd().split("\n").map(line => JSON.parse(line));
  if (fault === "wire") {
    const op = rows.find(row => row.t === "op" && row.data.id === "op-2").data;
    const bytes = Buffer.from(op.prepared.evidence.signedTransaction, "base64"); bytes[5] ^= 1;
    op.prepared.evidence.signedTransaction = bytes.toString("base64");
  } else rows.find(row => row.t === "mandate" && row.data.id === "m-1").data.committed = "0";
  const changed = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  f.review.prefixSha256 = hash(changed); f.review.prefixBytes = Buffer.byteLength(changed);
  try { parseJournal(changed); } catch (error) { if (error instanceof JournalError && error.snapshot) f.review.snapshotSha256 = legacySnapshotSha256(error.snapshot); }
  writeFileSync(f.file, changed); f.save();
  await expect(reviewLegacyJournal(f.dir, f.reviewFile, true, f.locks)).rejects.toBeDefined();
  expect(readFileSync(f.file, "utf8")).toBe(changed);
});

test.each(["action", "amount", "guard"])("a valid capture wire cannot attest different historical %s or free that budget", async fault => {
  const f = await fixture(), rows = f.raw.trimEnd().split("\n").map(line => JSON.parse(line));
  const end = rows.findIndex(row => row.t === "op" && row.data.id === "op-3");
  rows.splice(end + 1);
  const op = rows[end].data, receipt = rows[end - 1].data;
  if (fault === "action") { op.action = "release"; op.key = `release:${f.merchant.address}:release`; }
  else if (fault === "amount") op.params.amount = "500000";
  if (fault === "guard") {
    const ix = await captureInstruction(f.s, 650_000n, true, 900_000n, 0n);
    const message = pipe(createTransactionMessage({ version: "legacy" }), msg => setTransactionMessageFeePayer(f.merchant.address, msg),
      msg => setTransactionMessageLifetimeUsingBlockhash(f.lifetime, msg), msg => appendTransactionMessageInstructions([ix], msg));
    const tx = await partiallySignTransaction([f.merchant.keyPair], compileTransaction(message)), sig = getSignatureFromTransaction(tx);
    Object.assign(op.prepared.evidence, { expectedHeld: "900000", signature: sig, signedTransaction: getBase64EncodedWireTransaction(tx) });
    op.prepared.txSig = sig; op.result.txSig = sig; receipt.txSigs[1] = sig; receipt.lastTxSig = sig;
  }
  receipt.captured = fault === "action" ? "0" : fault === "amount" ? "500000" : "650000";
  rows.find(row => row.t === "mandate" && row.data.id === "m-2").data.committed = receipt.captured;
  f.review.outcomes.splice(3);
  const outcome = f.review.outcomes[2]; if (outcome.kind !== "finalized_success") throw Error();
  outcome.receipt = structuredClone(receipt); outcome.txSig = op.result.txSig;
  const changed = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  f.review.prefixSha256 = hash(changed); f.review.prefixBytes = Buffer.byteLength(changed);
  try { parseJournal(changed); } catch (error) { if (error instanceof JournalError && error.snapshot) f.review.snapshotSha256 = legacySnapshotSha256(error.snapshot); }
  // Structural accounting is self-consistent; only its binding to the actual wire reveals the lie.
  expect(() => parseJournal(changed + JSON.stringify({ t: "legacyreview", v: 2, data: f.review }) + "\n")).not.toThrow();
  writeFileSync(f.file, changed); f.save();
  await expect(reviewLegacyJournal(f.dir, f.reviewFile, true, f.locks)).rejects.toBeDefined();
  expect(readFileSync(f.file, "utf8")).toBe(changed);
});

test("permissive review files are refused before journal mutation", async () => {
  const f = await fixture(); chmodSync(f.reviewFile, 0o644);
  await expect(reviewLegacyJournal(f.dir, f.reviewFile, true, f.locks)).rejects.toBeDefined();
  expect(readFileSync(f.file, "utf8")).toBe(f.raw);
});
