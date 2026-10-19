import { expect, test } from "vitest";
import { publicOperation } from "../src/public-state.js";

test.each(["pending", "unknown", "succeeded", "failed"])(
  "public %s operations retain display fields and exclude nested and legacy evidence",
  (state) => {
    const wire = "private-synthetic-wire";
    const prepared = Object.freeze({
      txSig: "synthetic-signature", holdId: "payment", lastValidBlockHeight: 100,
      evidence: { signedTransaction: wire }, signedTransaction: wire,
    });
    const record = Object.freeze({
      id: "op-1", action: "hold", mandateId: "m-1", state, reservation: "1000000",
      createdAt: 1800000000, updatedAt: 1800000001,
      params: { amount: "1000000", private: wire },
      expected: { held: "1000000", refundable: "0", evidence: wire },
      prepared, result: { txSig: "synthetic-signature", holdId: "payment", evidence: wire },
      error: { code: "synthetic_error", message: "Synthetic failure", evidence: wire },
      salt: "private-salt", key: "private-idempotency-key", futurePrivateField: wire,
    });
    const result = publicOperation(record);
    expect(result).toEqual({
      id: "op-1", action: "hold", mandateId: "m-1", state, reservation: "1000000",
      createdAt: 1800000000, updatedAt: 1800000001,
      params: { amount: "1000000" }, expected: { held: "1000000", refundable: "0" },
      prepared: { txSig: "synthetic-signature", holdId: "payment", lastValidBlockHeight: 100 },
      result: { txSig: "synthetic-signature", holdId: "payment" },
      error: { code: "synthetic_error", message: "Synthetic failure" },
    });
    expect(JSON.stringify(result)).not.toContain(wire);
    expect(record.prepared).toBe(prepared);
    expect(record.prepared.evidence.signedTransaction).toBe(wire);
    expect(result.prepared).not.toBe(prepared);
  },
);

test("public operation fields do not forward structured values from unexpected records", () => {
  expect(publicOperation({
    id: "op-1", prepared: { txSig: { signedTransaction: "private" } },
    params: { amount: { signedTransaction: "private" } }, reservation: 1_000_000n,
  })).toEqual({ id: "op-1", prepared: {}, params: {}, reservation: "1000000" });
});
