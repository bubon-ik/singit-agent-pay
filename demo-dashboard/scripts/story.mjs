// Plays the demo scenario against a running dashboard server.
// Usage: node scripts/story.mjs [--presenter | --delay=SECONDS | --fast] [--auto-approve] [--reset]
//   default: fast auto mode (1.1 s/step); --presenter = 7 s/step; --fast = 50 ms/step (screenshots)
const BASE = process.env.DASHBOARD_URL ?? "http://127.0.0.1:5173";
const has = (f) => process.argv.includes(f);
const auto = has("--auto-approve");
const delayArg = process.argv.find((a) => a.startsWith("--delay="))?.split("=")[1];
const delay = delayArg ? (delayArg === "manual" ? "manual" : Math.round(Number(delayArg) * 1000)) : has("--presenter") ? 7000 : has("--fast") ? 50 : 1100;
const post = (p, b = {}) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
if (has("--reset")) await post("/api/reset");
const r = await post("/api/story", { autoApprove: auto, delay, mode: delay === 1100 || delay === 50 ? "auto" : "presenter" });
if (r.ok === false) { console.error(`${r.code}: ${r.message} (use --reset)`); process.exit(2); }
let last = "";
for (;;) {
  const s = await (await fetch(`${BASE}/api/state`)).json();
  const line = `[${s.story.step}/${s.story.total}] ${s.story.label}`;
  if (line !== last) { console.log(line); last = line; }
  if (s.story.state === "error") process.exit(1);
  if (s.story.state === "awaiting-human" && !auto) { console.log(`→ click Approve / Reject on dispute ${s.disputes.find((d) => d.status === "open")?.id ?? "in the dashboard"} (or press A / R)`); break; }
  if (s.story.state === "done") { console.log("Story complete. Results stay on screen until Reset."); break; }
  await new Promise((r) => setTimeout(r, 300));
}
