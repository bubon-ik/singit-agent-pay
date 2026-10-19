import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { evidenceWriter } from "../scripts/devnet-evidence.js";

test("before-send evidence is exclusive, private, exact and cannot overwrite originals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "singit-synthetic-evidence-"));
  try {
    const writer = await evidenceWriter(dir);
    await writer.save("synthetic.json", { amount: (1n << 64n) - 1n });
    const path = join(dir, "synthetic.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      amount: "18446744073709551615",
    });
    await expect(
      writer.save("synthetic.json", { overwrite: true }),
    ).rejects.toThrow();
    await expect(writer.save("../outside.json", {})).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("live evidence cannot be saved into this checkout or an absent directory", async () => {
  await expect(evidenceWriter(process.cwd())).rejects.toThrow();
  await expect(evidenceWriter(undefined)).rejects.toThrow();
});

test("unresolved original wire blocks a new writer until a matching finalized observation exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "singit-synthetic-pending-"));
  try {
    const writer = await evidenceWriter(dir);
    const e = {
      operation: "hold" as const,
      holdId: "synthetic",
      signature: "synthetic",
      signedTransaction: "synthetic-wire",
      blockhash: "synthetic",
      lastValidBlockHeight: "100",
      programId: "synthetic",
      genesisHash: "synthetic",
      abiCommit: "synthetic",
    };
    await writer.retainBeforeSend(e);
    await expect(evidenceWriter(dir)).rejects.toThrow();
    await writer.retainFinalized(e, null);
    await expect(evidenceWriter(dir)).resolves.toBeDefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
