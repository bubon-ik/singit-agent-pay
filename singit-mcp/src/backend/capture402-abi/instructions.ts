// Copyright 2026 SVM Auth-Capture contributors. SPDX-License-Identifier: Apache-2.0
// Vendored from starPaw/capture402-solana @ 236b09a44240d285ee6f33d2e8dac79f81058e3d
import { type Address, type Instruction } from "@solana/kit";
import {
  ata,
  authorizeAccounts,
  authorizeData,
  captureAccounts,
  captureData,
  paymentAddress,
  reclaimAccounts,
  refundAccounts,
  refundData,
  Tag,
  toInstruction,
  voidAccounts,
  voidData,
} from "./program.js";

/** The client's payer-signed authorization: the exact authorize instruction and its accounts. */
export async function authorizeInstruction(a: {
  programId: Address;
  payer: Address;
  server: Address;
  mint: Address;
  funder: Address;
  salt: Uint8Array;
  maximum: bigint;
  captureDeadline: bigint;
  refundDeadline: bigint;
}): Promise<Instruction> {
  const payment = await paymentAddress(a.programId, a.payer, a.salt);
  return toInstruction(
    a.programId,
    authorizeAccounts({
      payer: a.payer,
      server: a.server,
      payment,
      mint: a.mint,
      source: await ata(a.payer, a.mint),
      vault: await ata(payment, a.mint),
      funder: a.funder,
    }),
    authorizeData(a.salt, a.maximum, a.captureDeadline, a.refundDeadline),
  );
}

type Stored = { programId: Address; payment: Address; payer: Address; server: Address; mint: Address };

export async function captureInstruction(
  s: Stored,
  amount: bigint,
  releaseRemainder: boolean,
  expectedHeld: bigint,
  expectedRefundable: bigint,
): Promise<Instruction> {
  return toInstruction(
    s.programId,
    captureAccounts({
      server: s.server,
      payment: s.payment,
      mint: s.mint,
      vault: await ata(s.payment, s.mint),
      serverAta: await ata(s.server, s.mint),
      payerAta: await ata(s.payer, s.mint),
    }),
    captureData(amount, releaseRemainder, expectedHeld, expectedRefundable),
  );
}

export async function voidInstruction(s: Stored, expectedHeld: bigint, expectedRefundable: bigint): Promise<Instruction> {
  return toInstruction(
    s.programId,
    voidAccounts({
      server: s.server,
      payment: s.payment,
      mint: s.mint,
      vault: await ata(s.payment, s.mint),
      payerAta: await ata(s.payer, s.mint),
    }),
    voidData(expectedHeld, expectedRefundable),
  );
}

export async function refundInstruction(
  s: Stored,
  amount: bigint,
  expectedHeld: bigint,
  expectedRefundable: bigint,
): Promise<Instruction> {
  return toInstruction(
    s.programId,
    refundAccounts({
      server: s.server,
      payment: s.payment,
      mint: s.mint,
      serverAta: await ata(s.server, s.mint),
      payerAta: await ata(s.payer, s.mint),
    }),
    refundData(amount, expectedHeld, expectedRefundable),
  );
}
