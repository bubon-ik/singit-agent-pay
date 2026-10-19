import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const scriptPath = path.join(repoRoot, "scripts", "devnet-smoke.ts");

function runSmoke(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [tsxCli, scriptPath], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("devnet smoke: clean env fails preflight, no network calls, no key material leaked", () => {
  const result = runSmoke({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("preflight failed");
  expect(result.stdout).toContain("SINGIT_PAYER_KEYPAIR");

  const output = result.stdout + result.stderr;
  expect(output).not.toContain("BEGIN");
  expect(output).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{64,}/);
  expect(output).not.toMatch(/[0-9a-fA-F]{64,}/);
});

test("devnet smoke: mainnet SINGIT_RPC_URL is refused before any network call", () => {
  const result = runSmoke({
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    SINGIT_BACKEND: "capture402",
    SINGIT_RPC_URL: "https://api.mainnet-beta.solana.com",
    SINGIT_PAYER_KEYPAIR: "/nonexistent/payer.json",
    SINGIT_MERCHANT_KEYPAIR: "/nonexistent/merchant.json",
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("mainnet");

  const output = result.stdout + result.stderr;
  expect(output).not.toContain("BEGIN");
  expect(output).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{64,}/);
  expect(output).not.toMatch(/[0-9a-fA-F]{64,}/);
});
