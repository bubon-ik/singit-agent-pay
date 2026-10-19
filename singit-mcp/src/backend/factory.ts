/**
 * Picks a PaymentBackend from environment variables. Shared by src/index.ts and the devnet
 * contract test fixture (test/backend-contract.capture402.test.ts) so both pick the same backend
 * the same way.
 */
import {
  assertDevnetRpc,
  Capture402Backend,
  type Capture402Dependencies,
} from "./capture402.js";
import { mockBalancesFromEnv, MockBackend } from "./mock.js";
import {
  BackendError,
  DEVNET_USDC_MINT,
  type PaymentBackend,
} from "./types.js";

export { assertDevnetRpc } from "./capture402.js";

export function buildBackendFromEnv(
  env: NodeJS.ProcessEnv,
  dependencies: Capture402Dependencies = {},
): PaymentBackend {
  if (env.SINGIT_BACKEND === "capture402") {
    const rpcUrl = env.SINGIT_RPC_URL ?? "";
    assertDevnetRpc(rpcUrl);
    return new Capture402Backend(
      {
        rpcUrl,
        programId: env.SINGIT_PROGRAM_ID ?? "",
        mint: DEVNET_USDC_MINT,
        payerKeypairPath: env.SINGIT_PAYER_KEYPAIR ?? "",
        merchantKeypairPath: env.SINGIT_MERCHANT_KEYPAIR ?? "",
        programDataAddress: env.SINGIT_PROGRAM_DATA ?? "",
        executableSha256: env.SINGIT_EXECUTABLE_SHA256 ?? "",
        deploymentSlot: /^\d+$/.test(env.SINGIT_DEPLOYMENT_SLOT ?? "")
          ? BigInt(env.SINGIT_DEPLOYMENT_SLOT!)
          : -1n,
      },
      dependencies,
    );
  }
  return new MockBackend({ balances: mockBalancesFromEnv(env) });
}
