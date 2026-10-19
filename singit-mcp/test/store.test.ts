import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FileStateStore, MemoryStateStore, type OperationRecord, type StoredDispute, type StoredHold, type StoredMandate } from "../src/store.js";
import type { AuditEntry } from "../src/audit.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "singit-store-"));
}

const mandate: StoredMandate = {
  id: "m-1",
  payer: "p",
  totalBudget: "1000000",
  perTxCap: "1000000",
  expiresAt: 999,
  allowedCounterparties: ["q"],
  committed: "0",
  createdAt: 1,
};

const hold: StoredHold = {
  id: "mock-hold-1",
  mandateId: "m-1",
  payer: "p",
  payee: "q",
  mint: "mint",
  maximum: "1000",
  held: "1000",
  captured: "0",
  refunded: "0",
  captureDeadline: 10,
  refundDeadline: 20,
  txSigs: ["mock-tx-1"],
  lastTxSig: "mock-tx-1",
};

const dispute: StoredDispute = {
  id: "d-1",
  holdId: "mock-hold-1",
  mandateId: "m-1",
  openedBy: "q",
  reason: "r",
  evidence: [],
  status: "open",
  txSigs: [],
};

const op: OperationRecord = {
  id: "op-1",
  key: "hold:p:k1",
  action: "hold",
  actor: "p",
  mandateId: "m-1",
  holdId: "mock-hold-1",
  params: { paramsHash: "h" },
  state: "succeeded",
  reservation: "1000",
  createdAt: 1,
  updatedAt: 1,
};

const audit: AuditEntry = {
  v: 1,
  seq: 1,
  ts: new Date(0).toISOString(),
  actor: "p",
  action: "hold",
  outcome: "ok",
  code: null,
  reason: "r",
  mandateId: "m-1",
  holdId: "mock-hold-1",
  disputeId: null,
  amount: "1000",
  txSig: "mock-tx-1",
  held: "1000",
  refundable: "0",
};

describe("MemoryStateStore", () => {
  test("round-trips mandates/holds/disputes/ops/audit and computes seqs", () => {
    const store = new MemoryStateStore();
    store.putMandate(mandate);
    store.putHold(hold);
    store.putDispute(dispute);
    store.putOp(op);
    store.appendAudit(audit);

    const snap = store.load();
    expect(snap.mandates).toEqual([mandate]);
    expect(snap.holds).toEqual([hold]);
    expect(snap.disputes).toEqual([dispute]);
    expect(snap.ops).toEqual([op]);
    expect(snap.audit).toEqual([audit]);
    expect(snap.seqs).toEqual({ mandateSeq: 1, disputeSeq: 1, opSeq: 1, auditSeq: 1 });
  });

  test("last write per id wins", () => {
    const store = new MemoryStateStore();
    store.putMandate(mandate);
    store.putMandate({ ...mandate, committed: "500000" });
    const snap = store.load();
    expect(snap.mandates).toHaveLength(1);
    expect(snap.mandates[0].committed).toBe("500000");
  });
});

describe("FileStateStore", () => {
  test("round-trips through disk: last write per id wins, seqs computed from ids", () => {
    const dir = tmpDir();
    const store = new FileStateStore(dir);
    store.putMandate(mandate);
    store.putMandate({ ...mandate, committed: "500000" }); // second write wins
    store.putHold(hold);
    store.putDispute(dispute);
    store.putOp(op);
    store.appendAudit(audit);

    const reopened = new FileStateStore(dir);
    const snap = reopened.load();
    expect(snap.mandates).toHaveLength(1);
    expect(snap.mandates[0].committed).toBe("500000");
    expect(snap.holds).toEqual([hold]);
    expect(snap.disputes).toEqual([dispute]);
    expect(snap.ops).toEqual([op]);
    expect(snap.audit).toEqual([audit]);
    expect(snap.seqs).toEqual({ mandateSeq: 1, disputeSeq: 1, opSeq: 1, auditSeq: 1 });
  });

  test("tolerates a truncated/corrupt LAST line (crash mid-write)", () => {
    const dir = tmpDir();
    const store = new FileStateStore(dir);
    store.putMandate(mandate);

    const filePath = join(dir, "state.jsonl");
    const existing = readFileSync(filePath, "utf8");
    writeFileSync(filePath, `${existing}{"t":"mandate","v":1,"data":{"id":"m-2","committed":`); // truncated, no trailing newline

    const reopened = new FileStateStore(dir);
    const snap = reopened.load();
    expect(snap.mandates).toHaveLength(1);
    expect(snap.mandates[0].id).toBe("m-1");
  });

  test("throws on corruption that is NOT the last line", () => {
    const dir = tmpDir();
    const store = new FileStateStore(dir);
    store.putMandate(mandate);

    const filePath = join(dir, "state.jsonl");
    const existing = readFileSync(filePath, "utf8");
    const validSecondLine = `${JSON.stringify({ t: "mandate", v: 1, data: { ...mandate, id: "m-2" } })}\n`;
    writeFileSync(filePath, `${existing}not-json-at-all\n${validSecondLine}`);

    const reopened = new FileStateStore(dir);
    expect(() => reopened.load()).toThrow();
  });

  test("dir mode 0700, file mode 0600", () => {
    const dir = tmpDir();
    new FileStateStore(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "state.jsonl")).mode & 0o777).toBe(0o600);
  });
});
