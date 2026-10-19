/**
 * npm run demo: the same story as the demo dashboard, against MockBackend (synthetic data).
 * Buyer agent:research-bot pays sellers agent:data-vendor and agent:gpu-broker under a 10 USDC mandate.
 */
import { formatUsdc } from "../src/amount.js";
import { issueApprovalToken } from "../src/approval.js";
import { DEFAULT_MOCK_BALANCES, MockBackend } from "../src/backend/mock.js";
import { PaymentService, Refusal } from "../src/service.js";

const U = 1_000_000n;
const BUYER = "agent:research-bot";
const VENDOR = "agent:data-vendor";
const GPU = "agent:gpu-broker";
const ROGUE = "agent:unknown-seller";
const HUMAN = "human:kostiantyn";

const secret = process.env.SINGIT_HUMAN_APPROVAL_SECRET ?? "demo-only-human-secret-0123456789";
let t = Math.floor(Date.now() / 1000);
const now = () => t;
const service = new PaymentService({ backend: new MockBackend({ now, balances: { ...DEFAULT_MOCK_BALANCES } }), now, approvalSecret: secret });

const color = (s: string, c: number) => (process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s);
let n = 0;
async function step<T>(actor: string, action: string, fn: () => Promise<T>, ok: (v: T) => string): Promise<T | undefined> {
  n += 1;
  try {
    const v = await fn();
    console.log(color(`${String(n).padStart(2)}. ${actor} -> ${action}: ${ok(v)}`, 32));
    return v;
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    console.log(color(`${String(n).padStart(2)}. ${actor} -> ${action}: BLOCKED ${e.code}: ${e.message.replace(/^BLOCKED: /, "")}`, 31));
    return undefined;
  }
}
const remaining = (id: string) => formatUsdc(service.getMandate(id).remaining);

console.log(`SingIt MCP demo (MockBackend, synthetic data; ${process.env.SINGIT_HUMAN_APPROVAL_SECRET ? "approval secret from env" : "demo-only approval secret"})\n`);

const m = await step(HUMAN, "create mandate for research-bot (10 USDC, 4 USDC/tx, 2 h, sellers data-vendor + gpu-broker)", () =>
  service.createMandate({ actor: HUMAN, payer: BUYER, totalBudget: 10n * U, perTxCap: 4n * U, expiresAt: t + 7200,
    allowedCounterparties: [VENDOR, GPU], note: "Market research sprint" }), (v) => `${v.id}, remaining ${remaining(v.id)}`);
if (!m) throw new Error("mandate creation failed");

const h1 = await step(BUYER, "hold 3 USDC for data-vendor", () => service.hold({ actor: BUYER, mandateId: m.id, payee: VENDOR, amount: 3n * U }),
  (h) => `${h.id} held ${formatUsdc(h.held)}, txSig ${h.lastTxSig}, remaining ${remaining(m.id)}`);
await step(VENDOR, "capture 2.5 USDC", () => service.capture({ actor: VENDOR, holdId: h1!.id, amount: 2_500_000n }),
  (h) => `captured ${formatUsdc(h.captured)}, still held ${formatUsdc(h.held)}, txSig ${h.lastTxSig}`);
await step(VENDOR, "release the 0.5 USDC remainder", () => service.release({ actor: VENDOR, holdId: h1!.id }),
  (h) => `released, txSig ${h.lastTxSig}, remaining ${remaining(m.id)}`);
const h2 = await step(BUYER, "hold 4 USDC for gpu-broker", () => service.hold({ actor: BUYER, mandateId: m.id, payee: GPU, amount: 4n * U }),
  (h) => `${h.id} held ${formatUsdc(h.held)}, txSig ${h.lastTxSig}, remaining ${remaining(m.id)}`);
await step(GPU, "capture 4 USDC", () => service.capture({ actor: GPU, holdId: h2!.id, amount: 4n * U }),
  (h) => `captured ${formatUsdc(h.captured)}, txSig ${h.lastTxSig}`);
await step(BUYER, "hold 5 USDC for data-vendor", () => service.hold({ actor: BUYER, mandateId: m.id, payee: VENDOR, amount: 5n * U }), () => "unexpected");
await step(BUYER, "hold 1 USDC for unknown-seller", () => service.hold({ actor: BUYER, mandateId: m.id, payee: ROGUE, amount: 1n * U }), () => "unexpected");
console.log(`    remaining budget before next hold: ${remaining(m.id)}`);
await step(BUYER, "hold 4 USDC more for data-vendor", () => service.hold({ actor: BUYER, mandateId: m.id, payee: VENDOR, amount: 4n * U }), () => "unexpected");
await step(VENDOR, "refund 0.5 USDC (goodwill)", () => service.refund({ actor: VENDOR, holdId: h1!.id, amount: 500_000n }),
  (h) => `refunded ${formatUsdc(h.refunded)}, txSig ${h.lastTxSig}, remaining ${remaining(m.id)} (refunds never re-open the budget)`);
const d = await step(BUYER, "open dispute on the 4 USDC gpu-broker hold", () =>
  service.openDispute({ actor: BUYER, holdId: h2!.id, reason: "GPU job returned empty results", evidence: ["job-7f3a: output.parquet 0 rows", "SLA: non-empty dataset"] }),
  (x) => `${x.id} open; captures on ${x.holdId} frozen`);
await step(BUYER, "resolve own dispute without a token", () => service.resolveDispute({ actor: BUYER, disputeId: d!.id, outcome: "refund", refundAmount: 4n * U }), () => "unexpected");
await step(BUYER, "resolve own dispute with a forged token", () =>
  service.resolveDispute({ actor: BUYER, disputeId: d!.id, outcome: "refund", refundAmount: 4n * U, approvalToken: "f".repeat(64) }), () => "unexpected");
console.log("    human reviews the evidence and approves out-of-band (npm run approve / dashboard console)");
const token = issueApprovalToken(secret, { disputeId: d!.id, outcome: "refund", refundAmount: 4n * U });
await step(HUMAN, "approve 4 USDC refund", () => service.resolveDispute({ actor: HUMAN, disputeId: d!.id, outcome: "refund", refundAmount: 4n * U, approvalToken: token }),
  (x) => `${x.id} ${x.status}, refunded ${formatUsdc(x.refundAmount ?? 0n)}, txSig ${x.txSigs.at(-1) ?? "none"}`);

const final = service.getMandate(m.id);
console.log(`\nMandate ${m.id}: committed ${formatUsdc(final.mandate.committed)}, remaining ${formatUsdc(final.remaining)} of ${formatUsdc(final.mandate.totalBudget)}`);
console.log("txSig values are mock refs (mock-tx-N) until Capture402Backend is wired to devnet.\n\nAudit log");
const rows = service.listAuditLog().map((e) => [String(e.seq), e.actor, e.action, e.outcome, e.code ?? "-", e.amount ? formatUsdc(BigInt(e.amount)) : "-", e.txSig ?? "-"]);
const head = ["seq", "actor", "action", "outcome", "code", "amount", "txSig"];
const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
for (const r of [head, ...rows]) console.log(r.map((c, i) => c.padEnd(w[i])).join(" | "));
