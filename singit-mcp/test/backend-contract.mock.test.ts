import { MockBackend } from "../src/backend/mock.js";
import { runBackendContract, type ContractFixture } from "./backend-contract.js";

runBackendContract("MockBackend", (): ContractFixture => {
  let t = 1_800_000_000;
  const now = () => t;
  const payer = "contract-payer";
  const payee = "contract-payee";
  const backend = new MockBackend({
    now,
    balances: { [payer]: 1_000_000_000n, [payee]: 1_000_000_000n },
  });

  return {
    backend,
    payer,
    payee,
    unit: 1_000_000n,
    now,
    advance: (seconds: number) => {
      t += seconds;
    },
    unknownHoldId: "mock-hold-999",
    wrongMint: "So11111111111111111111111111111111111111112",
  };
});
