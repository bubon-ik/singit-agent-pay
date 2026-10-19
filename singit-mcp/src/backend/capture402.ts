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
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getPublicKeyFromAddress,
  verifySignature,
  getAddressDecoder,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isSolanaError,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import {
  ata,
  decodePayment,
  decodeInstructionData,
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
  type BackendTxOutcome,
  type SubmitContext,
  type TxOutcome,
  type TxOutcomeQuery,
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
import { RpcRequestScheduler } from "./rpc-request-scheduler.js";

export const CAPTURE402_ABI_COMMIT = "236b09a44240d285ee6f33d2e8dac79f81058e3d";
export const DEVNET_GENESIS_HASH =
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
const CLOCK = address("SysvarC1ock11111111111111111111111111111111");
const SYSVAR = address("Sysvar1111111111111111111111111111111111111");
const COMMITMENT = "finalized" as const;
const rpcOptions = () => ({ abortSignal: AbortSignal.timeout(15_000) });
const evidenceFields = [
  "operation",
  "holdId",
  "salt",
  "amount",
  "expectedHeld",
  "expectedRefundable",
  "signature",
  "signedTransaction",
  "blockhash",
  "lastValidBlockHeight",
  "programId",
  "genesisHash",
  "abiCommit",
] as const;
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
  /** Optional no-upgrade window pin; null means immutable. Required by the merchant profile. */
  upgradeAuthority?: string | null;
  confirmationTimeoutMs?: number;
  /** Space RPC starts within this backend instance; independent of provider quotas. */
  rpcMinIntervalMs?: number;
  /** Only read-side HTTP 429 responses may retry, at most three times. */
  rpcReadRetries?: number;
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
  private busy = false;
  private readonly scheduler: RpcRequestScheduler;
  private readonly retainBeforeSend?: Capture402Dependencies["retainBeforeSend"];
  private readonly retainFinalized?: Capture402Dependencies["retainFinalized"];

  constructor(
    private readonly config: Capture402Config,
    dependencies: Capture402Dependencies = {},
  ) {
    assertDevnetRpc(config.rpcUrl);
    this.program = key(config.programId);
    this.programData = key(config.programDataAddress);
    if (config.upgradeAuthority !== undefined && config.upgradeAuthority !== null) key(config.upgradeAuthority);
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
    try {
      this.scheduler = new RpcRequestScheduler(
        config.rpcMinIntervalMs ?? 100,
        config.rpcReadRetries ?? 3,
      );
    } catch {
      throw new BackendError("invalid_config", "Invalid RPC scheduling limits");
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

  /** Non-secret identity attestation for local clients, available only with an authority pin. */
  deploymentProfile(payer: string, merchant: string) {
    if (this.config.upgradeAuthority === undefined) return undefined;
    key(payer); key(merchant);
    if (payer === merchant) throw new BackendError('invalid_terms', 'Distinct demo identities required');
    return Object.freeze({ schema: 1, name: 'devnet', network: `solana:${DEVNET_GENESIS_HASH.slice(0, 32)}`,
      genesisHash: DEVNET_GENESIS_HASH, programId: this.program, programDataAddress: this.programData,
      executableSha256: this.config.executableSha256, deploymentSlot: this.config.deploymentSlot.toString(),
      upgradeAuthority: this.config.upgradeAuthority, abiCommit: CAPTURE402_ABI_COMMIT,
      mint: DEVNET_USDC_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS, payer, merchant });
  }

  async createMandate(_terms: MandateTerms): Promise<{ ref?: string }> {
    return {};
  }

  private writable(): void {
    if (this.uncertain)
      throw new BackendError(
        "reconciliation_required",
        "An original operation is unresolved; reconcile it before another write",
      );
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy)
      throw new BackendError(
        "backend_busy",
        "Another operation is already running; this call sent nothing",
      );
    this.busy = true;
    try {
      return await operation();
    } finally {
      this.busy = false;
    }
  }
  private async read<T>(
    method: string,
    fn: (options: ReturnType<typeof rpcOptions>) => Promise<T>,
    signal = rpcOptions().abortSignal,
  ): Promise<T> {
    try {
      return await this.scheduler.read(signal, abortSignal => fn({ abortSignal }));
    } catch (err) {
      if (err instanceof BackendError) throw err;
      const http = isSolanaError(err, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)
        ? ` (HTTP ${err.context.statusCode})`
        : "";
      const message = `RPC ${method} read failed${http}; absence or transaction failure is not established`;
      // Fixed method names and numeric HTTP status only; never log provider exceptions.
      console.error(`capture402: ${message}`);
      throw new BackendError(
        "rpc_unavailable",
        message,
      );
    }
  }
  private async account(
    id: Address,
    minContextSlot?: bigint,
  ): Promise<Account | null> {
    return this.read("getAccountInfo", async options => {
      const { value, context } = await this.rpc
        .getAccountInfo(id, {
          encoding: "base64",
          commitment: COMMITMENT,
          ...(minContextSlot === undefined ? {} : { minContextSlot }),
        })
        .send(options);
      if (
        minContextSlot !== undefined &&
        (!context ||
          typeof context.slot !== "bigint" ||
          context.slot < minContextSlot)
      ) {
        throw new BackendError(
          "rpc_unavailable",
          "Account snapshot is behind the finalized reconciliation boundary",
        );
      }
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

  private environmentFailure?: BackendError;
  private environmentObservers?: Set<() => void>;

  /** Runtime latches admission closed on a verified identity mismatch, including one found by
   * a read/reconciliation. No polling, signing or RPC is added by registering an observer. */
  onEnvironmentFailure(observer: () => void): () => void {
    (this.environmentObservers ??= new Set()).add(observer);
    if (this.environmentFailure) observer();
    return () => { this.environmentObservers?.delete(observer); };
  }

  private assertEnvironmentHealthy(): void {
    if (this.environmentFailure) throw this.environmentFailure;
  }

  private async environment(): Promise<void> {
    this.assertEnvironmentHealthy();
    try {
      await this.verifyEnvironment();
    } catch (error) {
      if (error instanceof BackendError && ["invalid_network", "invalid_deployment", "wrong_mint"].includes(error.code)) {
        this.environmentFailure = error;
        for (const observer of this.environmentObservers ?? []) observer();
      }
      throw error;
    }
    // Another verifier may have latched a failure while this one was awaiting RPC.
    this.assertEnvironmentHealthy();
  }

  private async verifyEnvironment(): Promise<void> {
    const genesis = await this.read("getGenesisHash", options =>
      this.rpc.getGenesisHash().send(options),
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
    if (this.config.upgradeAuthority !== undefined) {
      const actual = data.data[12] === 0 ? null : getAddressDecoder().decode(data.data.subarray(13, 45));
      if (actual !== this.config.upgradeAuthority) throw new BackendError(
        'invalid_deployment', 'ProgramData upgrade authority differs from the verification-window pin',
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

  private async payment(
    holdId: string,
    minContextSlot?: bigint,
    requireSpendableAccounts = true,
  ): Promise<Payment | null> {
    const id = key(holdId),
      account = await this.account(id, minContextSlot);
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
    if (!requireSpendableAccounts) return p;
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

  hold(req: HoldRequest, options?: SubmitContext): Promise<HoldReceipt> {
    return this.exclusive(() => this.holdOnce(req, options));
  }

  private async holdOnce(
    req: HoldRequest,
    options?: SubmitContext,
  ): Promise<HoldReceipt> {
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
    const paymentRent = await this.read("getMinimumBalanceForRentExemption", options =>
      this.rpc
        .getMinimumBalanceForRentExemption(BigInt(PAYMENT_LEN), {
          commitment: COMMITMENT,
        })
        .send(options),
    );
    const vaultRent = vault
      ? 0n
      : await this.read("getMinimumBalanceForRentExemption", options =>
          this.rpc
            .getMinimumBalanceForRentExemption(165n, { commitment: COMMITMENT })
            .send(options),
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
      ...(await this.submit(
        instruction,
        signer,
        rent,
        {
          operation: "hold",
          holdId: payment,
          salt: req.salt,
          amount: req.maximum.toString(),
        },
        options,
      )),
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
        await this.read("getBalance", options =>
          this.rpc.getBalance(payer, { commitment: COMMITMENT }).send(options),
        )
      ).value,
      merchantLamports: (
        await this.read("getBalance", options =>
          this.rpc.getBalance(merchant, { commitment: COMMITMENT }).send(options),
        )
      ).value,
      paymentRent: await this.read("getMinimumBalanceForRentExemption", options =>
        this.rpc
          .getMinimumBalanceForRentExemption(176n, { commitment: COMMITMENT })
          .send(options),
      ),
      vaultRent: await this.read("getMinimumBalanceForRentExemption", options =>
        this.rpc
          .getMinimumBalanceForRentExemption(165n, { commitment: COMMITMENT })
          .send(options),
      ),
      now: await this.clock(),
    };
  }

  private async mutation(
    req: ReleaseRequest,
    operation: "capture" | "release" | "refund",
    amount?: bigint,
    releaseRemainder = false,
    options?: SubmitContext,
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
    return this.submit(
      instruction,
      signer,
      0n,
      {
        operation,
        holdId: req.holdId,
        expectedHeld: req.expectedHeld.toString(),
        expectedRefundable: req.expectedRefundable.toString(),
        amount: amount?.toString(),
      },
      options,
    );
  }

  capture(
    req: CaptureRequest,
    options?: SubmitContext,
  ): Promise<TxReceipt> {
    if (typeof req.releaseRemainder !== "boolean")
      return Promise.reject(
        new BackendError("invalid_terms", "releaseRemainder must be boolean"),
      );
    return this.exclusive(() =>
      this.mutation(req, "capture", req.amount, req.releaseRemainder, options),
    );
  }
  release(
    req: ReleaseRequest,
    options?: SubmitContext,
  ): Promise<TxReceipt> {
    return this.exclusive(() =>
      this.mutation(req, "release", undefined, false, options),
    );
  }
  refund(
    req: RefundRequest,
    options?: SubmitContext,
  ): Promise<TxReceipt> {
    return this.exclusive(() =>
      this.mutation(req, "refund", req.amount, false, options),
    );
  }

  /** Reconcile only the original signed operation, including after a process restart. */
  getTxOutcome(query: TxOutcomeQuery): Promise<TxOutcome>;
  getTxOutcome(evidence: UnknownOperation): Promise<BackendTxOutcome>;
  async getTxOutcome(
    query: TxOutcomeQuery | UnknownOperation,
  ): Promise<TxOutcome | BackendTxOutcome> {
    if (!("kind" in query)) return this.reconcileEvidence(query);
    const evidence = query.evidence ?? this.uncertain;
    // A legacy journal without the original wire cannot prove a terminal outcome.
    if (!evidence) return { status: "pending" };
    if (
      query.kind !== evidence.operation ||
      query.txSig !== evidence.signature ||
      (query.holdId !== null && query.holdId !== evidence.holdId) ||
      (query.salt !== undefined && query.salt !== evidence.salt) ||
      (query.lastValidBlockHeight !== undefined &&
        (!Number.isSafeInteger(query.lastValidBlockHeight) ||
          String(query.lastValidBlockHeight) !== evidence.lastValidBlockHeight))
    ) {
      throw new BackendError("invalid_evidence", "Query differs from the original operation");
    }
    const result = await this.reconcileEvidence(evidence);
    // PaymentService treats not_found as terminal. Missing RPC history is only pending here.
    if (!result.terminal) return { status: "pending" };
    return result.status === "landed"
      ? { status: "executed", txSig: result.signature, holdId: evidence.holdId }
      : { status: "failed", code: "transaction_failed" };
  }

  private reconcileEvidence(evidence: UnknownOperation): Promise<BackendTxOutcome> {
    return this.exclusive(async () => {
      await this.validateEvidence(evidence);
      if (
        this.uncertain &&
        (this.uncertain.signature !== evidence.signature ||
          this.uncertain.signedTransaction !== evidence.signedTransaction ||
          evidenceFields.some(
            (name) => evidence[name] !== this.uncertain![name],
          ))
      ) {
        throw new BackendError(
          "invalid_evidence",
          "Evidence differs from the original unresolved operation",
        );
      }
      // Import the durable reservation before reads; an RPC error must not unlock a restarted instance.
      this.uncertain = Object.freeze({ ...evidence });
      await this.environment();
      const epoch = await this.read("getEpochInfo", options =>
        this.rpc.getEpochInfo({ commitment: COMMITMENT }).send(options),
      );
      const { value } = await this.read("getSignatureStatuses", options =>
        this.rpc
          .getSignatureStatuses(
            [
              getSignatureFromTransaction(
                getTransactionDecoder().decode(
                  Buffer.from(evidence.signedTransaction, "base64"),
                ),
              ),
            ],
            { searchTransactionHistory: true },
          )
          .send(options),
      );
      if (!Array.isArray(value) || value.length !== 1)
        throw new BackendError(
          "rpc_unavailable",
          "Malformed original signature response",
        );
      const status = value[0];
      const finalized = status?.confirmationStatus === COMMITMENT;
      if (
        typeof epoch.blockHeight !== "bigint" ||
        typeof epoch.absoluteSlot !== "bigint" ||
        epoch.blockHeight < 0n ||
        epoch.absoluteSlot < 0n ||
        (finalized &&
          (typeof status.slot !== "bigint" ||
            !Object.hasOwn(status, "err") ||
            status.err === undefined))
      ) {
        throw new BackendError(
          "rpc_unavailable",
          "Malformed reconciliation response; outcome remains unresolved",
        );
      }
      const minimumSlot =
        finalized && status.slot > epoch.absoluteSlot
          ? status.slot
          : epoch.absoluteSlot;
      const p = await this.payment(evidence.holdId, minimumSlot, false);
      const payment: EscrowStatus | null = p
        ? {
            holdId: evidence.holdId,
            payer: p.payer,
            payee: p.server,
            mint: p.mint,
            maximum: p.maximum,
            held: p.held,
            refundable: p.refundable,
            captureDeadline: Number(p.captureDeadline),
            refundDeadline: Number(p.refundDeadline),
          }
        : null;
      if (finalized && status.err === null && !payment) {
        throw new BackendError(
          "invalid_payment",
          "Finalized success has no persistent payment identity; retain reservation",
        );
      }
      const result: BackendTxOutcome = {
        status: finalized
          ? status.err === null
            ? "landed"
            : "failed"
          : status
            ? "pending"
            : "not_found",
        signature: evidence.signature,
        terminal: finalized,
        expired: epoch.blockHeight > BigInt(evidence.lastValidBlockHeight),
        blockHeight: epoch.blockHeight.toString(),
        payment,
        ...(finalized
          ? { slot: status.slot.toString(), transactionError: status.err }
          : {}),
      };
      if (finalized) {
        // State/expiry are observations, never a substitute for original-signature finality.
        try {
          await this.retainFinalized?.(evidence, status.err);
        } catch {
          throw new BackendError(
            "evidence_unavailable",
            "Cannot retain finalized observation; reservation remains unresolved",
          );
        }
        this.uncertain = undefined;
      }
      return result;
    });
  }

  private async validateEvidence(e: UnknownOperation): Promise<void> {
    try {
      if (
        e.programId !== this.program ||
        e.genesisHash !== DEVNET_GENESIS_HASH ||
        e.abiCommit !== CAPTURE402_ABI_COMMIT ||
        !/^\d+$/.test(e.lastValidBlockHeight) ||
        BigInt(e.lastValidBlockHeight) > U64_MAX
      )
        throw Error();
      const tx = getTransactionDecoder().decode(
        Buffer.from(e.signedTransaction, "base64"),
      );
      if (
        getBase64EncodedWireTransaction(tx) !== e.signedTransaction ||
        getSignatureFromTransaction(tx) !== e.signature
      )
        throw Error();
      const message = getCompiledTransactionMessageDecoder().decode(
        tx.messageBytes,
      );
      if (
        message.version !== "legacy" ||
        message.lifetimeToken !== e.blockhash ||
        message.header.numSignerAccounts !== 1
      )
        throw Error();
      const instructions = decompileTransactionMessage(message).instructions;
      if (instructions.length !== 1) throw Error();
      const ix = instructions[0],
        data = decodeInstructionData(Uint8Array.from(ix.data ?? []));
      if (ix.programAddress !== this.program || !data || data.op === "reclaim")
        throw Error();
      const expectedOp =
        e.operation === "hold"
          ? "authorize"
          : e.operation === "release"
            ? "void"
            : e.operation;
      if (
        data.op !== expectedOp ||
        ix.accounts?.[data.op === "authorize" ? 2 : 1]?.address !==
          key(e.holdId) ||
        ix.accounts?.[data.op === "authorize" ? 3 : 2]?.address !==
          DEVNET_USDC_MINT
      )
        throw Error();
      if (data.op === "authorize") {
        if (
          e.salt?.toLowerCase() !== Buffer.from(data.salt).toString("hex") ||
          (e.amount !== undefined && e.amount !== data.maximum.toString()) ||
          (await paymentAddress(
            this.program,
            message.staticAccounts[0],
            data.salt,
          )) !== e.holdId
        )
          throw Error();
      } else if (
        e.expectedHeld !== data.expectedHeld.toString() ||
        e.expectedRefundable !== data.expectedRefundable.toString() ||
        (data.op !== "void" && e.amount !== data.amount.toString())
      )
        throw Error();
      const signer = message.staticAccounts[0],
        signature = tx.signatures[signer];
      if (
        !signature ||
        !(await verifySignature(
          await getPublicKeyFromAddress(signer),
          signature,
          tx.messageBytes,
        ))
      )
        throw Error();
    } catch {
      throw new BackendError(
        "invalid_evidence",
        "Evidence must describe the original signed Capture402 operation exactly",
      );
    }
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
    options?: SubmitContext,
  ): Promise<TxReceipt> {
    this.writable();
    const { value: lifetime } = await this.read("getLatestBlockhash", options =>
      this.rpc
        .getLatestBlockhash({ commitment: COMMITMENT })
        .send(options),
    );
    const message = pipe(
      createTransactionMessage({ version: "legacy" }),
      (m) => setTransactionMessageFeePayer(signer.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => appendTransactionMessageInstructions([instruction], m),
    );
    const unsigned = compileTransaction(message);
    const messageBase64 = getBase64Decoder().decode(unsigned.messageBytes);
    const { value: fee } = await this.read("getFeeForMessage", options =>
      this.rpc
        .getFeeForMessage(
          messageBase64 as Parameters<Capture402Rpc["getFeeForMessage"]>[0],
          { commitment: COMMITMENT },
        )
        .send(options),
    );
    if (fee === null)
      throw new BackendError(
        "fee_unavailable",
        "Fee quote unavailable; nothing sent",
      );
    const balance = await this.read("getBalance", options =>
      this.rpc
        .getBalance(signer.address, { commitment: COMMITMENT })
        .send(options),
    );
    if (balance.value < rent + fee)
      throw new BackendError(
        "insufficient_funds",
        "Signer needs SOL for quoted fee and account rent",
      );
    const tx = await partiallySignTransaction([signer.keyPair], unsigned);
    const txSig = getSignatureFromTransaction(tx);
    const wire = getBase64EncodedWireTransaction(tx);
    const simulation = await this.read("simulateTransaction", options =>
      this.rpc
        .simulateTransaction(wire, {
          encoding: "base64",
          commitment: COMMITMENT,
          sigVerify: true,
        })
        .send(options),
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
      await options?.onPrepared?.(
        Object.freeze({
          txSig: evidence.signature,
          holdId: evidence.holdId,
          ...(Number.isSafeInteger(Number(evidence.lastValidBlockHeight))
            ? { lastValidBlockHeight: Number(evidence.lastValidBlockHeight) }
            : {}),
          evidence,
        }),
      );
      await this.retainBeforeSend?.(evidence);
    } catch {
      this.uncertain = undefined;
      throw new BackendError(
        "evidence_unavailable",
        "Cannot persist original transaction; nothing sent",
      );
    }
    const sendOptions = rpcOptions();
    try {
      await this.scheduler.pace(sendOptions.abortSignal);
      // Evidence retention and pacing yield to reads that can close admission.
      // Check synchronously at the dispatch boundary, before any send is possible.
      this.assertEnvironmentHealthy();
    } catch (error) {
      // This original has definitely not been dispatched. Its durable prepared
      // evidence remains in the service journal; no possible-send latch is cleared.
      this.uncertain = undefined;
      throw error;
    }
    try {
      const returned = await this.rpc
        .sendTransaction(wire, {
          encoding: "base64",
          skipPreflight: false,
          preflightCommitment: COMMITMENT,
          maxRetries: 0n,
        })
        .send(sendOptions);
      if (returned !== txSig) throw Error("Signature mismatch");
      const end = Date.now() + (this.config.confirmationTimeoutMs ?? 60_000);
      while (Date.now() < end) {
        const { value } = await this.read(
          "getSignatureStatuses",
          options => this.rpc
            .getSignatureStatuses([txSig], { searchTransactionHistory: true })
            .send(options),
          AbortSignal.timeout(Math.min(15_000, Math.max(1, end - Date.now()))),
        );
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
      this.scheduler.noteRateLimit(err); // Cool down observation, never repeat this send.
      if (err instanceof BackendError && err.phase === "confirmed_failure")
        throw err;
      throw new BackendOutcomeUnknown(evidence);
    }
    throw new BackendOutcomeUnknown(evidence);
  }
}
