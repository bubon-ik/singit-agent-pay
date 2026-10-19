/** Trusted local devnet demo only. No delegate, facilitator, retry or RPC fallback. */
import { realpath, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getAddressDecoder,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import {
  ata,
  decodePayment,
  paymentAddress,
  PAYMENT_LEN,
  TOKEN_PROGRAM_ADDRESS,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  U64_MAX,
  type Payment,
} from "./capture402-abi/program.js";
import {
  authorizeInstruction,
  captureInstruction,
  voidInstruction,
  refundInstruction,
} from "./capture402-abi/instructions.js";
import {
  BackendError,
  BackendOutcomeUnknown,
  DEVNET_USDC_MINT,
  type CaptureRequest,
  type EscrowStatus,
  type HoldReceipt,
  type HoldRequest,
  type MandateTerms,
  type PaymentBackend,
  type RefundRequest,
  type ReleaseRequest,
  type TxReceipt,
  type UnknownOperation,
} from "./types.js";

export const CAPTURE402_ABI_COMMIT = "236b09a44240d285ee6f33d2e8dac79f81058e3d";
export const DEVNET_GENESIS_HASH =
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
const CLOCK = address("SysvarC1ock11111111111111111111111111111111");
const SYSVAR = address("Sysvar1111111111111111111111111111111111111");
const COMMITMENT = "finalized" as const;
const rpcOptions = () => ({ abortSignal: AbortSignal.timeout(15_000) });
export type Capture402Rpc = ReturnType<typeof createSolanaRpc>;

type Account = {
  owner: Address;
  executable: boolean;
  lamports: bigint;
  data: Buffer;
};
export interface Capture402Config {
  rpcUrl: string;
  programId: string;
  mint: string;
  payerKeypairPath: string;
  merchantKeypairPath: string;
  /** Independently reviewed upgradeable deployment; never populated with fixture defaults. */
  programDataAddress: string;
  /** SHA256 of the entire ProgramData executable payload after its 45-byte metadata (incl. padding). */
  executableSha256: string;
  deploymentSlot: bigint;
  confirmationTimeoutMs?: number;
}

/** HTTPS provider policy from capture402 integration/src/operator-rpc.ts; genesis is checked separately. */
export function assertDevnetRpc(url: string): void {
  try {
    const u = new URL(url);
    if (
      /\s/.test(url) ||
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.hash ||
      !(
        u.hostname.endsWith(".helius-rpc.com") ||
        u.hostname.endsWith(".helius.xyz") ||
        u.hostname.endsWith(".quiknode.pro")
      )
    )
      throw Error();
  } catch {
    throw new BackendError(
      "invalid_network",
      "Explicit HTTPS Helius or QuickNode RPC required; no public fallback (including mainnet URLs)",
    );
  }
}
function key(value: string): Address {
  try {
    return address(value);
  } catch {
    throw new BackendError("invalid_address", "Invalid base58 public key");
  }
}
function uint(value: bigint, positive = false): void {
  if (
    typeof value !== "bigint" ||
    value < (positive ? 1n : 0n) ||
    value > U64_MAX
  ) {
    throw new BackendError(
      "amount",
      "Amount/guard must be an integer u64 bigint in range",
    );
  }
}
function deadline(value: number): bigint {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new BackendError(
      "invalid_deadline",
      "Deadline must be positive safe integer unix seconds",
    );
  return BigInt(value);
}
const sha256 = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

/** Loads secrets inside the backend only; errors never include file contents or underlying exceptions. */
export async function loadDevnetSigner(path: string): Promise<KeyPairSigner> {
  if (!path)
    throw new BackendError(
      "missing_keypair",
      "Devnet keypair file path is required",
    );
  let raw: unknown;
  try {
    const location = await realpath(path);
    for (let parent = dirname(location); ; parent = dirname(parent)) {
      let trackedLocation = false;
      try {
        await stat(resolve(parent, ".git"));
        trackedLocation = true;
      } catch {
        /* no Git marker */
      }
      if (trackedLocation)
        throw Error("Key files must be outside Git checkouts");
      if (dirname(parent) === parent) break;
    }
    raw = JSON.parse(await readFile(location, "utf8"));
  } catch {
    throw new BackendError(
      "invalid_keypair",
      "Cannot read devnet keypair file",
    );
  }
  if (
    !Array.isArray(raw) ||
    raw.length !== 64 ||
    raw.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    throw new BackendError(
      "invalid_keypair",
      "Expected a 64-byte Solana keypair file",
    );
  }
  const bytes = Uint8Array.from(raw);
  try {
    return await createKeyPairSignerFromBytes(bytes);
  } catch {
    throw new BackendError("invalid_keypair", "Invalid devnet keypair");
  } finally {
    bytes.fill(0);
    raw.fill(0);
  }
}

/** Dependencies make synthetic offline RPC/signers possible without a network or secret fixture. */
export interface Capture402Dependencies {
  rpc?: Capture402Rpc;
  loadSigner?: typeof loadDevnetSigner;
  /** Persist original signed wire before any possible send. Sink failure prevents submission. */
  retainBeforeSend?: (evidence: UnknownOperation) => Promise<void>;
  /** Persist observed finalized outcome before releasing the volatile write latch. */
  retainFinalized?: (
    evidence: UnknownOperation,
    transactionError: unknown,
  ) => Promise<void>;
}

export class Capture402Backend implements PaymentBackend {
  readonly name = "capture402";
  private readonly rpc: Capture402Rpc;
  private readonly program: Address;
  private readonly programData: Address;
  private readonly loadSigner: typeof loadDevnetSigner;
  private uncertain?: UnknownOperation;
  private readonly retainBeforeSend?: Capture402Dependencies["retainBeforeSend"];
  private readonly retainFinalized?: Capture402Dependencies["retainFinalized"];

  constructor(
    private readonly config: Capture402Config,
    dependencies: Capture402Dependencies = {},
  ) {
    assertDevnetRpc(config.rpcUrl);
    this.program = key(config.programId);
    this.programData = key(config.programDataAddress);
    if (config.mint !== DEVNET_USDC_MINT)
      throw new BackendError(
        "wrong_mint",
        "Only Circle devnet USDC is allowed",
      );
    if (
      !/^[a-f0-9]{64}$/.test(config.executableSha256) ||
      typeof config.deploymentSlot !== "bigint" ||
      config.deploymentSlot < 0n
    ) {
      throw new BackendError(
        "invalid_deployment",
        "Reviewed executable SHA256 and deployment slot required",
      );
    }
    if (
      config.confirmationTimeoutMs !== undefined &&
      (!Number.isSafeInteger(config.confirmationTimeoutMs) ||
        config.confirmationTimeoutMs <= 0)
    ) {
      throw new BackendError(
        "invalid_config",
        "Positive confirmation timeout required",
      );
    }
    this.rpc = dependencies.rpc ?? createSolanaRpc(config.rpcUrl);
    this.loadSigner = dependencies.loadSigner ?? loadDevnetSigner;
    this.retainBeforeSend = dependencies.retainBeforeSend;
    this.retainFinalized = dependencies.retainFinalized;
  }

  /** Volatile reconciliation evidence only; durable reservations/journal belong to PaymentService. */
  get pendingOperation(): UnknownOperation | undefined {
    return this.uncertain;
  }

  async createMandate(_terms: MandateTerms): Promise<{ ref?: string }> {
    return {};
  }

  private writable(): void {
    if (this.uncertain) throw new BackendOutcomeUnknown(this.uncertain);
  }
  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof BackendError) throw err;
      throw new BackendError(
        "rpc_unavailable",
        "RPC read failed; absence or transaction failure is not established",
      );
    }
  }
  private async account(id: Address): Promise<Account | null> {
    return this.read(async () => {
      const { value } = await this.rpc
        .getAccountInfo(id, { encoding: "base64", commitment: COMMITMENT })
        .send(rpcOptions());
      if (value === null) return null;
      if (!Array.isArray(value.data) || value.data[1] !== "base64")
        throw new BackendError("invalid_account", "Expected base64 account");
      return {
        owner: value.owner,
        executable: value.executable,
        lamports: value.lamports,
        data: Buffer.from(value.data[0], "base64"),
      };
    });
  }

  private async environment(): Promise<void> {
    const genesis = await this.read(() =>
      this.rpc.getGenesisHash().send(rpcOptions()),
    );
    if (genesis !== DEVNET_GENESIS_HASH)
      throw new BackendError(
        "invalid_network",
        "RPC genesis hash is not Solana devnet",
      );
    const program = await this.account(this.program);
    if (
      !program ||
      !program.executable ||
      program.owner !== LOADER ||
      program.data.length !== 36 ||
      program.data.readUInt32LE(0) !== 2 ||
      getAddressDecoder().decode(program.data.subarray(4, 36)) !==
        this.programData
    ) {
      throw new BackendError(
        "invalid_deployment",
        "Program is not the reviewed upgradeable deployment",
      );
    }
    const data = await this.account(this.programData);
    if (
      !data ||
      data.executable ||
      data.owner !== LOADER ||
      data.data.length <= 45 ||
      data.data.readUInt32LE(0) !== 3 ||
      data.data.readBigUInt64LE(4) !== this.config.deploymentSlot ||
      ![0, 1].includes(data.data[12]) ||
      sha256(data.data.subarray(45)) !== this.config.executableSha256
    ) {
      throw new BackendError(
        "invalid_deployment",
        "ProgramData slot/executable digest differs from reviewed deployment",
      );
    }
    for (const id of [
      TOKEN_PROGRAM_ADDRESS,
      ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      SYSTEM_PROGRAM_ADDRESS,
    ]) {
      if (!(await this.account(id))?.executable)
        throw new BackendError(
          "invalid_deployment",
          "Required program is not executable",
        );
    }
    const mint = await this.account(address(DEVNET_USDC_MINT));
    if (
      !mint ||
      mint.executable ||
      mint.owner !== TOKEN_PROGRAM_ADDRESS ||
      mint.data.length !== 82 ||
      mint.data[44] !== 6 ||
      mint.data[45] !== 1 ||
      ![0, 1].includes(mint.data.readUInt32LE(0)) ||
      ![0, 1].includes(mint.data.readUInt32LE(46))
    ) {
      throw new BackendError(
        "wrong_mint",
        "Expected initialized classic SPL Circle devnet USDC mint with six decimals",
      );
    }
  }

  private async clock(): Promise<bigint> {
    const clock = await this.account(CLOCK);
    if (
      !clock ||
      clock.owner !== SYSVAR ||
      clock.data.length !== 40 ||
      clock.executable
    )
      throw new BackendError("invalid_account", "Invalid chain Clock sysvar");
    return clock.data.readBigInt64LE(32);
  }

  private async token(owner: Address, vault = false): Promise<bigint> {
    const account = await this.account(
      await ata(owner, address(DEVNET_USDC_MINT)),
    );
    if (
      !account ||
      account.executable ||
      account.owner !== TOKEN_PROGRAM_ADDRESS ||
      account.data.length !== 165 ||
      getAddressDecoder().decode(account.data.subarray(0, 32)) !==
        DEVNET_USDC_MINT ||
      getAddressDecoder().decode(account.data.subarray(32, 64)) !== owner ||
      account.data[108] !== 1 ||
      account.data.readUInt32LE(109) !== 0 ||
      ![0, 1].includes(account.data.readUInt32LE(72)) ||
      ![0, 1].includes(account.data.readUInt32LE(129)) ||
      (vault &&
        (account.data.readUInt32LE(72) !== 0 ||
          account.data.readUInt32LE(129) !== 0))
    ) {
      throw new BackendError(
        "invalid_token_account",
        "Missing or invalid canonical classic SPL ATA",
      );
    }
    return account.data.readBigUInt64LE(64);
  }

  private async payment(holdId: string): Promise<Payment | null> {
    const id = key(holdId),
      account = await this.account(id);
    if (account === null) return null;
    const p = decodePayment(account.data);
    if (
      account.executable ||
      account.owner !== this.program ||
      !p ||
      (await paymentAddress(this.program, p.payer, p.salt)) !== id
    ) {
      throw new BackendError(
        "invalid_payment",
        "Payment owner, discriminator, size, state or PDA invalid",
      );
    }
    if (p.mint !== DEVNET_USDC_MINT)
      throw new BackendError(
        "wrong_mint",
        "Payment mint is not Circle devnet USDC",
      );
    if (
      p.captureDeadline > BigInt(Number.MAX_SAFE_INTEGER) ||
      p.refundDeadline > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new BackendError(
        "invalid_deadline",
        "On-chain deadlines cannot be represented exactly by backend interface",
      );
    }
    await this.token(p.payer);
    await this.token(p.server);
    if ((await this.token(id, true)) < p.held)
      throw new BackendError(
        "invalid_payment",
        "Vault balance below held amount",
      );
    return p;
  }

  async getStatus(holdId: string): Promise<EscrowStatus | null> {
    key(holdId);
    await this.environment();
    const p = await this.payment(holdId);
    return p === null
      ? null
      : {
          holdId,
          payer: p.payer,
          payee: p.server,
          mint: p.mint,
          maximum: p.maximum,
          held: p.held,
          refundable: p.refundable,
          captureDeadline: Number(p.captureDeadline),
          refundDeadline: Number(p.refundDeadline),
        };
  }

  async hold(req: HoldRequest): Promise<HoldReceipt> {
    this.writable();
    const payer = key(req.payer),
      server = key(req.payee);
    if (req.mint !== DEVNET_USDC_MINT)
      throw new BackendError("wrong_mint", "Only Circle devnet USDC allowed");
    uint(req.maximum, true);
    if (!/^[0-9a-fA-F]{64}$/.test(req.salt))
      throw new BackendError(
        "invalid_salt",
        "Salt must be exactly 32 hex bytes",
      );
    const dc = deadline(req.captureDeadline),
      dr = deadline(req.refundDeadline);
    if (payer === server || dr < dc)
      throw new BackendError(
        "invalid_terms",
        "Distinct payer/merchant and ordered deadlines required",
      );
    await this.environment();
    if ((await this.clock()) >= dc)
      throw new BackendError(
        "capture_deadline_expired",
        "Capture deadline must be in the future on chain",
      );
    const signer = await this.loadSigner(this.config.payerKeypairPath);
    const merchant = await this.loadSigner(this.config.merchantKeypairPath);
    if (signer.address !== payer || merchant.address !== server)
      throw new BackendError(
        "invalid_signer",
        "Configured payer/merchant does not match request",
      );
    const salt = Buffer.from(req.salt, "hex");
    const payment = await paymentAddress(this.program, payer, salt);
    const existing = await this.account(payment);
    if (
      existing &&
      (existing.owner !== SYSTEM_PROGRAM_ADDRESS ||
        existing.data.length !== 0 ||
        existing.executable)
    ) {
      throw new BackendError(
        "payment_already_exists",
        "Payment identity already used; do not create another salt to retry",
      );
    }
    if ((await this.token(payer)) < req.maximum)
      throw new BackendError(
        "insufficient_funds",
        "Payer ATA has insufficient USDC",
      );
    await this.token(server);
    const vault = await this.account(await ata(payment, address(req.mint)));
    if (vault) await this.token(payment, true);
    const paymentRent = await this.read(() =>
      this.rpc
        .getMinimumBalanceForRentExemption(BigInt(PAYMENT_LEN), {
          commitment: COMMITMENT,
        })
        .send(rpcOptions()),
    );
    const vaultRent = vault
      ? 0n
      : await this.read(() =>
          this.rpc
            .getMinimumBalanceForRentExemption(165n, { commitment: COMMITMENT })
            .send(rpcOptions()),
        );
    const rent =
      (paymentRent > (existing?.lamports ?? 0n)
        ? paymentRent - (existing?.lamports ?? 0n)
        : 0n) + vaultRent;
    const instruction = await authorizeInstruction({
      programId: this.program,
      payer,
      server,
      mint: address(req.mint),
      funder: payer,
      salt,
      maximum: req.maximum,
      captureDeadline: dc,
      refundDeadline: dr,
    });
    return {
      holdId: payment,
      ...(await this.submit(instruction, signer, rent, {
        operation: "hold",
        holdId: payment,
        salt: req.salt,
        amount: req.maximum.toString(),
      })),
    };
  }

  /** Read-only planning snapshot; amounts/rent/fees stay in atomic bigint units. */
  async preflight(payerAddress: string, merchantAddress: string) {
    const payer = key(payerAddress),
      merchant = key(merchantAddress);
    await this.environment();
    if (payer === merchant)
      throw new BackendError(
        "invalid_terms",
        "Distinct demo identities required",
      );
    return {
      payerUsdc: await this.token(payer),
      merchantUsdc: await this.token(merchant),
      payerLamports: (
        await this.read(() =>
          this.rpc
            .getBalance(payer, { commitment: COMMITMENT })
            .send(rpcOptions()),
        )
      ).value,
      merchantLamports: (
        await this.read(() =>
          this.rpc
            .getBalance(merchant, { commitment: COMMITMENT })
            .send(rpcOptions()),
        )
      ).value,
      paymentRent: await this.read(() =>
        this.rpc
          .getMinimumBalanceForRentExemption(176n, { commitment: COMMITMENT })
          .send(rpcOptions()),
      ),
      vaultRent: await this.read(() =>
        this.rpc
          .getMinimumBalanceForRentExemption(165n, { commitment: COMMITMENT })
          .send(rpcOptions()),
      ),
      now: await this.clock(),
    };
  }

  private async mutation(
    req: ReleaseRequest,
    operation: "capture" | "release" | "refund",
    amount?: bigint,
    releaseRemainder = false,
  ): Promise<TxReceipt> {
    this.writable();
    key(req.holdId);
    uint(req.expectedHeld);
    uint(req.expectedRefundable);
    if (operation !== "release") uint(amount!, true);
    await this.environment();
    const p = await this.payment(req.holdId);
    if (!p)
      throw new BackendError(
        "payment_not_found",
        "Payment account absent at finalized commitment",
      );
    const signer = await this.loadSigner(this.config.merchantKeypairPath);
    const payer = await this.loadSigner(this.config.payerKeypairPath);
    if (signer.address !== p.server || payer.address !== p.payer)
      throw new BackendError(
        "invalid_signer",
        "Configured signers differ from payment",
      );
    if (p.held !== req.expectedHeld || p.refundable !== req.expectedRefundable)
      throw new BackendError("unexpected_payment_state", "Stale H/F guards");
    const now = await this.clock();
    if (operation === "capture" && now >= p.captureDeadline)
      throw new BackendError(
        "capture_deadline_expired",
        "Capture window closed on chain",
      );
    if (operation === "refund" && now >= p.refundDeadline)
      throw new BackendError(
        "refund_deadline_expired",
        "Refund window closed on chain",
      );
    if (operation === "release" && p.held === 0n)
      throw new BackendError("empty_hold", "Nothing held");
    if (
      amount !== undefined &&
      amount > (operation === "capture" ? p.held : p.refundable)
    )
      throw new BackendError("amount", "Amount exceeds held/refundable");
    if (operation === "refund" && (await this.token(p.server)) < amount!)
      throw new BackendError(
        "insufficient_funds",
        "Merchant ATA has insufficient USDC for refund",
      );
    const stored = {
      programId: this.program,
      payment: key(req.holdId),
      payer: p.payer,
      server: p.server,
      mint: p.mint,
    };
    const instruction =
      operation === "capture"
        ? await captureInstruction(
            stored,
            amount!,
            releaseRemainder,
            req.expectedHeld,
            req.expectedRefundable,
          )
        : operation === "release"
          ? await voidInstruction(
              stored,
              req.expectedHeld,
              req.expectedRefundable,
            )
          : await refundInstruction(
              stored,
              amount!,
              req.expectedHeld,
              req.expectedRefundable,
            );
    return this.submit(instruction, signer, 0n, {
      operation,
      holdId: req.holdId,
      expectedHeld: req.expectedHeld.toString(),
      expectedRefundable: req.expectedRefundable.toString(),
      amount: amount?.toString(),
    });
  }

  capture(req: CaptureRequest): Promise<TxReceipt> {
    if (typeof req.releaseRemainder !== "boolean")
      return Promise.reject(
        new BackendError("invalid_terms", "releaseRemainder must be boolean"),
      );
    return this.mutation(req, "capture", req.amount, req.releaseRemainder);
  }
  release(req: ReleaseRequest): Promise<TxReceipt> {
    return this.mutation(req, "release");
  }
  refund(req: RefundRequest): Promise<TxReceipt> {
    return this.mutation(req, "refund", req.amount);
  }

  private async submit(
    instruction: Instruction,
    signer: KeyPairSigner,
    rent: bigint,
    identity: Pick<
      UnknownOperation,
      | "operation"
      | "holdId"
      | "salt"
      | "amount"
      | "expectedHeld"
      | "expectedRefundable"
    >,
  ): Promise<TxReceipt> {
    this.writable();
    const { value: lifetime } = await this.read(() =>
      this.rpc
        .getLatestBlockhash({ commitment: COMMITMENT })
        .send(rpcOptions()),
    );
    const message = pipe(
      createTransactionMessage({ version: "legacy" }),
      (m) => setTransactionMessageFeePayer(signer.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => appendTransactionMessageInstructions([instruction], m),
    );
    const unsigned = compileTransaction(message);
    const messageBase64 = getBase64Decoder().decode(unsigned.messageBytes);
    const { value: fee } = await this.read(() =>
      this.rpc
        .getFeeForMessage(
          messageBase64 as Parameters<Capture402Rpc["getFeeForMessage"]>[0],
          { commitment: COMMITMENT },
        )
        .send(rpcOptions()),
    );
    if (fee === null)
      throw new BackendError(
        "fee_unavailable",
        "Fee quote unavailable; nothing sent",
      );
    const balance = await this.read(() =>
      this.rpc
        .getBalance(signer.address, { commitment: COMMITMENT })
        .send(rpcOptions()),
    );
    if (balance.value < rent + fee)
      throw new BackendError(
        "insufficient_funds",
        "Signer needs SOL for quoted fee and account rent",
      );
    const tx = await partiallySignTransaction([signer.keyPair], unsigned);
    const txSig = getSignatureFromTransaction(tx);
    const wire = getBase64EncodedWireTransaction(tx);
    const simulation = await this.read(() =>
      this.rpc
        .simulateTransaction(wire, {
          encoding: "base64",
          commitment: COMMITMENT,
          sigVerify: true,
        })
        .send(rpcOptions()),
    );
    if (simulation.value.err !== null)
      throw new BackendError(
        "simulation_failed",
        "Simulation rejected original transaction; nothing submitted",
      );
    // Recheck upgrade/network/mint immediately before sending. Still no atomic deployment pin on chain.
    await this.environment();
    this.writable();
    const evidence: UnknownOperation = Object.freeze({
      ...identity,
      signature: txSig,
      signedTransaction: wire,
      blockhash: lifetime.blockhash,
      lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(),
      programId: this.program,
      genesisHash: DEVNET_GENESIS_HASH,
      abiCommit: CAPTURE402_ABI_COMMIT,
    });
    // Reserve before possible send, including concurrent callers. Never clear on an ambiguous error.
    this.uncertain = evidence;
    try {
      await this.retainBeforeSend?.(evidence);
    } catch {
      this.uncertain = undefined;
      throw new BackendError(
        "evidence_unavailable",
        "Cannot persist original transaction; nothing sent",
      );
    }
    try {
      const returned = await this.rpc
        .sendTransaction(wire, {
          encoding: "base64",
          skipPreflight: false,
          preflightCommitment: COMMITMENT,
          maxRetries: 0n,
        })
        .send(rpcOptions());
      if (returned !== txSig) throw Error("Signature mismatch");
      const end = Date.now() + (this.config.confirmationTimeoutMs ?? 60_000);
      while (Date.now() < end) {
        const { value } = await this.rpc
          .getSignatureStatuses([txSig], { searchTransactionHistory: true })
          .send(rpcOptions());
        const status = value[0];
        if (status?.confirmationStatus === COMMITMENT) {
          if (!Object.hasOwn(status, "err") || status.err === undefined)
            throw Error("Malformed status");
          await this.retainFinalized?.(evidence, status.err);
          this.uncertain = undefined;
          if (status.err !== null)
            throw new BackendError(
              "transaction_failed",
              "Original transaction finalized with err != null",
              "confirmed_failure",
              { signature: txSig, transactionError: status.err },
            );
          return { txSig };
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } catch (err) {
      if (err instanceof BackendError && err.phase === "confirmed_failure")
        throw err;
      throw new BackendOutcomeUnknown(evidence);
    }
    throw new BackendOutcomeUnknown(evidence);
  }
}
