import { createHash } from "node:crypto";
import { beforeEach, expect, test } from "vitest";
import {
  address,
  createKeyPairSignerFromPrivateKeyBytes,
  decompileTransactionMessage,
  getAddressEncoder,
  getAddressDecoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Address,
  type Instruction,
} from "@solana/kit";
import {
  Capture402Backend,
  DEVNET_GENESIS_HASH,
  loadDevnetSigner,
  type Capture402Config,
  type Capture402Rpc,
} from "../src/backend/capture402.js";
import {
  BackendError,
  BackendOutcomeUnknown,
  type UnknownOperation,
  DEVNET_USDC_MINT,
  type HoldRequest,
} from "../src/backend/types.js";
import {
  ata,
  TOKEN_PROGRAM_ADDRESS as TOKEN,
  SYSTEM_PROGRAM_ADDRESS as SYSTEM,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS as ATA,
  U64_MAX,
} from "../src/backend/capture402-abi/program.js";
import { runBackendContract } from "./backend-contract.js";
const addr = (n: number) =>
  getAddressDecoder().decode(new Uint8Array(32).fill(n));
const enc = (s: string) => Buffer.from(getAddressEncoder().encode(address(s)));
type Acc = {
  owner: Address;
  executable: boolean;
  lamports: bigint;
  data: Buffer;
};
const acc = (owner: Address, data: Buffer, executable = false): Acc => ({
  owner,
  data,
  executable,
  lamports: 0n,
});
function token(owner: Address, amount: bigint) {
  const d = Buffer.alloc(165);
  enc(DEVNET_USDC_MINT).copy(d);
  enc(owner).copy(d, 32);
  d.writeBigUInt64LE(amount, 64);
  d[108] = 1;
  return acc(TOKEN, d);
}
async function fixture() {
  // Published deterministic synthetic seeds, never real key files.
  const payer = await createKeyPairSignerFromPrivateKeyBytes(
      new Uint8Array(32).fill(1),
    ),
    merchant = await createKeyPairSignerFromPrivateKeyBytes(
      new Uint8Array(32).fill(2),
    );
  const program = addr(40),
    programData = addr(41),
    accounts = new Map<string, Acc>(),
    payload = Buffer.from("synthetic executable");
  const config: Capture402Config = {
    rpcUrl: "https://synthetic.helius-rpc.com",
    programId: program,
    mint: DEVNET_USDC_MINT,
    programDataAddress: programData,
    executableSha256: createHash("sha256").update(payload).digest("hex"),
    deploymentSlot: 42n,
    payerKeypairPath: "payer",
    merchantKeypairPath: "merchant",
    confirmationTimeoutMs: 10,
  };
  const loader = address("BPFLoaderUpgradeab1e11111111111111111111111");
  const pb = Buffer.alloc(36);
  pb.writeUInt32LE(2);
  enc(programData).copy(pb, 4);
  accounts.set(program, acc(loader, pb, true));
  const pd = Buffer.alloc(45 + payload.length);
  pd.writeUInt32LE(3);
  pd.writeBigUInt64LE(42n, 4);
  payload.copy(pd, 45);
  accounts.set(programData, acc(loader, pd));
  for (const id of [TOKEN, SYSTEM, ATA])
    accounts.set(id, acc(loader, Buffer.alloc(0), true));
  const mint = Buffer.alloc(82);
  mint[44] = 6;
  mint[45] = 1;
  accounts.set(DEVNET_USDC_MINT, acc(TOKEN, mint));
  const clock = Buffer.alloc(40);
  accounts.set(
    "SysvarC1ock11111111111111111111111111111111",
    acc(address("Sysvar1111111111111111111111111111111111111"), clock),
  );
  const payerAta = await ata(payer.address, address(DEVNET_USDC_MINT)),
    merchantAta = await ata(merchant.address, address(DEVNET_USDC_MINT));
  accounts.set(payerAta, token(payer.address, U64_MAX));
  accounts.set(merchantAta, token(merchant.address, 1_000_000n));
  const f = {
    config,
    accounts,
    payer,
    merchant,
    payerAta,
    merchantAta,
    now: 1_800_000_000,
    genesis: DEVNET_GENESIS_HASH,
    sent: [] as string[],
    instructions: [] as Instruction[],
    calls: [] as string[],
    failRead: false,
    lostSend: false,
    lostConfirmation: false,
    returnedMismatch: false,
    status: "finalized",
    historyAbsent: false,
    blockHeight: 90n,
    statusSlot: 45n,
    accountContextSlot: 100n,
    minContextSlots: [] as bigint[],
    chainError: null as unknown,
    simulationError: null as unknown,
    balance: 1_000_000_000n,
    backend: undefined as unknown as Capture402Backend,
    rpc: undefined as unknown as Capture402Rpc,
  };
  async function execute(wire: string) {
    const tx = getTransactionDecoder().decode(Buffer.from(wire, "base64")),
      m = decompileTransactionMessage(
        getCompiledTransactionMessageDecoder().decode(tx.messageBytes),
      );
    const ix = m.instructions[0],
      d = Buffer.from(ix.data!),
      keys = ix.accounts!.map((a) => a.address),
      signer = d[0] === 0 ? payer : merchant;
    f.instructions.push(ix);
    expect(ix.programAddress).toBe(program);
    expect(Object.keys(tx.signatures)).toEqual([signer.address]);
    expect(
      await crypto.subtle.verify(
        "Ed25519",
        signer.keyPair.publicKey,
        tx.signatures[signer.address]! as Uint8Array<ArrayBuffer>,
        Uint8Array.from(tx.messageBytes),
      ),
    ).toBe(true);
    if (f.chainError !== null) return getSignatureFromTransaction(tx);
    const id = keys[d[0] === 0 ? 2 : 1];
    if (d[0] === 0) {
      expect(d.length).toBe(67);
      expect([...d.subarray(0, 11)]).toEqual([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      expect(keys).toEqual([
        payer.address,
        merchant.address,
        id,
        DEVNET_USDC_MINT,
        payerAta,
        await ata(id, address(DEVNET_USDC_MINT)),
        payer.address,
        SYSTEM,
        TOKEN,
        ATA,
      ]);
      const p = Buffer.alloc(176);
      p.write("SACPAY01");
      enc(payer.address).copy(p, 8);
      enc(merchant.address).copy(p, 40);
      enc(DEVNET_USDC_MINT).copy(p, 72);
      d.copy(p, 104, 11, 43);
      d.copy(p, 136, 43, 67);
      p.writeBigUInt64LE(d.readBigUInt64LE(43), 160);
      accounts.set(id, acc(program, p));
      accounts.set(keys[5], token(id, d.readBigUInt64LE(43)));
    } else {
      const p = accounts.get(id)!.data,
        h = p.readBigUInt64LE(160),
        r = p.readBigUInt64LE(168),
        off = d[0] === 2 ? 10 : d[0] === 3 ? 1 : 9;
      expect(d.readBigUInt64LE(off)).toBe(h);
      expect(d.readBigUInt64LE(off + 8)).toBe(r);
      const a = d[0] === 3 ? h : d.readBigUInt64LE(1);
      p.writeBigUInt64LE(
        d[0] === 3 || (d[0] === 2 && d[9] === 1) ? 0n : d[0] === 2 ? h - a : h,
        160,
      );
      p.writeBigUInt64LE(d[0] === 2 ? r + a : d[0] === 4 ? r - a : r, 168);
      accounts
        .get(await ata(id, address(DEVNET_USDC_MINT)))!
        .data.writeBigUInt64LE(p.readBigUInt64LE(160), 64);
    }
    return getSignatureFromTransaction(tx);
  }
  const rpc = new Proxy(
    {},
    {
      get(_t, method: string) {
        return (...args: unknown[]) => ({
          send: async () => {
            f.calls.push(method);
            switch (method) {
              case "getGenesisHash":
                if (f.failRead) throw Error("secret RPC URL");
                return f.genesis;
              case "getAccountInfo": {
                clock.writeBigInt64LE(BigInt(f.now), 32);
                expect(args[1]).toMatchObject({ commitment: "finalized" });
                const minimum = (args[1] as { minContextSlot?: bigint })
                  .minContextSlot;
                if (minimum !== undefined) f.minContextSlots.push(minimum);
                const a = accounts.get(args[0] as string);
                return {
                  context: { slot: f.accountContextSlot },
                  value: a
                    ? { ...a, data: [a.data.toString("base64"), "base64"] }
                    : null,
                };
              }
              case "getLatestBlockhash":
                return {
                  value: { blockhash: addr(8), lastValidBlockHeight: 100n },
                };
              case "getMinimumBalanceForRentExemption":
                return 2_000_000n;
              case "getFeeForMessage":
                return { value: 5_000n };
              case "getBalance":
                return { value: f.balance };
              case "simulateTransaction":
                return { value: { err: f.simulationError } };
              case "sendTransaction": {
                expect(args[1]).toMatchObject({
                  maxRetries: 0n,
                  skipPreflight: false,
                  preflightCommitment: "finalized",
                });
                f.sent.push(args[0] as string);
                const sig = await execute(args[0] as string);
                if (f.lostSend) throw Error("lost after execution");
                return f.returnedMismatch ? "wrong" : sig;
              }
              case "getEpochInfo":
                return { blockHeight: f.blockHeight, absoluteSlot: 50n };
              case "getSignatureStatuses":
                if (f.lostConfirmation) throw Error("lost status");
                return {
                  value: f.historyAbsent
                    ? [null]
                    : [
                        {
                          confirmationStatus: f.status,
                          err: f.chainError,
                          slot: f.statusSlot,
                        },
                      ],
                };
              default:
                throw Error(`Unexpected RPC ${method}`);
            }
          },
        });
      },
    },
  ) as Capture402Rpc;
  f.rpc = rpc;
  f.backend = new Capture402Backend(config, {
    rpc,
    loadSigner: async (p) => (p === "payer" ? payer : merchant),
  });
  return f;
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
const req = (o: Partial<HoldRequest> = {}): HoldRequest => ({
  payer: f.payer.address,
  payee: f.merchant.address,
  mint: DEVNET_USDC_MINT,
  maximum: 1_000_000n,
  captureDeadline: f.now + 3600,
  refundDeadline: f.now + 86400,
  salt: "aa".repeat(32),
  ...o,
});
const open = async () => (await f.backend.hold(req())).holdId;
const code = async (p: Promise<unknown>, c: string) =>
  expect(p).rejects.toMatchObject({
    name: "BackendError",
    code: c,
    phase: "validation",
  });
runBackendContract(
  "Capture402Backend (offline signed RPC harness)",
  async () => {
    const x = await fixture();
    return {
      backend: x.backend,
      payer: x.payer.address,
      payee: x.merchant.address,
      unit: 100_000n,
      now: () => x.now,
      advance: (s) => {
        x.now += s;
      },
      unknownHoldId: addr(70),
      wrongMint: addr(71),
    };
  },
);
test("bigint above safe number survives signing, wire and decoding", async () => {
  const maximum = (1n << 63n) + 123n;
  const r = await f.backend.hold(req({ maximum }));
  expect((await f.backend.getStatus(r.holdId))!.maximum).toBe(maximum);
});
test.each([0n, -1n, U64_MAX + 1n, 1.5, 100])(
  "invalid maximum %s",
  async (maximum) => {
    await code(f.backend.hold(req({ maximum: maximum as bigint })), "amount");
    expect(f.sent).toHaveLength(0);
  },
);
test.each(["", "aa", "zz".repeat(32)])("invalid salt %s", async (salt) => {
  await code(f.backend.hold(req({ salt })), "invalid_salt");
  expect(f.sent).toHaveLength(0);
});
test.each([NaN, 1.5, 0, Number.MAX_SAFE_INTEGER + 1])(
  "invalid deadline %s",
  async (captureDeadline) => {
    await code(f.backend.hold(req({ captureDeadline })), "invalid_deadline");
  },
);
test("past/reversed deadlines and equal parties", async () => {
  await code(
    f.backend.hold(req({ captureDeadline: f.now })),
    "capture_deadline_expired",
  );
  await code(f.backend.hold(req({ refundDeadline: f.now })), "invalid_terms");
  await code(f.backend.hold(req({ payee: f.payer.address })), "invalid_terms");
});
test("genesis checked regardless of hostname", async () => {
  f.genesis = "mainnet";
  await code(f.backend.hold(req()), "invalid_network");
  expect(f.sent).toHaveLength(0);
});
test("wrong mint and mismatched signer", async () => {
  await code(f.backend.hold(req({ mint: addr(9) })), "wrong_mint");
  await code(f.backend.hold(req({ payer: addr(9) })), "invalid_signer");
  await code(f.backend.hold(req({ payee: addr(9) })), "invalid_signer");
  expect(f.sent).toHaveLength(0);
});
test.each(["executable", "owner", "digest", "slot", "pointer"])(
  "invalid deployment %s",
  async (k) => {
    const p = f.accounts.get(f.config.programId)!,
      d = f.accounts.get(f.config.programDataAddress)!;
    if (k === "executable") p.executable = false;
    if (k === "owner") p.owner = SYSTEM;
    if (k === "digest") d.data[45] ^= 1;
    if (k === "slot") d.data.writeBigUInt64LE(43n, 4);
    if (k === "pointer") p.data[4] ^= 1;
    await code(f.backend.hold(req()), "invalid_deployment");
    expect(f.sent).toHaveLength(0);
  },
);
test.each(["owner", "decimals", "initialized", "size"])(
  "invalid mint %s",
  async (k) => {
    const m = f.accounts.get(DEVNET_USDC_MINT)!;
    if (k === "owner") m.owner = SYSTEM;
    if (k === "decimals") m.data[44] = 9;
    if (k === "initialized") m.data[45] = 0;
    if (k === "size") m.data = Buffer.alloc(100);
    await code(f.backend.hold(req()), "wrong_mint");
  },
);
test.each(["missing", "owner", "mint", "wallet", "frozen"])(
  "canonical ATA %s",
  async (k) => {
    const a = f.accounts.get(f.payerAta)!;
    if (k === "missing") f.accounts.delete(f.payerAta);
    if (k === "owner") a.owner = SYSTEM;
    if (k === "mint") a.data[0] ^= 1;
    if (k === "wallet") a.data[32] ^= 1;
    if (k === "frozen") a.data[108] = 2;
    await code(f.backend.hold(req()), "invalid_token_account");
  },
);
test.each([
  "owner",
  "discriminator",
  "length",
  "pda",
  "state",
  "mint",
  "deadline",
])("invalid payment %s never returns null", async (k) => {
  const id = await open(),
    a = f.accounts.get(id)!;
  if (k === "owner") a.owner = SYSTEM;
  if (k === "discriminator") a.data[0] ^= 1;
  if (k === "length") a.data = a.data.subarray(0, 175);
  if (k === "pda") a.data[104] ^= 1;
  if (k === "state") a.data.writeBigUInt64LE(2_000_000n, 160);
  if (k === "mint") enc(addr(7)).copy(a.data, 72);
  if (k === "deadline") a.data.writeBigInt64LE((1n << 63n) - 1n, 152);
  await code(
    f.backend.getStatus(id),
    k === "mint"
      ? "wrong_mint"
      : k === "deadline"
        ? "invalid_deadline"
        : "invalid_payment",
  );
});
test("absence differs from read failure", async () => {
  await expect(f.backend.getStatus(addr(90))).resolves.toBeNull();
  f.failRead = true;
  await code(f.backend.getStatus(addr(90)), "rpc_unavailable");
});
test("USDC, SOL/rent and merchant refund liquidity", async () => {
  f.accounts.get(f.payerAta)!.data.writeBigUInt64LE(999_999n, 64);
  await code(f.backend.hold(req()), "insufficient_funds");
  f.accounts.get(f.payerAta)!.data.writeBigUInt64LE(1_000_000n, 64);
  f.balance = 3_000_000n;
  await code(f.backend.hold(req()), "insufficient_funds");
  f.balance = 100_000_000n;
  const id = await open();
  await f.backend.capture({
    holdId: id,
    amount: 600_000n,
    releaseRemainder: false,
    expectedHeld: 1_000_000n,
    expectedRefundable: 0n,
  });
  f.accounts.get(f.merchantAta)!.data.writeBigUInt64LE(0n, 64);
  await code(
    f.backend.refund({
      holdId: id,
      amount: 1n,
      expectedHeld: 400_000n,
      expectedRefundable: 600_000n,
    }),
    "insufficient_funds",
  );
});
test("duplicate salt is never resubmitted", async () => {
  await open();
  await code(f.backend.hold(req()), "payment_already_exists");
  expect(f.sent).toHaveLength(1);
});
test("simulation failure is pre-send", async () => {
  f.simulationError = { InstructionError: [0, "InvalidArgument"] };
  await code(f.backend.hold(req()), "simulation_failed");
  expect(f.sent).toHaveLength(0);
  expect(f.backend.pendingOperation).toBeUndefined();
});
test("only finalized err is confirmed failure", async () => {
  f.chainError = { InstructionError: [0, "InvalidArgument"] };
  await expect(f.backend.hold(req())).rejects.toMatchObject({
    name: "BackendError",
    phase: "confirmed_failure",
    code: "transaction_failed",
    details: { transactionError: f.chainError },
  });
  expect(f.sent).toHaveLength(1);
  expect(f.backend.pendingOperation).toBeUndefined();
});
test.each([
  "lostSend",
  "lostConfirmation",
  "returnedMismatch",
  "confirmedOnly",
])("UNKNOWN retains original and blocks new operations: %s", async (k) => {
  if (k === "confirmedOnly") f.status = "confirmed";
  else f[k as "lostSend" | "lostConfirmation" | "returnedMismatch"] = true;
  let error: BackendOutcomeUnknown | undefined;
  try {
    await open();
  } catch (e) {
    expect(e).toBeInstanceOf(BackendOutcomeUnknown);
    error = e as BackendOutcomeUnknown;
  }
  expect(error).toBeDefined();
  const e = error!.evidence;
  expect(e.salt).toBe(req().salt);
  expect(e.signedTransaction).toBe(f.sent[0]);
  expect(
    getSignatureFromTransaction(
      getTransactionDecoder().decode(
        Buffer.from(e.signedTransaction, "base64"),
      ),
    ),
  ).toBe(e.signature);
  expect(f.backend.pendingOperation).toBe(e);
  await expect(
    f.backend.hold(req({ salt: "bb".repeat(32) })),
  ).rejects.toMatchObject({
    name: "BackendError",
    code: "reconciliation_required",
    phase: "validation",
  });
  await expect(
    f.backend.release({
      holdId: e.holdId,
      expectedHeld: 1_000_000n,
      expectedRefundable: 0n,
    }),
  ).rejects.toMatchObject({
    name: "BackendError",
    code: "reconciliation_required",
    phase: "validation",
  });
  expect(f.sent).toHaveLength(1);
  expect(f.calls.filter((c) => c === "getLatestBlockhash")).toHaveLength(1);
  expect((await f.backend.getStatus(e.holdId))!.held).toBe(1_000_000n);
});
test("key loader safe errors", async () => {
  await code(loadDevnetSigner(""), "missing_keypair");
  await code(
    loadDevnetSigner("/nonexistent/synthetic.json"),
    "invalid_keypair",
  );
});

test("both H and F guards are independently enforced on every mutation", async () => {
  const holdId = await open();
  for (const guard of [
    { expectedHeld: 999_999n, expectedRefundable: 0n },
    { expectedHeld: 1_000_000n, expectedRefundable: 1n },
  ]) {
    await code(
      f.backend.capture({
        holdId,
        amount: 1n,
        releaseRemainder: false,
        ...guard,
      }),
      "unexpected_payment_state",
    );
    await code(
      f.backend.release({ holdId, ...guard }),
      "unexpected_payment_state",
    );
    await code(
      f.backend.refund({ holdId, amount: 1n, ...guard }),
      "unexpected_payment_state",
    );
  }
  await code(
    f.backend.release({
      holdId,
      expectedHeld: U64_MAX + 1n,
      expectedRefundable: 0n,
    }),
    "amount",
  );
  expect(f.sent).toHaveLength(1);
});
test("mutations verify configured account signers", async () => {
  const holdId = await open();
  // A different merchant still produces a well-formed PDA but is not the configured signer.
  enc(addr(55)).copy(f.accounts.get(holdId)!.data, 40);
  f.accounts.set(
    await ata(addr(55), address(DEVNET_USDC_MINT)),
    token(addr(55), 0n),
  );
  await code(
    f.backend.release({
      holdId,
      expectedHeld: 1_000_000n,
      expectedRefundable: 0n,
    }),
    "invalid_signer",
  );
});
test("vault delegate, close authority and backing are checked", async () => {
  const holdId = await open(),
    vault = f.accounts.get(
      await ata(address(holdId), address(DEVNET_USDC_MINT)),
    )!;
  for (const offset of [72, 129]) {
    vault.data.writeUInt32LE(1, offset);
    await code(f.backend.getStatus(holdId), "invalid_token_account");
    vault.data.writeUInt32LE(0, offset);
  }
  vault.data.writeBigUInt64LE(0n, 64);
  await code(f.backend.getStatus(holdId), "invalid_payment");
});
test("persistence failure prevents send", async () => {
  // Same validated synthetic RPC, with only the evidence seam replaced.
  const backend = new Capture402Backend(f.config, {
    rpc: f.rpc,
    loadSigner: async (p) => (p === "payer" ? f.payer : f.merchant),
    retainBeforeSend: async () => {
      throw Error("disk full");
    },
  });
  await code(backend.hold(req()), "evidence_unavailable");
  expect(f.sent).toHaveLength(0);
});

test("instruction ABI accounts, roles and guard offsets match the published contract", async () => {
  const {
    authorizeInstruction,
    captureInstruction,
    voidInstruction,
    refundInstruction,
  } = await import("../src/backend/capture402-abi/instructions.js");
  const { paymentAddress } = await import(
    "../src/backend/capture402-abi/program.js"
  );
  const payment = await paymentAddress(
    address(f.config.programId),
    f.payer.address,
    Buffer.from(req().salt, "hex"),
  );
  const vault = await ata(payment, address(DEVNET_USDC_MINT));
  const s = {
    programId: address(f.config.programId),
    payment,
    payer: f.payer.address,
    server: f.merchant.address,
    mint: address(DEVNET_USDC_MINT),
  };
  const auth = await authorizeInstruction({
    ...s,
    funder: f.payer.address,
    salt: Buffer.from(req().salt, "hex"),
    maximum: U64_MAX,
    captureDeadline: 123n,
    refundDeadline: 456n,
  });
  expect(auth.accounts!.map((a) => a.role)).toEqual([
    3, 0, 1, 0, 1, 1, 3, 0, 0, 0,
  ]);
  expect(Buffer.from(auth.data!).readBigUInt64LE(43)).toBe(U64_MAX);
  for (const [ix, tag, len, roles, keys, offset] of [
    [
      await captureInstruction(s, 7n, true, 9n, 11n),
      2,
      26,
      [2, 1, 0, 1, 1, 1, 0],
      [s.server, payment, s.mint, vault, f.merchantAta, f.payerAta, TOKEN],
      10,
    ],
    [
      await voidInstruction(s, 9n, 11n),
      3,
      17,
      [2, 1, 0, 1, 1, 0],
      [s.server, payment, s.mint, vault, f.payerAta, TOKEN],
      1,
    ],
    [
      await refundInstruction(s, 7n, 9n, 11n),
      4,
      25,
      [2, 1, 0, 1, 1, 0],
      [s.server, payment, s.mint, f.merchantAta, f.payerAta, TOKEN],
      9,
    ],
  ] as const) {
    expect(ix.accounts!.map((a) => a.address)).toEqual(keys);
    expect(ix.accounts!.map((a) => a.role)).toEqual(roles);
    const d = Buffer.from(ix.data!);
    expect(d[0]).toBe(tag);
    expect(d.length).toBe(len);
    expect(d.readBigUInt64LE(offset)).toBe(9n);
    expect(d.readBigUInt64LE(offset + 8)).toBe(11n);
  }
});

test("lost capture retains the original amount and guards, blocks all later writes", async () => {
  const holdId = await open();
  f.lostSend = true;
  await expect(
    f.backend.capture({
      holdId,
      amount: 600_000n,
      releaseRemainder: false,
      expectedHeld: 1_000_000n,
      expectedRefundable: 0n,
    }),
  ).rejects.toMatchObject({
    name: "BackendOutcomeUnknown",
    evidence: {
      operation: "capture",
      holdId,
      amount: "600000",
      expectedHeld: "1000000",
      expectedRefundable: "0",
    },
  });
  expect((await f.backend.getStatus(holdId))!.held).toBe(400_000n);
  await expect(
    f.backend.refund({
      holdId,
      amount: 1n,
      expectedHeld: 400_000n,
      expectedRefundable: 600_000n,
    }),
  ).rejects.toMatchObject({
    name: "BackendError",
    code: "reconciliation_required",
    phase: "validation",
  });
  expect(f.sent).toHaveLength(2);
});
test("failure to persist finalized observation keeps the pending latch", async () => {
  const backend = new Capture402Backend(f.config, {
    rpc: f.rpc,
    loadSigner: async (p) => (p === "payer" ? f.payer : f.merchant),
    retainBeforeSend: async () => {},
    retainFinalized: async () => {
      throw Error("disk full after send");
    },
  });
  await expect(backend.hold(req())).rejects.toBeInstanceOf(
    BackendOutcomeUnknown,
  );
  expect(backend.pendingOperation).toBeDefined();
  expect(f.sent).toHaveLength(1);
});

async function uncertainHold(): Promise<UnknownOperation> {
  f.lostSend = true;
  await expect(open()).rejects.toBeInstanceOf(BackendOutcomeUnknown);
  f.lostSend = false;
  return f.backend.pendingOperation!;
}

test("concurrent holds never report another operation's UNKNOWN evidence", async () => {
  const results = await Promise.allSettled([
    f.backend.hold(req()),
    f.backend.hold(req({ salt: "bb".repeat(32) })),
  ]);
  expect(results[0].status).toBe("fulfilled");
  expect(results[1]).toMatchObject({
    status: "rejected",
    reason: { name: "BackendError", code: "backend_busy", phase: "validation" },
  });
  const error = (results[1] as PromiseRejectedResult).reason;
  expect(error).not.toBeInstanceOf(BackendOutcomeUnknown);
  expect(error.evidence).toBeUndefined();
  expect(f.sent).toHaveLength(1);
  expect(f.calls.filter((c) => c === "getLatestBlockhash")).toHaveLength(1);
});
test("per-call onPrepared persists exact wire before submission and is awaited", async () => {
  let resume!: () => void;
  const blocked = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let prepared: UnknownOperation | undefined;
  const call = f.backend.hold(req(), {
    onPrepared: async (p) => {
      expect(f.sent).toHaveLength(0);
      expect(p.txSig).toBe(p.signature);
      expect(p.holdId).toBeTruthy();
      expect(p.lastValidBlockHeight).toBe("100");
      prepared = p;
      ready();
      await blocked;
    },
  });
  await entered;
  await code(f.backend.hold(req({ salt: "bb".repeat(32) })), "backend_busy");
  expect(f.sent).toHaveLength(0);
  resume();
  const receipt = await call;
  expect(receipt.txSig).toBe(prepared!.signature);
  expect(f.sent).toEqual([prepared!.signedTransaction]);
});
test("onPrepared failure prevents send and releases the mutex", async () => {
  await code(
    f.backend.hold(req(), {
      onPrepared: () => {
        throw Error("journal fsync failed");
      },
    }),
    "evidence_unavailable",
  );
  expect(f.sent).toHaveLength(0);
  expect(f.backend.pendingOperation).toBeUndefined();
  await open();
  expect(f.sent).toHaveLength(1);
});
test("each mutation invokes its per-call hook before sending", async () => {
  const holdId = await open(),
    seen: string[] = [];
  const options = {
    onPrepared: (p: UnknownOperation) => {
      expect(f.sent).toHaveLength(seen.length + 1);
      seen.push(p.operation);
    },
  };
  await f.backend.capture(
    {
      holdId,
      amount: 600_000n,
      releaseRemainder: false,
      expectedHeld: 1_000_000n,
      expectedRefundable: 0n,
    },
    options,
  );
  await f.backend.release(
    { holdId, expectedHeld: 400_000n, expectedRefundable: 600_000n },
    options,
  );
  await f.backend.refund(
    {
      holdId,
      amount: 200_000n,
      expectedHeld: 0n,
      expectedRefundable: 600_000n,
    },
    options,
  );
  expect(seen).toEqual(["capture", "release", "refund"]);
});
test("finalized original success reconciles the latch without resubmission", async () => {
  const evidence = await uncertainHold();
  const result = await f.backend.getTxOutcome(evidence);
  expect(result).toMatchObject({
    status: "landed",
    terminal: true,
    signature: evidence.signature,
    transactionError: null,
    payment: { held: 1_000_000n },
  });
  expect(f.backend.pendingOperation).toBeUndefined();
  expect(f.sent).toHaveLength(1);
  await f.backend.hold(req({ salt: "bb".repeat(32) }));
  expect(f.sent).toHaveLength(2);
});
test("finalized original failure clears the latch", async () => {
  f.chainError = { InstructionError: [0, "InvalidArgument"] };
  const e = await uncertainHold();
  expect(await f.backend.getTxOutcome(e)).toMatchObject({
    status: "failed",
    terminal: true,
    transactionError: f.chainError,
    payment: null,
  });
  expect(f.backend.pendingOperation).toBeUndefined();
  expect(f.sent).toHaveLength(1);
});
test.each([false, true])(
  "missing history stays unresolved even after expiry=%s and matching payment",
  async (expired) => {
    const e = await uncertainHold();
    f.historyAbsent = true;
    f.blockHeight = expired ? 101n : 100n;
    expect(await f.backend.getTxOutcome(e)).toMatchObject({
      status: "not_found",
      terminal: false,
      expired,
      payment: { held: 1_000_000n },
    });
    await code(
      f.backend.hold(req({ salt: "bb".repeat(32) })),
      "reconciliation_required",
    );
    expect(f.sent).toHaveLength(1);
  },
);
test("expiry and account absence alone do not erase original UNKNOWN", async () => {
  const e = await uncertainHold();
  f.historyAbsent = true;
  f.blockHeight = 101n;
  f.accounts.delete(e.holdId);
  expect(await f.backend.getTxOutcome(e)).toMatchObject({
    status: "not_found",
    terminal: false,
    expired: true,
    payment: null,
  });
  expect(f.backend.pendingOperation?.signature).toBe(e.signature);
});
test("confirmed-only failure remains pending", async () => {
  const e = await uncertainHold();
  f.status = "confirmed";
  f.chainError = { InstructionError: [0, "InvalidArgument"] };
  f.blockHeight = 101n;
  expect(await f.backend.getTxOutcome(e)).toMatchObject({
    status: "pending",
    terminal: false,
    expired: true,
  });
  expect(f.backend.pendingOperation?.signature).toBe(e.signature);
});
test("restart recovery imports original evidence and keeps it on RPC failure", async () => {
  const e = await uncertainHold();
  const restored = new Capture402Backend(f.config, { rpc: f.rpc });
  f.failRead = true;
  await code(restored.getTxOutcome(e), "rpc_unavailable");
  expect(restored.pendingOperation?.signature).toBe(e.signature);
  await code(
    restored.hold(req({ salt: "bb".repeat(32) })),
    "reconciliation_required",
  );
  f.failRead = false;
  expect(await restored.getTxOutcome(e)).toMatchObject({
    status: "landed",
    terminal: true,
  });
  expect(restored.pendingOperation).toBeUndefined();
  expect(f.sent).toHaveLength(1);
});
test("unrelated or tampered evidence cannot reconcile the original reservation", async () => {
  const e = await uncertainHold();
  for (const changed of [
    { holdId: addr(70) },
    { signature: "invalid" },
    { salt: "bb".repeat(32) },
    { programId: addr(70) },
    { lastValidBlockHeight: "0" },
    { amount: "1" },
  ]) {
    await code(
      f.backend.getTxOutcome({ ...e, ...changed }),
      "invalid_evidence",
    );
    expect(f.backend.pendingOperation?.signature).toBe(e.signature);
  }
  const reordered = Object.fromEntries(
    Object.entries(e).reverse(),
  ) as unknown as UnknownOperation;
  expect(await f.backend.getTxOutcome(reordered)).toMatchObject({
    status: "landed",
    terminal: true,
  });
});

test.each(["capture", "release", "refund"] as const)(
  "reconciliation binds original %s wire, signature and guards",
  async (operation) => {
    const holdId = await open();
    if (operation === "refund")
      await f.backend.capture({
        holdId,
        amount: 600_000n,
        releaseRemainder: false,
        expectedHeld: 1_000_000n,
        expectedRefundable: 0n,
      });
    f.lostSend = true;
    const call =
      operation === "capture"
        ? f.backend.capture({
            holdId,
            amount: 600_000n,
            releaseRemainder: false,
            expectedHeld: 1_000_000n,
            expectedRefundable: 0n,
          })
        : operation === "release"
          ? f.backend.release({
              holdId,
              expectedHeld: 1_000_000n,
              expectedRefundable: 0n,
            })
          : f.backend.refund({
              holdId,
              amount: 200_000n,
              expectedHeld: 400_000n,
              expectedRefundable: 600_000n,
            });
    await expect(call).rejects.toBeInstanceOf(BackendOutcomeUnknown);
    f.lostSend = false;
    const original = f.backend.pendingOperation!,
      sent = f.sent.length;
    expect(await f.backend.getTxOutcome(original)).toMatchObject({
      status: "landed",
      terminal: true,
      signature: original.signature,
    });
    expect(f.sent).toHaveLength(sent);
    expect(f.backend.pendingOperation).toBeUndefined();
  },
);
test("reconciliation snapshots are bounded by finalized signature slot and do not require today's spendability", async () => {
  const e = await uncertainHold();
  f.statusSlot = 60n;
  f.accounts.delete(f.merchantAta);
  expect(await f.backend.getTxOutcome(e)).toMatchObject({
    status: "landed",
    terminal: true,
    payment: { held: 1_000_000n },
  });
  expect(f.minContextSlots).toContain(60n);
  expect(f.sent).toHaveLength(1);
});
test("inconsistent finalized success with an absent persistent identity does not unlock writes", async () => {
  const e = await uncertainHold();
  f.accounts.delete(e.holdId);
  await code(f.backend.getTxOutcome(e), "invalid_payment");
  expect(f.backend.pendingOperation?.signature).toBe(e.signature);
  expect(f.sent).toHaveLength(1);
});

test("a stale account response cannot unlock a finalized reconciliation", async () => {
  const e = await uncertainHold();
  f.accountContextSlot = 1n;
  await code(f.backend.getTxOutcome(e), "rpc_unavailable");
  expect(f.backend.pendingOperation?.signature).toBe(e.signature);
});
