import assert from 'node:assert/strict';
import test from 'node:test';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mockLlm } from '../mock-llm.mjs';
import { connectBuyerMcp, runBedrockBuyer } from '../bedrock-buyer.mjs';
import { createEvidence, initializeAdmission } from '../bedrock-evidence.mjs';
import { fixture, model, observeFsync, use, final, artifact } from './bedrock-fixture.mjs';
import { STEPS } from '../run-config.mjs';

const checkout = process.env.SINGIT_CHECKOUT ?? fileURLToPath(new URL('../../..', import.meta.url));
const records = path => readdirSync(path).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
  .map(name => JSON.parse(readFileSync(join(path, name), 'utf8')));

test('console-login Bedrock injected SDK → buyer stdio → merchant stdio → actual authenticated SingIt HTTP mock', async t => {
  const f = fixture(t), root = join(f.root, 'transport-run'), ids = STEPS.map(name => `call.${name}:1`);
  const responses = STEPS.map((name, i) => use(name, {}, ids[i]));
  for (const response of responses) response.output.message.content.find(block => block.toolUse).toolUse.type = 'tool_use';
  const sender = model([...responses, final()]);
  f.settings.credentialProvider = 'console-login';
  f.settings.admissionPath = join(f.root, 'console-admission.jsonl');
  initializeAdmission(f.settings);
  const parent = lstatSync(f.root);
  let rootAnchored = false;
  observeFsync(t, stat => {
    if (stat.dev === parent.dev && stat.ino === parent.ino) rootAnchored = true;
  });
  const result = await mockLlm(checkout, root, { provider: 'bedrock', bedrock: f.settings,
    runBuyer: path => {
      assert.equal(rootAnchored, true, 'harness root must be durable before buyer startup');
      return runBedrockBuyer(path, { send: sender.send, authEnv: {} });
    } });
  const baseline = JSON.parse(readFileSync(join(root, 'source-baseline.json'), 'utf8'));
  assert.match(baseline.harness, /^[a-f0-9]{40}$/);
  assert.match(baseline.singit, /^[a-f0-9]{40}$/);
  assert.equal('capture402' in baseline, false, 'the harness is now SingIt source');
  const state = JSON.parse(readFileSync(join(root, 'payment-state.json'), 'utf8'));
  assert.equal(state.ops.length, 2);
  assert.deepEqual(state.ops.map(op => op.action).sort(), ['capture', 'hold']);
  assert.ok(state.ops.every(op => op.state === 'succeeded'));
  assert.equal(state.holds[0].held, '0');
  assert.equal(state.holds[0].captured, '650000');
  assert.equal(state.holds[0].refunded, '0');
  assert.equal(records(join(root, 'merchant'))[0].artifact.sha256, artifact.sha256);
  assert.equal(records(join(root, 'buyer'))[0].stage, 'done');
  const trace = readFileSync(result.tracePath, 'utf8');
  const calls = trace.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.event === 'tool_completed');
  assert.deepEqual(calls.map(call => call.name), STEPS);
  assert.ok(!JSON.stringify(sender.requests).includes(root));
  assert.equal(JSON.parse(readFileSync(join(root, 'acceptance.json'))).status, 'OFFLINE_TESTED');
  assert.equal(JSON.parse(readFileSync(join(root, 'acceptance.json'))).accepted, false);
  assert.equal(JSON.parse(readFileSync(join(root, 'acceptance.json'))).reportReview, 'pending');
  assert.equal(JSON.parse(trace.split('\n')[0]).inference, 'injected');
  assert.equal(JSON.parse(trace.split('\n')[0]).credentialProvider, 'console-login');
  // Wire keys originate in the trusted buyer and merchant, not model correlation IDs.
  const buyer = records(join(root, 'buyer'))[0];
  assert.ok(!JSON.stringify(buyer).includes('call_hold_report'));
  assert.ok(ids.every(id => !JSON.stringify(buyer).includes(id)));
});

test('harness root parent fsync failure preserves the directory before mock/payment/model startup', async t => {
  const f = fixture(t), root = join(f.root, 'failed-root'), parent = lstatSync(f.root);
  const admission = readFileSync(f.settings.admissionPath);
  let parentFlushes = 0, buyerStarted = false;
  observeFsync(t, stat => {
    if (stat.dev === parent.dev && stat.ino === parent.ino) {
      parentFlushes++;
      throw Error('synthetic run-root parent fsync failure');
    }
  });
  await assert.rejects(mockLlm(checkout, root, { provider: 'bedrock', bedrock: f.settings,
    runBuyer: async () => { buyerStarted = true; throw Error('must not start'); } }), /EVIDENCE_UNAVAILABLE/);
  assert.equal(parentFlushes, 1);
  assert.equal(buyerStarted, false);
  assert.deepEqual(readdirSync(root), [], 'preserve the exclusive failed directory');
  assert.deepEqual(readFileSync(f.settings.admissionPath), admission, 'no inference attempt was admitted');
});

test('real HTTP/stdio MCP preserves a false summary for review without granting report acceptance', async t => {
  const f = fixture(t), root = join(f.root, 'unreviewed-report');
  const wrong = 'Total expenses are 999999 USDC, compute and data are zero. There are no duplicate IDs and only one input row. This report is correct and ready for acceptance.';
  const sender = model([...STEPS.map(name => use(name)), final({ summary: wrong })]);
  const result = await mockLlm(checkout, root, { provider: 'bedrock', bedrock: f.settings,
    runBuyer: path => runBedrockBuyer(path, { send: sender.send, authEnv: {} }) });
  const acceptance = JSON.parse(readFileSync(join(root, 'acceptance.json'), 'utf8'));
  const status = JSON.parse(readFileSync(join(root, 'model/status.json'), 'utf8'));
  assert.equal(JSON.parse(readFileSync(result.answerPath, 'utf8')).summary, wrong);
  assert.equal(status.modelOutcome, 'response_complete');
  assert.equal(status.paymentObservation, 'succeeded');
  assert.equal(status.reportReview, 'pending');
  assert.equal(acceptance.status, 'OFFLINE_TESTED');
  assert.equal(acceptance.accepted, false);
  assert.equal(acceptance.reportReview, 'pending');
  assert.equal(acceptance.artifactSha256, artifact.sha256);
  const state = JSON.parse(readFileSync(join(root, 'payment-state.json'), 'utf8'));
  assert.equal(state.ops.length, 2);
  assert.ok(state.ops.every(op => op.state === 'succeeded'));
  assert.equal(state.holds[0].captured, '650000');
  assert.equal(state.holds[0].held, '0');
  assert.equal(records(join(root, 'merchant'))[0].artifact.utf8, artifact.utf8);
});

for (const fault of ['aws_after_capture', 'mcp_after_capture', 'evidence_after_capture']) {
  test(`real MCP ${fault}: original completion survives and restart cannot repurchase`, async t => {
    const f = fixture(t), root = join(f.root, 'fault-run');
    const sender = model(fault === 'aws_after_capture'
      ? [...STEPS.slice(0, 3).map(name => use(name)), Error('synthetic AWS timeout with secret-not-to-log')]
      : [...STEPS.map(name => use(name)), final()]);
    let runPath;
    const options = { send: sender.send, authEnv: {} };
    if (fault === 'mcp_after_capture') {
      f.settings.limits = { mcpTimeoutMs: 3000 };
      options.connectBuyer = async (...args) => {
        const client = await connectBuyerMcp(...args), call = client.callTool.bind(client);
        client.callTool = async (...request) => {
          const result = await call(...request);
          return request[0].name === 'purchase_report' ? new Promise(() => {}) : result;
        };
        return client;
      };
    }
    if (fault === 'evidence_after_capture') options.createEvidence = path => {
      const log = createEvidence(path), append = log.append.bind(log);
      log.append = row => {
        if (row.event === 'tool_completed' && row.name === 'purchase_report') throw Error('synthetic fsync failure');
        return append(row);
      };
      return log;
    };
    await assert.rejects(mockLlm(checkout, root, { provider: 'bedrock', bedrock: f.settings,
      runBuyer: path => { runPath = path; return runBedrockBuyer(path, options); } }));
    const original = readFileSync(join(root, 'buyer', readdirSync(join(root, 'buyer')).find(name => /^[a-f0-9]{64}\.json$/.test(name))));
    assert.equal(JSON.parse(original).stage, 'done');
    assert.equal(records(join(root, 'merchant'))[0].stage, 'done');
    const state = JSON.parse(readFileSync(join(root, 'payment-state-failed.json'), 'utf8'));
    assert.equal(state.ops.length, 2);
    assert.ok(state.ops.every(op => op.state === 'succeeded'));
    const status = JSON.parse(readFileSync(join(root, 'model/status.json'), 'utf8'));
    assert.equal(status.modelOutcome, 'incomplete');
    assert.equal(status.paymentObservation, fault === 'mcp_after_capture' ? 'unverified' : 'succeeded');
    const attempts = sender.requests.length;
    await assert.rejects(runBedrockBuyer(runPath, options), /ADMISSION_REFUSED/);
    assert.equal(sender.requests.length, attempts);
    assert.deepEqual(readFileSync(join(root, 'buyer', JSON.parse(original).id + '.json')), original);
    assert.equal(readFileSync(join(root, 'model/model-tool-trace.jsonl'), 'utf8').includes('secret-not-to-log'), false);
  });
}
