/**
 * Picks a PaymentBackend from environment variables. Shared by src/index.ts and the devnet
 * contract test fixture (test/backend-contract.capture402.test.ts) so both pick the same backend
 * the same way.
 */
import { Capture402Backend } from "./capture402.js";
import { mockBalancesFromEnv, MockBackend } from "./mock.js";
import { BackendError, DEVNET_USDC_MINT, type PaymentBackend } from "./types.js";

/** Throws BackendError("invalid_network", ...) unless `url` is an http(s) URL whose hostname is not mainnet. */
export function assertDevnetRpc(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BackendError("invalid_network", `invalid RPC URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BackendError("invalid_network", `RPC URL must be http(s): ${url}`);
  }
  if (parsed.hostname.toLowerCase().includes("mainnet")) {
    throw new BackendError("invalid_network", `refusing mainnet RPC URL: ${url}`);
  }
}

export function buildBackendFromEnv(env: NodeJS.ProcessEnv): PaymentBackend {
  if (env.SINGIT_BACKEND === "capture402") {
    const rpcUrl = env.SINGIT_RPC_URL ?? "https://api.devnet.solana.com";
    assertDevnetRpc(rpcUrl);
    return new Capture402Backend({
      rpcUrl,
      programId: env.SINGIT_PROGRAM_ID ?? "",
      mint: DEVNET_USDC_MINT,
    });
  }
  return new MockBackend({ balances: mockBalancesFromEnv(env) });
}
