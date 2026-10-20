/** Explicit offline disposition only: no runtime, backend, signer, RPC or financial repair. */
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse } from "node:path";
import { JournalError, parseJournal, validateRecord, type LegacyReview } from "./journal.js";
import { FileStateStore, type StoredHold } from "./store.js";
import { address } from "@solana/kit";
import { ata } from "./backend/capture402-abi/program.js";
import { validateCapture402Evidence } from "./backend/capture402-evidence.js";
import { DEVNET_USDC_MINT, type UnknownOperation } from "./backend/types.js";

function privatePath(path: string, directory: boolean): void {
  if (!isAbsolute(path) || path === parse(path).root) throw new JournalError("JOURNAL_CHANGED", 0);
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) ||
      (info.mode & 0o077) || info.uid !== process.getuid!()) throw new JournalError("JOURNAL_CHANGED", 0);
  for (let parent = directory ? realpathSync(path) : dirname(realpathSync(path)); ; parent = dirname(parent)) {
    if (existsSync(join(parent, ".git"))) throw new JournalError("JOURNAL_CHANGED", 0);
    if (parent === dirname(parent)) break;
  }
}

function readPrivate(path: string, maximum: bigint): Buffer {
  privatePath(path, false);
  const original = lstatSync(path, { bigint: true });
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (before.ino !== original.ino || before.dev !== original.dev || before.size > maximum) throw new JournalError("JOURNAL_CHANGED", 0);
    const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true });
    if (after.ino !== current.ino || after.dev !== current.dev || after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.size !== BigInt(bytes.length)) {
      throw new JournalError("JOURNAL_CHANGED", 0);
    }
    return bytes;
  } finally { closeSync(fd); }
}

function lock(path: string): () => void {
  const fd = openSync(path, "wx", 0o600), identity = fstatSync(fd);
  const release = () => {
    closeSync(fd);
    const current = lstatSync(path, { throwIfNoEntry: false });
    if (current?.ino === identity.ino && current.dev === identity.dev) unlinkSync(path);
  };
  try { writeFileSync(fd, `${process.pid}\n`); fsyncSync(fd); return release; }
  catch (error) { release(); throw error; }
}

export async function reviewLegacyJournal(stateDir: string, reviewPath: string, apply = false,
  namespaceDir = process.env.SINGIT_NAMESPACE_LOCK_DIR || join(homedir(), ".singit-mcp", "locks")) {
  privatePath(stateDir, true);
  const data = JSON.parse(readPrivate(reviewPath, 1024n * 1024n).toString("utf8")) as LegacyReview;
  validateRecord({ t: "legacyreview", v: 2, data }, 0);
  const check = async () => {
    const bytes = readPrivate(join(stateDir, "state.jsonl"), 64n * 1024n * 1024n);
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (data.prefixSha256 !== createHash("sha256").update(bytes).digest("hex")) throw new JournalError("JOURNAL_CHANGED", 0);
    const snapshot = parseJournal(`${raw}${JSON.stringify({ t: "legacyreview", v: 2, data })}\n`);
    const payerAta = await ata(address(data.namespace.payer), address(DEVNET_USDC_MINT));
    const merchantAta = await ata(address(data.namespace.merchant), address(DEVNET_USDC_MINT));
    const outcomes = new Map(data.outcomes.map(outcome => [outcome.operationId, outcome]));
    const history = new Map<string, StoredHold>();
    for (const op of snapshot.ops) {
      const outcome = outcomes.get(op.id)!;
      if (outcome.kind !== "finalized_success") continue;
      const evidence = op.prepared!.evidence as unknown as UnknownOperation;
      const wire = await validateCapture402Evidence(evidence, address(data.namespace.programId));
      const accounts = wire.instruction.accounts!, h = outcome.receipt;
      const refuse = () => { throw new JournalError("LEGACY_REVIEW_REQUIRED", 0); };
      const expectedOp = op.action === "hold" ? "authorize" : ["release", "cleanup_release"].includes(op.action)
        ? "void" : op.action === "resolve_refund" ? "refund" : op.action;
      if (wire.data.op !== expectedOp || evidence.holdId !== h.id || h.mint !== DEVNET_USDC_MINT ||
          wire.signer !== (op.action === "hold" ? h.payer : h.payee) ||
          ("amount" in wire.data && wire.data.amount.toString() !== op.params.amount)) refuse();
      if (wire.data.op !== "authorize") {
        const previous = history.get(h.id);
        if (!previous || !("expectedHeld" in wire.data) || wire.data.expectedHeld !== BigInt(previous.held) ||
            wire.data.expectedRefundable !== BigInt(previous.captured) - BigInt(previous.refunded)) refuse();
      }
      if (wire.data.op === "authorize") {
        if (accounts[1]?.address !== h.payee || accounts[4]?.address !== payerAta || accounts[6]?.address !== h.payer ||
            wire.data.maximum.toString() !== h.maximum || wire.data.captureDeadline !== BigInt(h.captureDeadline) ||
            wire.data.refundDeadline !== BigInt(h.refundDeadline)) refuse();
      } else if (wire.data.op === "capture") {
        if (accounts[4]?.address !== merchantAta || accounts[5]?.address !== payerAta ||
            wire.data.releaseRemainder !== (op.params.releaseRemainder === true)) refuse();
      } else if (wire.data.op === "void") {
        if (accounts[4]?.address !== payerAta) refuse();
      } else if (wire.data.op === "refund") {
        if (accounts[3]?.address !== merchantAta || accounts[4]?.address !== payerAta) refuse();
      } else refuse();
      history.set(h.id, h);
    }
    return { snapshot, bytes };
  };
  if (!apply) {
    await check();
    return { applied: false, code: "REVIEW_CHECK_ONLY", originalSha256: data.prefixSha256, operations: data.outcomes.length };
  }
  // The same host-wide economic namespace as runtime.ts. This is insufficient for an old
  // process that predates the locks: its verified stop/restart exclusion is a separate gate.
  if (!isAbsolute(namespaceDir)) throw new JournalError("JOURNAL_CHANGED", 0);
  mkdirSync(namespaceDir, { recursive: true, mode: 0o700 }); privatePath(namespaceDir, true);
  const releaseState = lock(join(stateDir, ".singit-mcp.lock"));
  let releaseNamespace: (() => void) | undefined;
  try {
    const { programId, payer, merchant } = data.namespace;
    const name = createHash("sha256").update(`singit-namespace-v1|${[programId, payer, merchant].join("|")}`).digest("hex").slice(0, 32);
    releaseNamespace = lock(join(namespaceDir, `${name}.lock`));
    await check();
    new FileStateStore(stateDir).appendLegacyReview(data);
    const after = readPrivate(join(stateDir, "state.jsonl"), 64n * 1024n * 1024n);
    return { applied: true, code: "REVIEW_DISPOSITION_APPENDED", originalSha256: data.prefixSha256,
      journalSha256: createHash("sha256").update(after).digest("hex"), operations: data.outcomes.length };
  } finally { try { releaseNamespace?.(); } finally { releaseState(); } }
}
