import { chmodSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { inspectState } from "../src/inspection.js";
import { createServiceRuntime } from "../src/runtime.js";
import { MockBackend } from "../src/backend/mock.js";
import { FileStateStore } from "../src/store.js";

const dirs: string[] = [];
function directory() { const dir = mkdtempSync(join(tmpdir(), "singit-inspect-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const record = { t: "mandate", v: 1, data: { id: "m-1", payer: "SYNTHETIC_PRIVATE_WALLET", totalBudget: "1000000", perTxCap: "1000000",
  expiresAt: 1_800_001_000, allowedCounterparties: ["SYNTHETIC_PRIVATE_MERCHANT"], committed: "0", createdAt: 1_800_000_000,
  note: "SYNTHETIC_PRIVATE_SIGNED_WIRE_AND_PROVIDER" } };

test.each(["", '{"t":"op",', '{"t":"future","v":3,"data":{}}\n', '{"t":"hold","v":1,"data":{}}\n'])("offline inspection preserves valid or refused journals byte-for-byte and reports only counts: %s", tail => {
  const dir = directory(), file = join(dir, "state.jsonl"); new FileStateStore(dir);
  writeFileSync(file, JSON.stringify(record) + "\n" + tail);
  const before = readFileSync(file), info = statSync(file), listing = readdirSync(dir);
  const result = inspectState(dir);
  expect(result.ready).toBe(false);
  expect(result.complete).toBe(tail === "");
  expect(result.counts.mandates).toBe(1);
  expect(result.journalSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE");
  expect(readFileSync(file)).toEqual(before);
  expect(readdirSync(dir)).toEqual(listing);
  const after = statSync(file);
  expect([after.ino, after.mode, after.size, after.mtimeMs, after.ctimeMs]).toEqual([info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs]);
});

test("blocked startup still permits offline diagnosis; neither path repairs a corrupt tail", async () => {
  const dir = directory(), file = join(dir, "state.jsonl"); new FileStateStore(dir);
  writeFileSync(file, JSON.stringify(record) + '\n{"t":"op",');
  const bytes = readFileSync(file);
  await expect(createServiceRuntime({ SINGIT_BACKEND: "capture402", SINGIT_STATE_DIR: dir }, { backend: new MockBackend() })).rejects.toMatchObject({ code: "JOURNAL_CORRUPT" });
  expect(inspectState(dir)).toMatchObject({ ready: false, complete: false, code: "JOURNAL_CORRUPT", validPrefixOnly: true });
  expect(readFileSync(file)).toEqual(bytes);
  expect(readdirSync(dir)).toEqual(["state.jsonl"]);
});

test("a conflicting bundled audit cannot add rejected state to valid-prefix inspection counts", () => {
  const dir = directory(), file = join(dir, "state.jsonl"); new FileStateStore(dir);
  const audit = { v: 1, seq: 1, ts: "2027-01-15T08:00:00.000Z", actor: "human", action: "create_mandate", outcome: "ok",
    code: null, reason: "synthetic mandate", mandateId: "m-1", holdId: null, disputeId: null, amount: "1000000",
    txSig: null, held: null, refundable: null };
  const rows = [record, { t: "audit", v: 2, data: audit }, { t: "statecommit", v: 2,
    data: { mandate: { ...record.data, id: "m-2" }, audit: { ...audit, mandateId: "m-2" } } }];
  writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const bytes = readFileSync(file);
  expect(inspectState(dir)).toMatchObject({ complete: false, code: "JOURNAL_CORRUPT", line: 3, validPrefixOnly: true,
    counts: { mandates: 1, audit: 1 } });
  expect(readFileSync(file)).toEqual(bytes);
});

test("ambiguous legacy records are observable without economic runtime or record repair", () => {
  const dir = directory(), file = join(dir, "state.jsonl"); new FileStateStore(dir);
  writeFileSync(file, JSON.stringify({ t: "op", v: 1, data: { id: "op-1", key: "original", action: "hold", actor: "payer", mandateId: "m-1",
    holdId: null, params: { paramsHash: "synthetic" }, state: "failed", reservation: "1000000", createdAt: 1, updatedAt: 1 } }) + "\n");
  const result = inspectState(dir);
  expect(result).toMatchObject({ ready: false, complete: false, code: "LEGACY_REVIEW_REQUIRED", legacyReviewCount: 1 });
  expect(result.counts.failed).toBe(1);
});

test("an old pending human child without the original decision is refused before runtime recovery", async () => {
  const dir = directory(), file = join(dir, "state.jsonl"); new FileStateStore(dir);
  writeFileSync(file, JSON.stringify({ t: "op", v: 1, data: { id: "op-1", key: "original", action: "resolve_refund", actor: "operator", mandateId: "m-1",
    holdId: "synthetic-hold", params: { paramsHash: "synthetic", disputeId: "d-1", amount: "100000" }, state: "unknown", reservation: "0", createdAt: 1, updatedAt: 1 } }) + "\n");
  const bytes = readFileSync(file);
  await expect(createServiceRuntime({ SINGIT_BACKEND: "capture402", SINGIT_STATE_DIR: dir }, { backend: new MockBackend() })).rejects.toMatchObject({ code: "LEGACY_REVIEW_REQUIRED" });
  expect(inspectState(dir)).toMatchObject({ complete: false, code: "LEGACY_REVIEW_REQUIRED", legacyReviewCount: 1 });
  expect(readFileSync(file)).toEqual(bytes);
});

test("inspection refuses symlink/hardlink and permissive paths without chmod or creating missing files", () => {
  const dir = directory(), target = join(directory(), "evidence.jsonl");
  writeFileSync(target, JSON.stringify(record) + "\n", { mode: 0o600 });
  const file = join(dir, "state.jsonl"); symlinkSync(target, file);
  expect(inspectState(dir).code).toBe("PRIVATE_STATE_REQUIRED");
  rmSync(file); linkSync(target, file);
  expect(inspectState(dir).code).toBe("PRIVATE_STATE_REQUIRED");
  rmSync(file); writeFileSync(file, "", { mode: 0o644 });
  expect(inspectState(dir).code).toBe("PRIVATE_STATE_REQUIRED");
  expect(statSync(file).mode & 0o777).toBe(0o644);
  chmodSync(file, 0o600); chmodSync(dir, 0o755);
  expect(inspectState(dir).code).toBe("PRIVATE_STATE_REQUIRED");
  expect(statSync(dir).mode & 0o777).toBe(0o755);
  const missing = join(directory(), "missing");
  expect(inspectState(missing).complete).toBe(false);
  expect(readdirSync(join(missing, ".."))).toEqual([]);
});

test("inspection CLI ignores live/key/provider environment and never prints journal contents", () => {
  const dir = directory(); new FileStateStore(dir);
  writeFileSync(join(dir, "state.jsonl"), JSON.stringify(record) + "\n");
  const cli = new URL("../scripts/inspect-state.ts", import.meta.url);
  const tsx = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url);
  const result = spawnSync(process.execPath, ["--import", tsx.href, cli.pathname, "--state-dir", dir], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TSX_DISABLE_CACHE: "1", SINGIT_BACKEND: "capture402",
      SINGIT_RPC_URL: "SYNTHETIC_PRIVATE_PROVIDER", SINGIT_PAYER_KEYPAIR: "/nonexistent-keypair", SINGIT_MERCHANT_KEYPAIR: "/nonexistent-keypair" }, encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ready: false, complete: true, code: "OFFLINE_INSPECTION_ONLY" });
  expect(result.stdout + result.stderr).not.toContain("SYNTHETIC_PRIVATE");
  expect(readdirSync(dir)).toEqual(["state.jsonl"]);
});
