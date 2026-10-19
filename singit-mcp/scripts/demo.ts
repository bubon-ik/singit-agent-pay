import { MockBackend } from '../src/backend/mock.js';
import { formatUsdc } from '../src/amount.js';
import { issueApprovalToken } from '../src/approval.js';
import { PaymentService, Refusal } from '../src/service.js';

let t = Math.floor(Date.now() / 1000);
const approvalSecret = process.env.SINGIT_HUMAN_APPROVAL_SECRET ?? 'demo-only-human-secret-0123456789';
const backend = new MockBackend({ now: () => t, balances: { 'buyer-agent': 100000000n, 'seller-agent': 20000000n } });
const service = new PaymentService({ backend, now: () => t, approvalSecret });
const paint = (value: string, code: number) => process.stdout.isTTY ? `\x1b[${code}m${value}\x1b[0m` : value;
let number = 0;
function step(actor: string, action: string, result: string): void {
  number += 1;
  const line = `${number}. ${actor} -> ${action}: ${result}`;
  console.log(result.startsWith('BLOCKED ') ? paint(line, 31) : paint(line, 32));
}
async function attempt<T>(actor: string, action: string, run: () => Promise<T>, describe: (value: T) => string): Promise<T | undefined> {
  try {
    const value = await run();
    step(actor, action, describe(value));
    return value;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    step(actor, action, `BLOCKED ${error.code}: ${error.message.replace(/^BLOCKED: /, "")}`);
    return undefined;
  }
}

async function main(): Promise<void> {
  const mandate = await attempt('human', 'creates mandate m for buyer-agent', () => service.createMandate({
    actor: 'human', payer: 'buyer-agent', totalBudget: 10000000n, perTxCap: 4000000n,
    expiresAt: t + 3600, allowedCounterparties: ['seller-agent'],
  }), value => `created ${value.id}; budget ${formatUsdc(value.totalBudget)}, per-tx ${formatUsdc(value.perTxCap)}, expires in 1h`);
  if (!mandate) throw new Error('Mandate creation failed');

  const firstHold = await attempt('buyer-agent', 'holds 4 USDC to seller-agent', () => service.hold({
    actor: 'buyer-agent', mandateId: mandate.id, payee: 'seller-agent', amount: 4000000n,
  }), value => `held ${formatUsdc(value.held)} (hold ${value.id})`);
  if (!firstHold) throw new Error('Initial hold failed');

  await attempt('seller-agent', 'captures 2.5 USDC', () => service.capture({ actor: 'seller-agent', holdId: firstHold.id, amount: 2500000n }),
    value => `captured ${formatUsdc(2500000n)}; held ${formatUsdc(value.held)}; txSig ${value.lastTxSig}`);
  await attempt('seller-agent', 'releases the remainder', () => service.release({ actor: 'seller-agent', holdId: firstHold.id }), value => {
    const remaining = service.getMandate(mandate.id).remaining;
    return `released ${formatUsdc(1500000n)}; remaining budget ${formatUsdc(remaining)}; hold ${value.id}`;
  });
  console.log(`   remaining mandate budget: ${formatUsdc(service.getMandate(mandate.id).remaining)}`);

  await attempt('buyer-agent', 'tries to hold 5 USDC', () => service.hold({
    actor: 'buyer-agent', mandateId: mandate.id, payee: 'seller-agent', amount: 5000000n,
  }), () => 'hold created');

  const secondHold = await attempt('buyer-agent', 'holds 4 USDC (first)', () => service.hold({
    actor: 'buyer-agent', mandateId: mandate.id, payee: 'seller-agent', amount: 4000000n,
  }), value => `held ${formatUsdc(value.held)} (hold ${value.id})`);
  await attempt('buyer-agent', 'holds 4 USDC (second)', () => service.hold({
    actor: 'buyer-agent', mandateId: mandate.id, payee: 'seller-agent', amount: 4000000n,
  }), value => `held ${formatUsdc(value.held)} (hold ${value.id})`);

  await attempt('buyer-agent', 'tries to pay evil-agent', () => service.hold({
    actor: 'buyer-agent', mandateId: mandate.id, payee: 'evil-agent', amount: 1000000n,
  }), () => 'hold created');

  const dispute = await attempt('buyer-agent', 'opens dispute on first hold', () => service.openDispute({
    actor: 'buyer-agent', holdId: firstHold.id, reason: 'song was not delivered', evidence: ['order #42 log'],
  }), value => `opened ${value.id}: ${value.reason}; evidence: ${value.evidence.join(', ')}`);
  if (!dispute) throw new Error('Dispute creation failed');

  await attempt('buyer-agent', 'tries resolve_dispute without token', () => service.resolveDispute({
    actor: 'buyer-agent', disputeId: dispute.id, outcome: 'refund', refundAmount: 2500000n,
  }), () => 'dispute resolved');
  await attempt('buyer-agent', 'tries resolve_dispute with made-up token', () => service.resolveDispute({
    actor: 'buyer-agent', disputeId: dispute.id, outcome: 'refund', refundAmount: 2500000n, approvalToken: 'made-up-token',
  }), () => 'dispute resolved');

  console.log('   human approves out-of-band (npm run approve); configured secret is a demo secret');
  const token = issueApprovalToken(approvalSecret, { disputeId: dispute.id, outcome: 'refund', refundAmount: 2500000n });
  const resolved = await attempt('human', 'issues approval token and resolves dispute', () => service.resolveDispute({
    actor: 'kostiantyn', disputeId: dispute.id, outcome: 'refund', refundAmount: 2500000n, approvalToken: token,
  }), value => `refund ${formatUsdc(value.refundAmount ?? 0n)} executed; txSig ${value.txSigs.at(-1) ?? 'none'}`);

  const final = service.getMandate(mandate.id);
  console.log(`\nFinal mandate ${final.mandate.id}: committed ${formatUsdc(final.mandate.committed)}, remaining ${formatUsdc(final.remaining)}`);
  console.log(`Dispute status: ${resolved?.status ?? service.getDispute(dispute.id).status}; hold: ${firstHold.id}; extra hold: ${secondHold?.id ?? 'none'}`);
  console.log('\nAudit log');
  console.log('seq | actor                  | action          | outcome | code                       | amount       | txSig');
  for (const entry of service.listAuditLog({ mandateId: mandate.id })) {
    const amount = entry.amount === null ? '—' : formatUsdc(BigInt(entry.amount));
    console.log(`${String(entry.seq).padStart(3)} | ${entry.actor.padEnd(22)} | ${entry.action.padEnd(15)} | ${entry.outcome.padEnd(7)} | ${(entry.code ?? '—').padEnd(26)} | ${amount.padEnd(12)} | ${entry.txSig ?? '—'}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
