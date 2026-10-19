import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { FileStateStore } from "../src/store.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeSync: vi.fn(actual.writeSync), fsyncSync: vi.fn(actual.fsyncSync) };
});
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.mocked(fs.writeSync).mockReset(); vi.mocked(fs.fsyncSync).mockReset(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const mandate = { id: "m-1", payer: "payer", totalBudget: "1000000", perTxCap: "1000000", expiresAt: 1000,
  allowedCounterparties: ["merchant"], committed: "0", createdAt: 1 };
async function fixture() {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fs.writeSync).mockImplementation(actual.writeSync); vi.mocked(fs.fsyncSync).mockImplementation(actual.fsyncSync);
  const dir = mkdtempSync(join(tmpdir(), "singit-io-")); dirs.push(dir);
  return { actual, dir, store: new FileStateStore(dir), file: join(dir, "state.jsonl") };
}
test("short filesystem writes are completed before fsync and replay as one full record", async () => {
  const f = await fixture();
  vi.mocked(fs.writeSync).mockImplementation(((fd: number, bytes: Buffer, offset: number, length: number) =>
    f.actual.writeSync(fd, bytes, offset, Math.min(length, 7))) as typeof fs.writeSync);
  f.store.putMandate(mandate);
  expect(vi.mocked(fs.writeSync).mock.calls.length).toBeGreaterThan(1);
  expect(f.store.load().mandates).toEqual([mandate]);
});
test("an EIO after a partial append poisons this writer and restart preserves the incomplete original", async () => {
  const f = await fixture(); let first = true;
  vi.mocked(fs.writeSync).mockImplementation(((fd: number, bytes: Buffer, offset: number, length: number) => {
    if (first) { first = false; return f.actual.writeSync(fd, bytes, offset, Math.min(length, 7)); }
    throw Error("synthetic EIO");
  }) as typeof fs.writeSync);
  expect(() => f.store.putMandate(mandate)).toThrow("EIO");
  const bytes = readFileSync(f.file);
  expect(() => f.store.putMandate(mandate)).toThrow("previously failed");
  vi.mocked(fs.writeSync).mockImplementation(f.actual.writeSync);
  expect(() => new FileStateStore(f.dir).load()).toThrow("JOURNAL_CORRUPT");
  expect(readFileSync(f.file)).toEqual(bytes);
});
test("an fsync failure closes this writer even when the complete bytes are readable", async () => {
  const f = await fixture();
  vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw Error("synthetic ENOSPC during fsync"); });
  expect(() => f.store.putMandate(mandate)).toThrow("ENOSPC");
  const bytes = readFileSync(f.file);
  expect(() => f.store.putMandate(mandate)).toThrow("previously failed");
  expect(readFileSync(f.file)).toEqual(bytes);
});
