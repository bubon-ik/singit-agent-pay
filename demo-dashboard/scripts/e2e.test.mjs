// First e2e test: boots the bridge, plays the story, asserts mandate math + blocked event + human dispute flow + audit.
// Run: node --test scripts/e2e.test.mjs   (SINGIT_BACKEND=local to force the local adapter)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const dir = fileURLToPath(new URL("..", import.meta.url));
const PORT = 5299, BASE = `http://127.0.0.1:${PORT}`;
let srv;
const state = async () => (await fetch(`${BASE}/api/state`)).json();
const post = async (p, b = {}) => (await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const until = async (pred, max = 100) => { for (let i = 0; i < max; i++) { const s = await state().catch(() => null); if (s && pred(s)) return s; await new Promise((r) => setTimeout(r, 100)); } throw new Error("timeout"); };

before(async () => {
  srv = spawn(process.execPath, [`${dir}../singit-mcp/node_modules/tsx/dist/cli.mjs`, "server.mjs"], { cwd: dir, env: { ...process.env, PORT: String(PORT), TSX_DISABLE_CACHE: "1" }, stdio: "ignore" });
  await until(() => true);
  await until((x) => x.backend !== "connecting", 250);
});
after(() => srv?.kill());

test("static assets: page modules are served as JavaScript", async () => {
  const app = await fetch(`${BASE}/app.js`);
  assert.equal(app.status, 200);
  assert.ok((app.headers.get("content-type") || "").startsWith("text/javascript"), `app.js content-type: ${app.headers.get("content-type")}`);
  const ops = await fetch(`${BASE}/ops.mjs`);
  assert.equal(ops.status, 200);
  assert.ok((ops.headers.get("content-type") || "").startsWith("text/javascript"), `ops.mjs content-type: ${ops.headers.get("content-type")}`);
  const root = await fetch(`${BASE}/`);
  assert.equal(root.status, 200);
  const html = await root.text();
  assert.ok(html.includes("app.js"), "index.html must reference app.js");
});

test("demo story: budget enforcement, escrow lifecycle, human-approved dispute", async () => {
  const captions = new Set();
  const pollCaptions = setInterval(async () => {
    const s = await state().catch(() => null);
    if (s?.chain === "mock") captions.add(s.story.caption);
  }, 10);
  await post("/api/story", { delay: 20 });
  let s;
  try {
    s = await until((x) => x.story.state === "awaiting-human");
  } finally {
    clearInterval(pollCaptions);
  }
  if (s.chain === "mock") captions.add(s.story.caption);
  const m = s.mandates[0];
  assert.equal(s.story.total, 13);
  assert.equal(m.totalBudget, "10000000");
  assert.equal(m.remaining, "3500000", "2.5 captured + 4 captured = 6.5 committed; release returned 0.5; refund must NOT restore budget");
  assert.equal(m.remaining, "3500000", "mandate remaining before human refund");
  const blocked = s.timeline.filter((e) => e.kind === "blocked");
  assert.deepEqual(blocked.map((e) => e.code), ["OVER_PER_TX_CAP", "COUNTERPARTY_NOT_ALLOWED", "OVER_BUDGET", "HUMAN_APPROVAL_REQUIRED", "HUMAN_APPROVAL_REQUIRED"]);
  assert.ok(blocked.every((e) => e.code), "blocked timeline events retain their audit code");
  assert.ok(s.audit.some((a) => a.v === 1 && a.outcome === "blocked" && a.code === "OVER_BUDGET" && /over budget/i.test(a.reason)));
  const agentResolutions = s.audit.filter((a) => a.action === "resolve_dispute");
  assert.equal(agentResolutions.length, 2);
  assert.ok(agentResolutions.every((a) => a.outcome === "blocked" && a.code === "HUMAN_APPROVAL_REQUIRED"));
  assert.ok([...captions].some((caption) => caption.includes("escrow (mock)")));
  assert.ok([...captions].every((caption) => !caption.includes("on-chain escrow")));
  assert.ok([...captions].some((caption) => caption.includes("pending a human decision")), "dispute step caption must be observed while polling");
  assert.equal(s.disputes[0].status, "open");
  assert.equal(s.disputes[0].suggestedRefund, "4000000", "suggestedRefund equals the disputed hold's captured - refunded");
  // agents cannot resolve disputes themselves
  const denied = await fetch(`${BASE}/api/tool/resolve_dispute`, { method: "POST", body: "{}" });
  assert.equal(denied.status, 403);
  // capture is frozen while dispute is open
  const frozen = await post("/api/tool/capture", { actor: "agent:gpu-broker", holdId: s.disputes[0].holdId, amount: "1" });
  assert.equal(frozen.ok, false);
  // human approves full refund
  const r = await post("/api/human/resolve", { disputeId: "d-1", outcome: "refund", refundAmount: "4000000" });
  assert.equal(r.ok, true, JSON.stringify(r));
  s = await state();
  assert.equal(s.mandates[0].remaining, "3500000");
  const h2 = s.mandates[0].holds.find((h) => h.id === s.disputes[0].holdId);
  assert.equal(h2.refunded, "4000000");
  assert.equal(s.mandates[0].remaining, "3500000", "refund never restores budget");
  assert.equal((await post("/api/human/resolve", { disputeId: "d-1", outcome: "reject" })).ok, false, "double resolve refused");
  // results persist after the story completes; no implicit reset
  s = await state();
  assert.equal(s.story.state, "done");
  assert.equal(s.chain, "mock", "badge must say mock while receipts are mock refs");
  assert.ok(s.mandates.length === 1 && s.timeline.length > 10 && s.audit.length > 10);
  const again = await fetch(`${BASE}/api/story`, { method: "POST", body: "{}" });
  assert.equal(again.status, 409, "Run again requires explicit Reset");
  assert.equal((await state()).timeline.length, s.timeline.length);
});

test("presenter mode: manual pacing, Next advances, pause, explicit reset", async () => {
  await post("/api/reset");
  const initial = await state();
  if (initial.backend === "mcp-http") {
    assert.equal(initial.story.state, "idle");
  } else {
    assert.equal(initial.timeline.length, 0);
  }
  await post("/api/story", { delay: "manual" });
  await until((x) => x.story.step === 1);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await state()).story.step, 1, "manual mode waits for Next");
  await post("/api/story/next");
  await until((x) => x.story.step === 2);
  assert.equal((await post("/api/story/pause")).paused, true);
  await post("/api/story/pace", { delay: 30 });
  await post("/api/story/next"); // Next still works while paused
  await until((x) => x.story.step === 3);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await state()).story.step, 3, "paused countdown does not advance");
  await post("/api/story/pause", { paused: false });
  await until((x) => x.story.state === "awaiting-human");
  assert.equal((await post("/api/story/next")).code, "AWAITING_HUMAN");
  await post("/api/reset");
  const s = await state();
  assert.equal(s.story.state, "idle");
  if (s.backend !== "mcp-http") assert.equal(s.timeline.length, 0);
});

test("story → reset → story again ends in the same final state", async () => {
  await post("/api/reset");
  await until((s) => s.story.state === "idle");

  async function playAndResolve() {
    await post("/api/story", { delay: 20 });
    let s = await until((x) => x.story.state === "awaiting-human");
    const resolved = await post("/api/human/resolve", { disputeId: "d-1", outcome: "refund", refundAmount: "4000000" });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    s = await until((x) => x.story.state === "done");
    const mandate = s.mandates[0];
    const dispute = s.disputes[0];
    return {
      fingerprint: {
        mandateCount: s.mandates.length,
        mandateId: mandate?.id,
        remaining: mandate?.remaining,
        committed: mandate?.committed,
        blockedCodes: s.timeline.filter((event) => event.kind === "blocked").map((event) => event.code),
        disputeStatus: dispute?.status,
        disputeOutcome: dispute?.outcome,
        refundAmount: dispute?.refundAmount,
        holdCount: s.mandates.reduce((total, item) => total + (item.holds?.length ?? 0), 0),
      },
    };
  }

  const first = await playAndResolve();
  const backend = (await state()).backend;
  if (backend === "mcp-http") assert.equal(first.fingerprint.mandateId, "m-1");
  const reset = await post("/api/reset");
  assert.equal(reset.ok, true, JSON.stringify(reset));
  let s = await until((x) => x.story.state === "idle");
  if (backend === "mcp-http") {
    assert.deepEqual(s.audit.map((entry) => entry.action), ["reset"]);
    assert.equal(s.mandates.length, 0);
  } else {
    assert.equal(s.timeline.length, 0);
  }

  const second = await playAndResolve();
  if (backend === "mcp-http") assert.equal(second.fingerprint.mandateId, "m-1");
  assert.deepEqual(second.fingerprint, first.fingerprint);
});
