/** Pure verification of retained signed originals. No RPC, signing or key loading. */
import { address, decompileTransactionMessage, getCompiledTransactionMessageDecoder, getTransactionDecoder,
  getPublicKeyFromAddress, verifySignature, getBase64EncodedWireTransaction, getSignatureFromTransaction,
  type Address } from "@solana/kit";
import { decodeInstructionData, paymentAddress, U64_MAX } from "./capture402-abi/program.js";
import { BackendError, DEVNET_USDC_MINT, type UnknownOperation } from "./types.js";

export const CAPTURE402_ABI_COMMIT = "236b09a44240d285ee6f33d2e8dac79f81058e3d";
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export async function validateCapture402Evidence(e: UnknownOperation, program: Address) {
  try {
    if (
      e.programId !== program ||
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
    if (ix.programAddress !== program || !data || data.op === "reclaim")
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
        address(e.holdId) ||
      ix.accounts?.[data.op === "authorize" ? 3 : 2]?.address !==
        DEVNET_USDC_MINT
    )
      throw Error();
    if (data.op === "authorize") {
      if (
        e.salt?.toLowerCase() !== Buffer.from(data.salt).toString("hex") ||
        (e.amount !== undefined && e.amount !== data.maximum.toString()) ||
        (await paymentAddress(
          program,
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
    return { signer, instruction: ix, data };
  } catch {
    throw new BackendError(
      "invalid_evidence",
      "Evidence must describe the original signed Capture402 operation exactly",
    );
  }
}
