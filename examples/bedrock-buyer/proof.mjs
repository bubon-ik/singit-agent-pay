import { MAXIMUM, PRICE, tool } from './common.mjs';

export async function proveOperation(payments, operationId, { action, profile, mandateId, holdId, txSig }) {
  if (typeof operationId !== 'string' || !operationId || typeof txSig !== 'string' ||
      !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(txSig)) throw Error('OUTCOME_NOT_PROVEN');
  const { operation: op } = await tool(payments, 'get_operation', { operationId });
  if (op?.id !== operationId || op.state !== 'succeeded' || op.action !== action ||
      op.actor !== (action === 'hold' ? profile.payer : profile.merchant) || op.mandateId !== mandateId ||
      op.holdId !== holdId || op.result?.txSig !== txSig || op.prepared?.txSig !== txSig ||
      op.params?.amount !== (action === 'hold' ? MAXIMUM : PRICE) ||
      (action === 'capture' && (op.expected?.held !== '0' || op.expected?.refundable !== PRICE))) throw Error('OUTCOME_NOT_PROVEN');
  // The reviewed Capture402 backend commits success only after this original
  // signature finalized with err=null. No account snapshot substitutes for it.
  return Object.freeze({ operationId, txSig, commitment: 'finalized', err: null });
}
