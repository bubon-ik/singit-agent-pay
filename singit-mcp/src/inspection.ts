/** Offline observation only: no runtime, signers, backend, RPC, repair, chmod or lock creation. */
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse } from "node:path";
import { JournalError, parseJournal } from "./journal.js";
import type { Snapshot } from "./store.js";

const MAX_BYTES = 64n * 1024n * 1024n;
function counts(snapshot?: Snapshot) {
  const ops = snapshot?.ops ?? [];
  return { mandates: snapshot?.mandates.length ?? 0, holds: snapshot?.holds.length ?? 0,
    disputes: snapshot?.disputes.length ?? 0, operations: ops.length, audit: snapshot?.audit.length ?? 0,
    pending: ops.filter(op => op.state === "pending").length, unknown: ops.filter(op => op.state === "unknown").length,
    succeeded: ops.filter(op => op.state === "succeeded").length, failed: ops.filter(op => op.state === "failed").length,
    reserved: ops.filter(op => op.state === "pending" || op.state === "unknown").reduce((n, op) => n + BigInt(op.reservation), 0n).toString() };
}

export interface InspectionResult {
  ready: false;
  complete: boolean;
  code: string;
  counts: ReturnType<typeof counts>;
  journalSha256?: string;
  line?: number;
  validPrefixOnly?: boolean;
  legacyReviewCount?: number;
}

export function inspectState(dir: string): InspectionResult {
  const blocked = (code: string) => ({ ready: false as const, complete: false, code, counts: counts() });
  let fd: number | undefined;
  try {
    if (!isAbsolute(dir) || dir === parse(dir).root) return blocked("PRIVATE_STATE_REQUIRED");
    const directory = lstatSync(dir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) || directory.uid !== process.getuid?.()) {
      return blocked("PRIVATE_STATE_REQUIRED");
    }
    const canonical = realpathSync(dir);
    for (let parent = canonical; ; parent = dirname(parent)) {
      if (existsSync(join(parent, ".git"))) return blocked("PRIVATE_STATE_REQUIRED");
      if (parent === dirname(parent)) break;
    }
    const file = join(canonical, "state.jsonl");
    const original = lstatSync(file, { bigint: true });
    if (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1n || (original.mode & 0o077n) || original.uid !== BigInt(process.getuid!())) {
      return blocked("PRIVATE_STATE_REQUIRED");
    }
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd, { bigint: true });
    if (before.ino !== original.ino || before.dev !== original.dev || before.size > MAX_BYTES) return blocked("JOURNAL_CHANGED_OR_TOO_LARGE");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true }), current = lstatSync(file, { bigint: true });
    if (after.ino !== current.ino || after.dev !== current.dev || after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.size !== BigInt(bytes.length)) {
      return blocked("JOURNAL_CHANGED_OR_TOO_LARGE");
    }
    const journalSha256 = createHash("sha256").update(bytes).digest("hex");
    try {
      let raw: string;
      try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new JournalError("JOURNAL_CORRUPT", 0); }
      const snapshot = parseJournal(raw);
      return { ready: false as const, complete: true, code: "OFFLINE_INSPECTION_ONLY", journalSha256, counts: counts(snapshot) };
    } catch (error) {
      if (!(error instanceof JournalError)) throw error;
      return { ready: false as const, complete: false, code: error.code, line: error.line, journalSha256,
        counts: counts(error.snapshot), validPrefixOnly: true, legacyReviewCount: error.snapshot?.legacyIssues?.length ?? 0 };
    }
  } catch {
    return blocked("INSPECTION_UNAVAILABLE");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
