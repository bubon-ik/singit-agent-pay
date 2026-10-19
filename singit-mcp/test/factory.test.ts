import { expect, test } from "vitest";
import {
  assertDevnetRpc,
  buildBackendFromEnv,
} from "../src/backend/factory.js";
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
  const backend = buildBackendFromEnv({
    SINGIT_BACKEND: "capture402",
    SINGIT_RPC_URL: "https://synthetic.helius-rpc.com",
    SINGIT_PROGRAM_ID: "11111111111111111111111111111112",
    SINGIT_PROGRAM_DATA: "11111111111111111111111111111113",
    SINGIT_EXECUTABLE_SHA256: "aa".repeat(32),
    SINGIT_DEPLOYMENT_SLOT: "42",
  });
  expect(backend.name).toBe("capture402");
});

test("assertDevnetRpc refuses mainnet hosts", () => {
  expectInvalidNetwork(() =>
    assertDevnetRpc("https://api.mainnet-beta.solana.com"),
  );
  expectInvalidNetwork(() =>
    assertDevnetRpc("https://rpc.mainnet.example.com"),
  );
});

test("assertDevnetRpc refuses non-http(s) URLs", () => {
  expectInvalidNetwork(() => assertDevnetRpc("ws://api.devnet.solana.com"));
  expectInvalidNetwork(() => assertDevnetRpc("not a url"));
});

test("assertDevnetRpc requires explicit approved provider with no public fallback", () => {
  expectInvalidNetwork(() => assertDevnetRpc("https://api.devnet.solana.com"));
  expectInvalidNetwork(() =>
    assertDevnetRpc("https://my-custom-devnet-rpc.example.com:8899"),
  );
  expect(() =>
    assertDevnetRpc("https://synthetic.helius-rpc.com"),
  ).not.toThrow();
  expect(() =>
    assertDevnetRpc("https://synthetic.quiknode.pro/private-path"),
  ).not.toThrow();
  expectInvalidNetwork(() =>
    assertDevnetRpc("https://user:password@synthetic.helius-rpc.com"),
  );
  expectInvalidNetwork(() =>
    assertDevnetRpc("https://synthetic.helius-rpc.com.evil.invalid"),
  );
});

test("SINGIT_BACKEND=capture402 with a mainnet SINGIT_RPC_URL throws invalid_network before constructing the backend", () => {
  expectInvalidNetwork(() =>
    buildBackendFromEnv({
      SINGIT_BACKEND: "capture402",
      SINGIT_RPC_URL: "https://api.mainnet-beta.solana.com",
    }),
  );
});

test("capture402 requires explicit RPC and deployment configuration", () => {
  expect(() => buildBackendFromEnv({ SINGIT_BACKEND: "capture402" })).toThrow(
    BackendError,
  );
  expect(() =>
    buildBackendFromEnv({
      SINGIT_BACKEND: "capture402",
      SINGIT_RPC_URL: "https://synthetic.helius-rpc.com",
    }),
  ).toThrow(BackendError);
});
