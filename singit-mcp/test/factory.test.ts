import { expect, test } from "vitest";
import { assertDevnetRpc, buildBackendFromEnv } from "../src/backend/factory.js";
import { MockBackend } from "../src/backend/mock.js";
import { BackendError } from "../src/backend/types.js";

function expectInvalidNetwork(fn: () => unknown): void {
  try {
    fn();
    expect.unreachable("expected assertDevnetRpc to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(BackendError);
    expect((err as BackendError).code).toBe("invalid_network");
  }
}

test("default env (no SINGIT_BACKEND) builds a MockBackend", () => {
  const backend = buildBackendFromEnv({});
  expect(backend).toBeInstanceOf(MockBackend);
  expect(backend.name).toBe("mock");
});

test("SINGIT_BACKEND=capture402 builds a Capture402Backend with no network calls", () => {
  const backend = buildBackendFromEnv({ SINGIT_BACKEND: "capture402", SINGIT_PROGRAM_ID: "SomeProgramId111" });
  expect(backend.name).toBe("capture402");
});

test("assertDevnetRpc refuses mainnet hosts", () => {
  expectInvalidNetwork(() => assertDevnetRpc("https://api.mainnet-beta.solana.com"));
  expectInvalidNetwork(() => assertDevnetRpc("https://rpc.mainnet.example.com"));
});

test("assertDevnetRpc refuses non-http(s) URLs", () => {
  expectInvalidNetwork(() => assertDevnetRpc("ws://api.devnet.solana.com"));
  expectInvalidNetwork(() => assertDevnetRpc("not a url"));
});

test("assertDevnetRpc allows the default and custom devnet URLs", () => {
  expect(() => assertDevnetRpc("https://api.devnet.solana.com")).not.toThrow();
  expect(() => assertDevnetRpc("https://my-custom-devnet-rpc.example.com:8899")).not.toThrow();
});

test("SINGIT_BACKEND=capture402 with a mainnet SINGIT_RPC_URL throws invalid_network before constructing the backend", () => {
  expectInvalidNetwork(() =>
    buildBackendFromEnv({ SINGIT_BACKEND: "capture402", SINGIT_RPC_URL: "https://api.mainnet-beta.solana.com" }),
  );
});
