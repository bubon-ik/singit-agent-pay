/**
 * Devnet PaymentBackend backed by the capture402 program. Stub: every method throws until
 * the on-chain wiring is filled in. See INTERFACE.md for the instruction/account tables and
 * /tmp/capture402-solana (integration/src/transactions.ts, program.ts) for the TS helpers.
 *
 * Devnet only. Keys: devnet throwaway keypairs generated locally by the team, loaded from env
 * (SINGIT_PAYER_KEYPAIR / SINGIT_MERCHANT_KEYPAIR), never committed; agents never see keys.
 * SINGIT_PAYER_KEYPAIR signs hold (authorize); SINGIT_MERCHANT_KEYPAIR signs capture/release/refund,
 * including human-approved refunds. This code never generates or stores keys.
 */
import {
  BackendError,
  type CaptureRequest,
  type EscrowStatus,
  type HoldReceipt,
  type HoldRequest,
  type MandateTerms,
  type PaymentBackend,
  type RefundRequest,
  type ReleaseRequest,
  type TxReceipt,
} from "./types.js";

export interface Capture402Config {
  /** Devnet RPC endpoint. */
  rpcUrl: string;
  /** capture402 program id (base58). Not pinned on-chain per the program source; set by deployment. */
  programId: string;
  /** SPL mint to use; should be DEVNET_USDC_MINT from ./types.ts. */
  mint: string;
}

export class Capture402Backend implements PaymentBackend {
  readonly name = "capture402";

  constructor(private readonly config: Capture402Config) {}

  async createMandate(terms: MandateTerms): Promise<{ ref?: string }> {
    // No capture402 instruction: mandates are off-chain. Fine to no-op (return {}) once
    // the rest of this backend is wired up; left throwing for now so the stub is explicit.
    throw new BackendError("not_implemented", "Capture402Backend.createMandate not implemented");
  }

  async hold(req: HoldRequest): Promise<HoldReceipt> {
    // TODO: capture402 `authorize` (tag 0), payer-signed.
    // Data (67 B): [0, version=1, escrow=0, fee=0:u64, salt:32, maximum:u64, captureDeadline:i64, refundDeadline:i64]
    // Accounts: payer(s,w), server=req.payee, payment PDA(w), mint, payer ATA(w),
    //           vault(w) = ATA(payment PDA, mint), rent funder(s,w), System, Token, ATA program.
    // 1. Load the payer KeyPairSigner from env SINGIT_PAYER_KEYPAIR (devnet throwaway, never committed).
    // 2. salt = Buffer.from(req.salt, "hex"); payment = await paymentAddress(programId, payer, salt) (program.ts).
    // 3. instruction = await authorizeInstruction({ programId, payer, server: req.payee, mint, funder: payer,
    //      salt, maximum: req.maximum, captureDeadline: BigInt(req.captureDeadline), refundDeadline: BigInt(req.refundDeadline) })
    //    (transactions.ts). The funder may be the payer itself for a simple devnet demo.
    // 4. Build + sign + send the transaction against this.config.rpcUrl, confirm it, and return
    //    { holdId: payment, txSig: <signature> }.
    throw new BackendError("not_implemented", "Capture402Backend.hold not implemented");
  }

  async capture(req: CaptureRequest): Promise<TxReceipt> {
    // TODO: capture402 `capture` (tag 2), merchant-signed.
    // Data (26 B): [2, amount:u64, releaseRemainder:u8, expectedHeld:u64, expectedRefundable:u64]
    // Accounts: server(s), payment(w)=req.holdId, mint, vault(w)=ATA(payment, mint),
    //           server ATA(w), payer ATA(w), Token.
    // Load the merchant KeyPairSigner from env SINGIT_MERCHANT_KEYPAIR. Build with
    // captureInstruction({ programId, payment: req.holdId, payer, server, mint }, req.amount,
    // req.releaseRemainder, req.expectedHeld, req.expectedRefundable) (transactions.ts); sign, send, confirm.
    throw new BackendError("not_implemented", "Capture402Backend.capture not implemented");
  }

  async release(req: ReleaseRequest): Promise<TxReceipt> {
    // TODO: capture402 `void` (tag 3), merchant-signed.
    // Data (17 B): [3, expectedHeld:u64, expectedRefundable:u64]
    // Accounts: server(s), payment(w)=req.holdId, mint, vault(w), payer ATA(w), Token.
    // Build with voidInstruction(stored, req.expectedHeld, req.expectedRefundable) (transactions.ts),
    // signed with SINGIT_MERCHANT_KEYPAIR.
    throw new BackendError("not_implemented", "Capture402Backend.release not implemented");
  }

  async refund(req: RefundRequest): Promise<TxReceipt> {
    // TODO: capture402 `refund` (tag 4), merchant-signed, paid from the MERCHANT's own ATA (not the vault).
    // Data (25 B): [4, amount:u64, expectedHeld:u64, expectedRefundable:u64]
    // Accounts: server(s), payment(w)=req.holdId, mint, server ATA(w), payer ATA(w), Token.
    // Build with refundInstruction(stored, req.amount, req.expectedHeld, req.expectedRefundable)
    // (transactions.ts), signed with SINGIT_MERCHANT_KEYPAIR.
    throw new BackendError("not_implemented", "Capture402Backend.refund not implemented");
  }

  async getStatus(holdId: string): Promise<EscrowStatus | null> {
    // TODO: read the Payment account at address `holdId` over this.config.rpcUrl and decode it
    // with `decodePayment` (program.ts, 176 B, discriminator "SACPAY01"). Return null if the
    // account does not exist.
    // QA M-2: the program accepts any classic mint, so verify decoded.mint === this.config.mint
    // (DEVNET_USDC_MINT) here before returning a status — PaymentService.hold relies on this
    // getStatus check to catch a wrong-mint hold after the fact.
    throw new BackendError("not_implemented", "Capture402Backend.getStatus not implemented");
  }
}
