/** Private evidence writer shared by opt-in live checks. Never writes inside this checkout. */
import { open, realpath, stat, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { UnknownOperation } from "../src/backend/types.js";

export async function evidenceWriter(directory: string | undefined) {
  if (!directory) throw Error("SINGIT_EVIDENCE_DIR is required outside Git");
  const parent = await realpath(directory);
  const metadata = await stat(parent);
  if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0)
    throw Error("Evidence directory must be private (mode 700)");
  for (let root = parent; ; root = dirname(root)) {
    let insideGit = false;
    try {
      await stat(resolve(root, ".git"));
      insideGit = true;
    } catch {
      /* no marker */
    }
    if (insideGit) throw Error("Evidence directory must be outside Git");
    if (dirname(root) === root) break;
  }
  // A prior prepared wire without a matching finalized receipt blocks a new run.
  for (const name of await readdir(parent)) {
    if (!name.endsWith(".prepared.json")) continue;
    const prepared = JSON.parse(await readFile(resolve(parent, name), "utf8"));
    const finalized = JSON.parse(
      await readFile(
        resolve(parent, name.replace(".prepared.json", ".finalized.json")),
        "utf8",
      ),
    );
    if (
      typeof prepared.signature !== "string" ||
      finalized.signature !== prepared.signature ||
      finalized.signedTransaction !== prepared.signedTransaction ||
      finalized.commitment !== "finalized" ||
      !Object.hasOwn(finalized, "err")
    )
      throw Error("Unresolved original transaction evidence blocks this run");
  }
  async function save(name: string, value: unknown) {
    if (!/^[A-Za-z0-9.-]+$/.test(name))
      throw Error("Invalid evidence filename");
    const file = await open(resolve(parent, name), "wx", 0o600);
    try {
      await file.writeFile(
        JSON.stringify(
          value,
          (_k, v) => (typeof v === "bigint" ? v.toString() : v),
          2,
        ) + "\n",
      );
      await file.sync();
    } finally {
      await file.close();
    }
    const dir = await open(parent, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  return {
    retainBeforeSend: async (e: UnknownOperation) =>
      save(`${e.signature}.prepared.json`, {
        outcome: "PREPARED_POSSIBLY_SENT",
        ...e,
      }),
    retainFinalized: async (e: UnknownOperation, err: unknown) =>
      save(`${e.signature}.finalized.json`, {
        ...e,
        commitment: "finalized",
        err,
      }),
    save,
  };
}
