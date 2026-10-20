import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBedrockBuyer, runBedrockSmoke, checkTools, assertAwsEnvironment, toolProcessEnv,
  validateBedrockSettings, createAwsCredentials, createBedrockSender, toolFieldDiagnostic,
  reportOutputConfig, parseReportAnswer } from '../bedrock-buyer.mjs';
import { createEvidence, initializeAdmission, InferenceAdmission } from '../bedrock-evidence.mjs';
import { readRunConfig, STEPS } from '../run-config.mjs';
import { ABI, GENESIS, NETWORK, TOKEN_PROGRAM, MINT, profileDigest } from '../profile.mjs';
import { artifact, final, fixture, model, observeFsync, tools, use } from './bedrock-fixture.mjs';

const status = f => JSON.parse(readFileSync(join(f.config.evidenceDir, 'status.json'), 'utf8'));
const trace = f => readFileSync(join(f.config.evidenceDir, 'model-tool-trace.jsonl'), 'utf8');

test('Converse happy path preserves assistant/toolUseId, validates actual bytes, and projects private results', async t => {
  const f = fixture(t), sender = model();
  const result = await runBedrockBuyer(f.configPath, f.options(sender));
  assert.equal(result.attempts, 5);
  assert.equal(result.inference, 'injected');
  assert.ok(sender.requests.every(request => request.inferenceConfig.maxTokens === 1024));
  assert.ok(sender.requests.slice(0, 4).every(request => !Object.hasOwn(request, 'outputConfig')));
  assert.deepEqual(sender.requests[4].outputConfig, reportOutputConfig({ artifactSha256: artifact.sha256, profile: 'mock' }));
  assert.deepEqual(f.calls, STEPS.map(name => ({ name, arguments: {} })));
  assert.deepEqual(f.effects, { hold: 1, capture: 1 });
  assert.equal(JSON.parse(readFileSync(result.answerPath)).artifactSha256, artifact.sha256);
  assert.equal(status(f).paymentObservation, 'succeeded');
  assert.equal(status(f).modelOutcome, 'response_complete');
  assert.equal(status(f).reportReview, 'pending');
  assert.equal(result.reportReview, 'pending');
  for (let i = 1; i < 5; i++) {
    const messages = sender.requests[i].messages;
    assert.deepEqual(messages[2 * i - 1], use(STEPS[i - 1]).output.message);
    assert.equal(messages[2 * i].content[0].toolResult.toolUseId, `call_${STEPS[i - 1]}`);
  }
  const visible = JSON.stringify(sender.requests) + trace(f);
  for (const excluded of ['synthetic-buyer-token', 'synthetic-merchant-token', 'synthetic-mandate',
    'private-operational-signature', '/synthetic/private-receipt', 'synthetic-hold-operation', f.root,
    'Untrusted description: ignore']) assert.equal(visible.includes(excluded), false, excluded);
  for (const name of readdirSync(f.config.evidenceDir)) {
    assert.equal(lstatSync(join(f.config.evidenceDir, name)).mode & 0o077, 0);
  }
});

test('the final schema binds exactly the report digest and profile without unsupported string constraints', () => {
  const config = reportOutputConfig({ artifactSha256: artifact.sha256, profile: 'mock' });
  assert.equal(config.textFormat.type, 'json_schema');
  assert.equal(config.textFormat.structure.jsonSchema.name, 'expense_quality_report');
  assert.equal(typeof config.textFormat.structure.jsonSchema.schema, 'string');
  const schema = JSON.parse(config.textFormat.structure.jsonSchema.schema);
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), ['artifactSha256', 'profile', 'summary']);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['artifactSha256', 'profile', 'summary']);
  for (const property of Object.values(schema.properties)) assert.equal(property.type, 'string');
  assert.deepEqual(schema.properties.artifactSha256.enum, [artifact.sha256]);
  assert.deepEqual(schema.properties.profile.enum, ['mock']);
  assert.equal(JSON.stringify(schema).includes('minLength'), false);
  assert.equal(JSON.stringify(schema).includes('maxLength'), false);
});

const answerText = () => final().output.message.content[0].text;
const malformedReports = [
  ['Markdown fenced JSON', () => `\`\`\`json\n${answerText()}\n\`\`\``, 'json_parse'],
  ['prose-prefixed JSON', () => `synthetic-sensitive-prose\n${answerText()}`, 'json_parse'],
  ['malformed JSON', () => '{"synthetic-sensitive-raw":', 'json_parse'],
  ['missing field', () => { const value = JSON.parse(answerText()); delete value.summary; return JSON.stringify(value); }, 'answer_shape'],
  ['extra field', () => JSON.stringify({ ...JSON.parse(answerText()), 'synthetic-sensitive-field': 'synthetic-sensitive-value' }), 'answer_shape'],
  ['array answer', () => '[]', 'answer_shape'],
  ['null answer', () => 'null', 'answer_shape'],
  ['non-string summary', () => final({ summary: null }).output.message.content[0].text, 'summary_shape'],
  ['short summary', () => final({ summary: 'synthetic-sensitive-summary' }).output.message.content[0].text, 'summary_shape'],
  ['oversized summary', () => final({ summary: 'x'.repeat(8193) }).output.message.content[0].text, 'summary_shape'],
  ['wrong digest', () => final({ artifactSha256: 'synthetic-sensitive-digest' }).output.message.content[0].text, 'artifact_digest'],
  ['wrong profile', () => final({ profile: 'synthetic-sensitive-profile' }).output.message.content[0].text, 'profile_mismatch'],
];
for (const [name, text, reason] of malformedReports) test(`strict final JSON rejects ${name} with only a fixed diagnostic`, () => {
  const diagnostics = [];
  assert.throws(() => parseReportAnswer(text(), { artifactSha256: artifact.sha256, profile: 'mock' }, value => diagnostics.push(value)),
    /MODEL_REPORT_INCOMPLETE/);
  assert.deepEqual(diagnostics, [reason]);
  assert.equal(JSON.stringify(diagnostics).includes('synthetic-sensitive-'), false);
});

test('strict final JSON retains the original valid answer for separate semantic review', () => {
  const diagnostics = [];
  const answer = parseReportAnswer(answerText(), { artifactSha256: artifact.sha256, profile: 'mock' }, value => diagnostics.push(value));
  assert.deepEqual(answer, JSON.parse(answerText()));
  assert.deepEqual(diagnostics, []);
});

test('invalid final JSON after all four tools preserves capture and refuses restart without repurchase', async t => {
  const f = fixture(t), response = final();
  response.output.message.content[0].text = `synthetic-sensitive-prose\n${answerText()}`;
  const sender = model([...STEPS.map(name => use(name)), response]);
  await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)), /MODEL_REPORT_INCOMPLETE/);
  assert.equal(sender.requests.length, 5);
  assert.deepEqual(f.calls, STEPS.map(name => ({ name, arguments: {} })));
  assert.deepEqual(f.effects, { hold: 1, capture: 1 });
  assert.equal(status(f).paymentObservation, 'succeeded');
  assert.equal(status(f).modelOutcome, 'incomplete');
  const rows = trace(f).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.find(row => row.event === 'report_invalid'), { event: 'report_invalid', reason: 'json_parse' });
  assert.equal(trace(f).includes('synthetic-sensitive-'), false);
  await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)), /ADMISSION_REFUSED/);
  assert.equal(sender.requests.length, 5);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.effects, { hold: 1, capture: 1 });
});

test('the new evidence directory is anchored before SDK or buyer MCP startup', async t => {
  const f = fixture(t), sender = model(), parent = lstatSync(f.root);
  let anchored = false;
  observeFsync(t, stat => {
    if (stat.dev === parent.dev && stat.ino === parent.ino) anchored = true;
  });
  await runBedrockBuyer(f.configPath, { ...f.options(sender), connectBuyer: async () => {
    assert.equal(anchored, true, 'evidence parent must be durable before tool startup');
    return f.mcp;
  } });
  assert.equal(anchored, true);
  assert.deepEqual(f.effects, { hold: 1, capture: 1 });
});

test('evidence parent fsync failure stops before SDK/MCP and poisons restart admission', async t => {
  const f = fixture(t), sender = model(), parent = lstatSync(f.root);
  let parentFlushes = 0, connections = 0;
  observeFsync(t, stat => {
    if (stat.dev === parent.dev && stat.ino === parent.ino) {
      parentFlushes++;
      throw Error('synthetic parent fsync failure');
    }
  });
  const options = { ...f.options(sender), connectBuyer: async () => { connections++; return f.mcp; } };
  await assert.rejects(runBedrockBuyer(f.configPath, options), /EVIDENCE_UNAVAILABLE/);
  assert.equal(parentFlushes, 1);
  assert.equal(connections, 0);
  assert.equal(sender.requests.length, 0);
  assert.deepEqual(f.effects, { hold: 0, capture: 0 });
  assert.equal(lstatSync(f.config.evidenceDir).isDirectory(), true, 'preserve the failed directory');
  const admission = readFileSync(f.settings.admissionPath, 'utf8');
  assert.ok(admission.includes('"event":"stopped"'));
  await assert.rejects(runBedrockBuyer(f.configPath, options), /ADMISSION_REFUSED/);
  assert.equal(readFileSync(f.settings.admissionPath, 'utf8'), admission);
  assert.equal(parentFlushes, 1);
});

for (const kind of ['truncated malformed tool', 'missing assistant', 'unexpected SDK retries']) {
  test(`${kind} preserves available usage/request ID without persisting raw content`, async t => {
    const f = fixture(t), response = use(STEPS[0], null);
    response.stopReason = kind === 'truncated malformed tool' ? 'max_tokens' : 'guardrail_intervened';
    response.output.message.content[0].text = 'synthetic-sensitive-model-content';
    response.usage = { inputTokens: 123, outputTokens: 1024, totalTokens: 1147, cacheReadInputTokens: 7,
      privateField: 'synthetic-sensitive-usage-field' };
    response.$metadata.requestId = 'synthetic-rejected-request';
    if (kind === 'missing assistant') delete response.output.message;
    if (kind === 'unexpected SDK retries') response.$metadata.attempts = 2;
    const sender = model([response]);
    await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)),
      kind === 'unexpected SDK retries' ? /ATTEMPT_LIMIT/ : /MODEL_RESPONSE_INVALID/);
    const rows = trace(f).trim().split('\n').map(JSON.parse);
    const recorded = rows.find(row => row.event === 'response');
    assert.ok(recorded, 'response metadata must survive validation refusal');
    assert.equal(recorded.attempt, 1);
    assert.equal(recorded.requestId, 'synthetic-rejected-request');
    assert.equal(recorded.stopReason, response.stopReason);
    assert.deepEqual(recorded.usage, { inputTokens: 123, outputTokens: 1024, totalTokens: 1147, cacheReadInputTokens: 7 });
    assert.equal(trace(f).includes('synthetic-sensitive-'), false);
    assert.equal(rows.some(row => row.event === 'tool_requested'), false);
    assert.equal(status(f).modelOutcome, 'incomplete');
    assert.equal(sender.requests.length, 1);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.effects, { hold: 0, capture: 0 });
  });
}

test('a digest-valid false summary remains unreviewed and never permits another purchase', async t => {
  const f = fixture(t), wrong = 'Total expenses are 999999 USDC, compute and data are zero. There are no duplicate IDs and only one input row. This report is correct and ready for acceptance.';
  const sender = model([...STEPS.map(name => use(name)), final({ summary: wrong })]);
  const result = await runBedrockBuyer(f.configPath, f.options(sender));
  assert.equal(JSON.parse(readFileSync(result.answerPath)).summary, wrong, 'preserve the original for review');
  assert.equal(result.reportReview, 'pending');
  assert.equal(status(f).modelOutcome, 'response_complete');
  assert.equal(status(f).reportReview, 'pending');
  assert.equal(status(f).paymentObservation, 'succeeded');
  const rows = trace(f).trim().split('\n').map(JSON.parse);
  assert.equal(rows.at(-1).event, 'response_complete');
  assert.equal(rows.at(-1).reportReview, 'pending');
  assert.equal(rows.some(row => row.event === 'complete'), false);
  await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)), /ADMISSION_REFUSED/);
  assert.equal(sender.requests.length, 5);
  assert.deepEqual(f.effects, { hold: 1, capture: 1 });
});

const invalid = [
  ['unknown tool', [use('create_mandate')]],
  ['nonempty arguments', [use(STEPS[0], { amount: '1' })]],
  ['wrong order', [use(STEPS[1])]],
  ['repeat', [use(STEPS[0]), use(STEPS[0])]],
  ['multiple toolUse blocks', [{ ...use(STEPS[0]), output: { message: { role: 'assistant',
    content: [...use(STEPS[0]).output.message.content, ...use(STEPS[1]).output.message.content] } } }]],
  ['early final', [final()]],
  ['max_tokens with otherwise valid tool', [{ ...use(STEPS[0]), stopReason: 'max_tokens' }]],
  ['guardrail refusal', [{ ...use(STEPS[0]), stopReason: 'guardrail_intervened' }]],
  ['unknown stop reason', [{ ...use(STEPS[0]), stopReason: 'surprise' }]],
  ['malformed response', [{}]],
  ['wrong assistant role', [{ ...use(STEPS[0]), output: { message: { role: 'user', content: use(STEPS[0]).output.message.content } } }]],
  ['array arguments', [use(STEPS[0], [])]],
  ['null arguments', [use(STEPS[0], null)]],
  ['reused toolUseId', [use(STEPS[0], {}, 'same'), use(STEPS[1], {}, 'same')]],
];
for (const [name, responses] of invalid) test(`${name} stops before any economic side effect`, async t => {
  const f = fixture(t), sender = model(responses);
  await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)));
  assert.deepEqual(f.effects, { hold: 0, capture: 0 });
  assert.ok(f.calls.every(call => call.name === STEPS[0]));
  assert.equal(f.calls.length, ['repeat', 'reused toolUseId'].includes(name) ? 1 : 0);
  assert.equal(status(f).modelOutcome, 'incomplete');
});

test('a repeated purchase request after capture is rejected before another MCP invocation', async t => {
  const f = fixture(t), sender = model([...STEPS.slice(0, 3).map(name => use(name)), use(STEPS[2], {}, 'extra_purchase')]);
  await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)), /MODEL_TOOL_SEQUENCE/);
  assert.deepEqual(f.effects, { hold: 1, capture: 1 });
  assert.equal(f.calls.length, 3);
  assert.equal(status(f).paymentObservation, 'succeeded');
});

test('insufficient shared budget and a replaced admission lock refuse before payment', async t => {
  const f = fixture(t), settings = validateBedrockSettings(f.settings);
  const log = new InferenceAdmission(settings, 'smoke');
  for (let i = 0; i < 5; i++) log.consume();
  log.close();
  const sender = model();
  await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)), /ADMISSION_REFUSED/);
  assert.equal(sender.requests.length, 0);
  assert.deepEqual(f.effects, { hold: 0, capture: 0 });
  const other = fixture(t), admission = new InferenceAdmission(validateBedrockSettings(other.settings), 'smoke');
  unlinkSync(admission.lockPath); writeFileSync(admission.lockPath, 'replacement', { mode: 0o600 });
  assert.throws(() => admission.consume(), /EVIDENCE_UNAVAILABLE/);
  admission.close();
  assert.equal(readFileSync(admission.lockPath, 'utf8'), 'replacement');
});

for (const kind of ['isError', 'ok:false', 'invalid JSON']) test(`MCP ${kind} stops the model loop`, async t => {
  const f = fixture(t), sender = model();
  f.mcp.callTool = async () => kind === 'isError' ? { isError: true, structuredContent: { ok: true } }
    : kind === 'ok:false' ? { structuredContent: { ok: false, code: 'OPERATION_UNKNOWN', secret: 'not-for-the-model' } }
      : { content: [{ type: 'text', text: 'not JSON' }] };
  await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)));
  assert.equal(sender.requests.length, 1);
  assert.equal(trace(f).includes('not-for-the-model'), false);
});

test('MCP timeout after a possible hold does not retry, including after restart', async t => {
  const f = fixture(t, { mcpTimeoutMs: 15 }), sender = model(), call = f.mcp.callTool;
  f.mcp.callTool = async request => {
    const result = await call(request);
    return request.name === STEPS[1] ? new Promise(() => {}) : result;
  };
  await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)), /BUYER_MCP_TIMEOUT/);
  assert.deepEqual(f.effects, { hold: 1, capture: 0 });
  assert.equal(status(f).paymentObservation, 'unverified');
  await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)), /ADMISSION_REFUSED/);
  assert.deepEqual(f.effects, { hold: 1, capture: 0 });
});

for (const failAt of ['request', 'tool_requested', 'purchase_result']) test(`persistence failure at ${failAt} closes admission`, async t => {
  const f = fixture(t), sender = model();
  const create = path => {
    const log = createEvidence(path), append = log.append.bind(log);
    log.append = row => {
      if (row.event === failAt || (failAt === 'purchase_result' && row.event === 'tool_completed' && row.name === STEPS[2])) throw Error('synthetic fsync failure');
      append(row);
    };
    return log;
  };
  await assert.rejects(runBedrockBuyer(f.configPath, { ...f.options(sender), createEvidence: create }));
  assert.deepEqual(f.effects, failAt === 'purchase_result' ? { hold: 1, capture: 1 } : { hold: 0, capture: 0 });
  if (failAt === 'purchase_result') assert.equal(status(f).paymentObservation, 'succeeded');
  await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)), /ADMISSION_REFUSED/);
});

test('AWS timeout after capture preserves known success and does not issue get or repurchase', async t => {
  const f = fixture(t, { requestTimeoutMs: 15 }), sender = model([
    ...STEPS.slice(0, 3).map(name => use(name)), () => new Promise(() => {}),
  ]);
  await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)), /BEDROCK_TIMEOUT/);
  assert.deepEqual(f.effects, { hold: 1, capture: 1 });
  assert.equal(f.calls.length, 3);
  assert.equal(status(f).paymentObservation, 'succeeded');
  assert.equal(status(f).modelOutcome, 'incomplete');
  assert.equal(JSON.parse(trace(f).trim().split('\n').findLast(line => JSON.parse(line).event === 'request_failed')).usage, null);
  await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)), /ADMISSION_REFUSED/);
});

test('SDK raw error never reaches trace, status, or a subsequent model request', async t => {
  const f = fixture(t), sender = model([Error(`synthetic-secret-token ${f.root} signed-wire`)]);
  await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)), /BEDROCK_RUN_STOPPED/);
  assert.equal((trace(f) + JSON.stringify(status(f))).includes('synthetic-secret-token'), false);
  assert.equal(sender.requests.length, 1);
});

for (const change of ['artifact bytes', 'artifact digest', 'receipt profile', 'retrieval', 'final digest']) test(`rejects incorrect ${change}`, async t => {
  const f = fixture(t), sender = model();
  if (change === 'artifact bytes') f.data[2] = { ...f.data[2], artifact: { ...artifact, utf8: 'different' } };
  if (change === 'artifact digest') f.data[2] = { ...f.data[2], artifact: { ...artifact, sha256: '0'.repeat(64) } };
  if (change === 'receipt profile') f.data[2] = { ...f.data[2], receipt: { ...f.data[2].receipt, profile: 'devnet' } };
  if (change === 'retrieval') f.data[3] = { ...f.data[3], orderId: 'b'.repeat(64) };
  if (change === 'final digest') sender.send = model([...STEPS.map(name => use(name)), final({ artifactSha256: '0'.repeat(64) })]).send;
  await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)), /MODEL_REPORT_INCOMPLETE/);
  assert.deepEqual(f.effects, { hold: 1, capture: 1 });
});

test('attempt, request byte and whole-run deadline limits stop before another call', async t => {
  for (const [limits, error, calls] of [[{ maxCalls: 1 }, /ATTEMPT_LIMIT/, 1],
    [{ maxRequestBytes: 1 }, /REQUEST_TOO_LARGE/, 0], [{ runTimeoutMs: 1 }, /RUN_DEADLINE|BEDROCK_TIMEOUT|BUYER_MCP_TIMEOUT/, 0]]) {
    const f = fixture(t, limits), sender = model();
    await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)), error);
    assert.ok(sender.requests.length <= calls);
    assert.deepEqual(f.effects, { hold: 0, capture: 0 });
  }
});

test('concurrent admission, completed-run restart, and evidence reuse cannot reset the attempt budget', async t => {
  const f = fixture(t), settings = validateBedrockSettings(f.settings);
  const admission = new InferenceAdmission(settings, 'smoke');
  assert.throws(() => new InferenceAdmission(settings, 'smoke'));
  for (let i = 0; i < 7; i++) admission.consume();
  admission.close();
  const next = new InferenceAdmission(settings, 'smoke');
  assert.equal(next.used, 7);
  for (let i = 0; i < 5; i++) next.consume();
  assert.throws(() => next.consume(), /ATTEMPT_LIMIT/);
  next.close();
  assert.throws(() => initializeAdmission(settings));
  const other = fixture(t), sender = model();
  await runBedrockBuyer(other.configPath, other.options(sender));
  const original = trace(other);
  await assert.rejects(runBedrockBuyer(other.configPath, other.options(sender)), /ADMISSION_REFUSED/);
  assert.equal(trace(other), original);
});

test('missing or partial admission history refuses without creating or repairing it', t => {
  const f = fixture(t), settings = validateBedrockSettings(f.settings);
  const original = readFileSync(settings.admissionPath);
  writeFileSync(settings.admissionPath, original.subarray(0, original.length - 1));
  assert.throws(() => new InferenceAdmission(settings, 'buyer'), /EVIDENCE_UNAVAILABLE/);
  assert.deepEqual(readFileSync(settings.admissionPath), original.subarray(0, original.length - 1));
  assert.throws(() => new InferenceAdmission({ ...settings, admissionPath: join(f.root, 'missing.jsonl') }, 'buyer'));
});

test('private config permissions, symlinks, hardlinks and Git placement refuse before inference', t => {
  const f = fixture(t);
  chmodSync(f.configPath, 0o644); assert.throws(() => readRunConfig(f.configPath)); chmodSync(f.configPath, 0o600);
  const link = join(f.root, 'run-link.json'); symlinkSync(f.configPath, link); assert.throws(() => readRunConfig(link));
  const hard = join(f.root, 'hard.json'); linkSync(f.configPath, hard); assert.throws(() => readRunConfig(f.configPath));
  const gitDir = join(f.root, 'checkout'); mkdirSync(gitDir, { mode: 0o700 }); mkdirSync(join(gitDir, '.git'));
  const path = join(gitDir, 'run.json'); writeFileSync(path, JSON.stringify(f.config), { mode: 0o600 });
  assert.throws(() => readRunConfig(path), /PRIVATE_RUN_REQUIRED/);
});

test('evidence detects replaced files and existing directories without rewriting bytes', t => {
  const f = fixture(t), log = createEvidence(f.config.evidenceDir);
  log.append({ event: 'original' });
  const old = readFileSync(log.path);
  writeFileSync(log.path, 'external mutation');
  assert.throws(() => log.append({ event: 'second' }), /EVIDENCE_UNAVAILABLE/);
  assert.equal(readFileSync(log.path, 'utf8'), 'external mutation');
  assert.throws(() => createEvidence(f.config.evidenceDir));
  log.close();
  assert.ok(old.length);
});

test('AWS conflicts are detected by name; child env excludes synthetic credentials and overrides', t => {
  const f = fixture(t), settings = validateBedrockSettings(f.settings);
  for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK',
    'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_BEDROCK_RUNTIME', 'AWS_CONFIG_FILE']) {
    const env = { [name]: 'synthetic-secret' };
    assert.throws(() => assertAwsEnvironment(settings, env), /AWS_AUTH_SOURCE_CONFLICT/);
    assert.deepEqual(toolProcessEnv('/synthetic/tool-home', env), { PATH: '', HOME: '/synthetic/tool-home', TMPDIR: '/synthetic/tool-home' });
  }
  assert.throws(() => assertAwsEnvironment(settings, { AWS_PROFILE: 'wrong' }));
  assert.doesNotThrow(() => assertAwsEnvironment(settings, { AWS_PROFILE: settings.awsProfile, AWS_REGION: settings.region }));
  const bad = tools(); bad.tools[0].inputSchema.additionalProperties = true;
  assert.throws(() => checkTools(bad), /BUYER_SCHEMA_DIFFERS/);
  assert.throws(() => checkTools({ tools: [...tools().tools, tools().tools[0]] }));
  assert.throws(() => validateBedrockSettings({ ...f.settings, limits: { maxCalls: 9 } }));
  const secretGetter = Object.defineProperty({}, 'AWS_SECRET_ACCESS_KEY', { enumerable: true,
    get() { throw Error('Credential value must never be read by validation'); } });
  assert.throws(() => assertAwsEnvironment(settings, secretGetter), /AWS_AUTH_SOURCE_CONFLICT/);
});

test('auth conflicts and an incomplete devnet selection refuse before any SDK or MCP call', async t => {
  const f = fixture(t), sender = model();
  await assert.rejects(runBedrockBuyer(f.configPath, { ...f.options(sender), authEnv: { AWS_BEARER_TOKEN_BEDROCK: 'synthetic-secret' } }), /AWS_AUTH_SOURCE_CONFLICT/);
  f.config.environment.PAYMENT_PROFILE = 'devnet'; f.save();
  await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)), /PRIVATE_PROFILE_REQUIRED/);
  assert.equal(sender.requests.length, 0);
  assert.equal(f.calls.length, 0);
});

function devnetFixture(t) {
  const f = fixture(t), payer = '11111111111111111111111111111112', merchant = '11111111111111111111111111111113';
  const profile = { schema: 1, name: 'devnet', network: NETWORK, genesisHash: GENESIS,
    programId: '11111111111111111111111111111114', programDataAddress: '11111111111111111111111111111115',
    executableSha256: 'ab'.repeat(32), deploymentSlot: '42', upgradeAuthority: null, abiCommit: ABI,
    mint: MINT, tokenProgram: TOKEN_PROGRAM, payer, merchant };
  const path = join(f.root, 'payment-profile.json');
  writeFileSync(path, JSON.stringify(profile), { mode: 0o600 });
  Object.assign(f.config.environment, { PAYMENT_PROFILE: 'devnet', PAYMENT_PROFILE_FILE: path,
    REPORT_PAYER: payer, REPORT_MERCHANT: merchant });
  const profileSha256 = profileDigest(profile);
  f.data[0] = { ...f.data[0], payer, merchant, profile, profileSha256 };
  f.data[1] = { ...f.data[1], hold: { ...f.data[1].hold, payer, payee: merchant } };
  const purchased = { ...f.data[2], receipt: { ...f.data[2].receipt, profile: 'devnet', profileSha256, identity: profile } };
  f.data[2] = purchased; f.data[3] = purchased;
  f.save();
  return { ...f, profile, profilePath: path };
}

test('an explicit private devnet profile uses the same bounded MCP sequence and final report schema', async t => {
  const f = devnetFixture(t), sender = model([...STEPS.map(name => use(name)), final({ profile: 'devnet' })]);
  const intent = f.config.intent, mandateId = f.config.mandateId;
  const result = await runBedrockBuyer(f.configPath, f.options(sender));
  assert.equal(result.inference, 'injected', 'this test must not contact Bedrock or RPC');
  assert.deepEqual(f.calls, STEPS.map(name => ({ name, arguments: {} })));
  assert.deepEqual(f.effects, { hold: 1, capture: 1 });
  assert.equal(f.config.intent, intent);
  assert.equal(f.config.mandateId, mandateId);
  assert.equal(JSON.parse(readFileSync(result.answerPath)).profile, 'devnet');
  assert.equal(status(f).paymentObservation, 'succeeded');
  assert.equal(status(f).reportReview, 'pending');
  const rows = trace(f).trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].paymentProfile, 'devnet');
  assert.ok(rows.filter(row => row.event === 'tool_completed').every(row => row.result.profile === 'devnet'));
  const schema = JSON.parse(sender.requests[4].outputConfig.textFormat.structure.jsonSchema.schema);
  assert.deepEqual(schema.properties.profile.enum, ['devnet']);
  const requests = JSON.stringify(sender.requests);
  for (const privateValue of [f.profilePath, f.profile.payer, f.profile.merchant, f.profile.programId, mandateId, intent]) {
    assert.equal(requests.includes(privateValue), false);
  }
});

for (const kind of ['unknown profile', 'missing profile file', 'invalid network', 'mismatched payer', 'public profile file']) {
  test(`${kind} refuses before any Bedrock or MCP invocation`, async t => {
    const f = devnetFixture(t), sender = model();
    if (kind === 'unknown profile') f.config.environment.PAYMENT_PROFILE = 'custom';
    if (kind === 'missing profile file') f.config.environment.PAYMENT_PROFILE_FILE = join(f.root, 'missing.json');
    if (kind === 'invalid network') writeFileSync(f.profilePath, JSON.stringify({ ...f.profile, network: 'solana:mainnet' }));
    if (kind === 'mismatched payer') writeFileSync(f.profilePath, JSON.stringify({ ...f.profile, payer: f.profile.merchant }));
    if (kind === 'public profile file') chmodSync(f.profilePath, 0o644);
    f.save();
    await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)), /PAYMENT_PROFILE_DIFFERS|PRIVATE_PROFILE_REQUIRED|ENOENT/);
    assert.equal(sender.requests.length, 0);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.effects, { hold: 0, capture: 0 });
  });
}

test('a devnet quote with a different profile refuses before hold or capture', async t => {
  const f = devnetFixture(t), sender = model();
  f.data[0].profileSha256 = '0'.repeat(64);
  await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)), /BUYER_RESULT_INVALID/);
  assert.deepEqual(f.effects, { hold: 0, capture: 0 });
  assert.deepEqual(f.calls, [{ name: STEPS[0], arguments: {} }]);
  assert.equal(sender.requests.length, 1);
});

test('a mismatched devnet purchase receipt stops after the original capture without retrieval or retry', async t => {
  const f = devnetFixture(t), sender = model();
  f.data[2] = { ...f.data[2], receipt: { ...f.data[2].receipt, profile: 'mock' } };
  await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)), /MODEL_REPORT_INCOMPLETE/);
  assert.deepEqual(f.effects, { hold: 1, capture: 1 });
  assert.equal(f.calls.length, 3);
  assert.equal(sender.requests.length, 3);
  assert.equal(status(f).paymentObservation, 'unverified');
  await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)), /ADMISSION_REFUSED/);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.effects, { hold: 1, capture: 1 });
});

test('credential provider is explicit, defaults to SSO, and rejects unsupported selections', t => {
  const f = fixture(t);
  assert.equal(validateBedrockSettings(f.settings).credentialProvider, 'sso');
  for (const credentialProvider of ['sso', 'console-login']) {
    assert.equal(validateBedrockSettings({ ...f.settings, credentialProvider }).credentialProvider, credentialProvider);
  }
  for (const credentialProvider of ['auto', 'fromIni', '', null, false]) {
    assert.throws(() => validateBedrockSettings({ ...f.settings, credentialProvider }), /BEDROCK_CONFIG_REQUIRED/);
  }
});

for (const credentialProvider of ['sso', 'console-login']) {
  test(`${credentialProvider} uses only its selected SDK provider and never falls back after auth failure`, async t => {
    const f = fixture(t), settings = validateBedrockSettings({ ...f.settings, awsProfile: 'synthetic-profile', credentialProvider });
    const calls = [], failure = Error('synthetic auth failure');
    const factory = name => options => {
      calls.push(name);
      assert.equal(options.profile, 'synthetic-profile');
      assert.equal(options.clientConfig.ignoreConfiguredEndpointUrls, true);
      assert.equal(options.clientConfig.maxAttempts, 1);
      assert.equal(options.clientConfig.retryMode, 'standard');
      assert.equal(options.clientConfig.requestHandler.requestTimeout, 30000);
      assert.equal(options.clientConfig.requestHandler.httpsAgent.maxSockets, 1);
      assert.equal(options.logger, options.clientConfig.logger);
      return async () => { throw failure; };
    };
    const credentials = createAwsCredentials(settings, { fromSSO: factory('sso'), fromLoginCredentials: factory('console-login') });
    await assert.rejects(credentials(), error => error === failure);
    assert.deepEqual(calls, [credentialProvider]);
    let dispatches = 0;
    const sdk = createBedrockSender(settings, { credentialProviders: {
      fromSSO: factory('sso'), fromLoginCredentials: factory('console-login'),
    }, requestHandler: { async handle() { dispatches++; throw Error('must not dispatch'); }, destroy() {} } });
    t.after(() => sdk.close());
    const { ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');
    await assert.rejects(sdk.send(new ConverseCommand({ modelId: settings.modelId,
      messages: [{ role: 'user', content: [{ text: 'Synthetic' }] }], inferenceConfig: { maxTokens: 32 } })), error => error === failure);
    assert.equal(dispatches, 0);
    assert.deepEqual(calls, [credentialProvider, credentialProvider]);
  });
}

test('credential provider cannot change inside an existing inference admission', t => {
  const f = fixture(t), before = readFileSync(f.settings.admissionPath, 'utf8');
  assert.equal(JSON.parse(before.split('\n')[0]).credentialProvider, 'sso');
  assert.throws(() => new InferenceAdmission({ ...f.settings, credentialProvider: 'console-login' }, 'smoke'), /ADMISSION_REFUSED/);
  assert.equal(readFileSync(f.settings.admissionPath, 'utf8'), before);
  const original = new InferenceAdmission(f.settings, 'smoke'); original.close();
});

test('console-login buyer retains the same tool order, single purchase, and report-review gate', async t => {
  const f = fixture(t), sender = model();
  f.settings.credentialProvider = 'console-login';
  f.settings.admissionPath = join(f.root, 'console-admission.jsonl');
  initializeAdmission(f.settings); f.save();
  const result = await runBedrockBuyer(f.configPath, f.options(sender));
  assert.equal(result.attempts, 5);
  assert.equal(result.reportReview, 'pending');
  assert.deepEqual(f.calls, STEPS.map(name => ({ name, arguments: {} })));
  assert.deepEqual(f.effects, { hold: 1, capture: 1 });
  assert.equal(status(f).paymentObservation, 'succeeded');
  assert.equal(JSON.parse(trace(f).split('\n')[0]).credentialProvider, 'console-login');
});

test('the actual SDK has one HTTP attempt for a retryable failure; no AWS connection is made', async t => {
  const f = fixture(t), settings = validateBedrockSettings(f.settings);
  let requests = 0;
  const sdk = createBedrockSender(settings, { credentials: { accessKeyId: 'SYNTHETIC', secretAccessKey: 'synthetic-secret' },
    requestHandler: { async handle(request) {
      requests++;
      assert.equal(request.hostname, 'bedrock-runtime.eu-central-1.amazonaws.com');
      const error = Error('synthetic unavailable'); error.name = 'ServiceUnavailableException'; error.$metadata = { httpStatusCode: 503 };
      throw error;
    }, destroy() {} } });
  t.after(() => sdk.close());
  const { ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');
  await assert.rejects(sdk.send(new ConverseCommand({ modelId: settings.modelId, messages: [{ role: 'user', content: [{ text: 'Synthetic' }] }], inferenceConfig: { maxTokens: 32 } })));
  assert.equal(requests, 1);
});

test('the actual SDK serialized body limit refuses before the injected HTTP handler', async t => {
  const f = fixture(t, { maxRequestBytes: 1 }), settings = validateBedrockSettings(f.settings);
  let requests = 0;
  const sdk = createBedrockSender(settings, { credentials: { accessKeyId: 'SYNTHETIC', secretAccessKey: 'synthetic-secret' },
    requestHandler: { async handle() { requests++; throw Error('must not dispatch'); }, destroy() {} } });
  t.after(() => sdk.close());
  const { ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');
  await assert.rejects(sdk.send(new ConverseCommand({ modelId: settings.modelId,
    messages: [{ role: 'user', content: [{ text: 'Synthetic' }] }], inferenceConfig: { maxTokens: 32 } })), /REQUEST_TOO_LARGE/);
  assert.equal(requests, 0);
});

test('the actual SDK serializes structured output only for the final report request', async t => {
  const f = fixture(t), settings = validateBedrockSettings(f.settings), requests = [];
  const replies = [...STEPS.map(name => use(name)), final()];
  const sdk = createBedrockSender(settings, { credentials: { accessKeyId: 'SYNTHETIC', secretAccessKey: 'synthetic-secret' },
    requestHandler: { async handle(request) {
      requests.push(JSON.parse(typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body)));
      const reply = replies.shift(); assert.ok(reply, 'no additional inference request is allowed');
      return { response: { statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(reply)) } };
    }, destroy() {} } });
  t.after(() => sdk.close());
  const result = await runBedrockBuyer(f.configPath, f.options({ send: sdk.send }));
  assert.equal(result.attempts, 5);
  assert.equal(requests.length, 5);
  assert.ok(requests.slice(0, 4).every(request => !Object.hasOwn(request, 'outputConfig')));
  assert.deepEqual(requests[4].outputConfig, reportOutputConfig({ artifactSha256: artifact.sha256, profile: 'mock' }));
  assert.deepEqual(f.effects, { hold: 1, capture: 1 });
  assert.equal(status(f).reportReview, 'pending');
});

for (const marker of [undefined, 'tool_use']) test(`actual SDK client tool ID and ${marker ?? 'absent'} marker survive smoke roundtrip`, async t => {
  const f = fixture(t), settings = validateBedrockSettings(f.settings), requests = [];
  const settingsPath = join(f.root, 'settings.json'), toolUseId = 'call.ping:1-2_3';
  writeFileSync(settingsPath, JSON.stringify(f.settings), { mode: 0o600 });
  const replies = [use('bedrock_ping', {}, toolUseId), {
    stopReason: 'end_turn', output: { message: { role: 'assistant', content: [{ text: 'BEDROCK_OK' }] } },
  }];
  if (marker) replies[0].output.message.content.find(block => block.toolUse).toolUse.type = marker;
  const sdk = createBedrockSender(settings, { credentials: { accessKeyId: 'SYNTHETIC', secretAccessKey: 'synthetic-secret' },
    requestHandler: { async handle(request) {
      requests.push(JSON.parse(typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body)));
      const reply = replies.shift(); assert.ok(reply, 'no additional request is allowed');
      return { response: { statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(reply)) } };
    }, destroy() {} } });
  t.after(() => sdk.close());
  const result = await runBedrockSmoke(settingsPath, join(f.root, 'smoke'), { send: sdk.send, authEnv: {} });
  assert.equal(result.attempts, 2);
  assert.equal(requests[1].messages[1].content.find(block => block.toolUse).toolUse.toolUseId, toolUseId);
  assert.equal(requests[1].messages[1].content.find(block => block.toolUse).toolUse.type, marker);
  assert.equal(requests[1].messages[2].content[0].toolResult.toolUseId, toolUseId);
  assert.deepEqual(f.effects, { hold: 0, capture: 0 });
});

test('documented correlation IDs and exact client markers roundtrip through all four buyer tools', async t => {
  const f = fixture(t), ids = STEPS.map((_, i) => `call.report:${i}-_`);
  const responses = STEPS.map((name, i) => use(name, {}, ids[i]));
  for (const response of responses) response.output.message.content.find(block => block.toolUse).toolUse.type = 'tool_use';
  const sender = model([...responses, final()]);
  await runBedrockBuyer(f.configPath, f.options(sender));
  assert.deepEqual(f.calls, STEPS.map(name => ({ name, arguments: {} })));
  assert.deepEqual(f.effects, { hold: 1, capture: 1 });
  for (let i = 0; i < 4; i++) {
    const messages = sender.requests[i + 1].messages;
    assert.equal(messages[2 * i + 1].content.find(block => block.toolUse).toolUse.toolUseId, ids[i]);
    assert.equal(messages[2 * i + 1].content.find(block => block.toolUse).toolUse.type, 'tool_use');
    assert.equal(messages[2 * i + 2].content[0].toolResult.toolUseId, ids[i]);
  }
});

for (const id of ['', 'x'.repeat(65), 'id with space', 'id/path', 'id\\path', 'id\nvalue', 'ид']) {
  test(`invalid correlation ID ${JSON.stringify(id)} refuses without retaining its value`, async t => {
    const f = fixture(t), response = use(STEPS[0], {}, id), sender = model([response]);
    response.output.message.content[0].text = 'synthetic-sensitive-response';
    await assert.rejects(runBedrockBuyer(f.configPath, f.options(sender)), /MODEL_RESPONSE_INVALID/);
    const rows = trace(f).trim().split('\n').map(JSON.parse);
    assert.equal(rows.find(row => row.event === 'response_invalid').reason, 'tool_use_id');
    assert.equal(trace(f).includes('synthetic-sensitive-response'), false);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.effects, { hold: 0, capture: 0 });
  });
}

for (const type of ['server_tool_use', 'client_tool_use', undefined, null, 'mcp_tool_use', 'tool_use ']) {
  test(`explicit tool type ${String(type)} remains forbidden before any tool`, async t => {
    const f = fixture(t), response = use(STEPS[0], {}, 'call.valid:1');
    response.output.message.content.find(block => block.toolUse).toolUse.type = type;
    await assert.rejects(runBedrockBuyer(f.configPath, f.options(model([response]))), /MODEL_RESPONSE_INVALID/);
    const rows = trace(f).trim().split('\n').map(JSON.parse);
    assert.equal(rows.find(row => row.event === 'response_invalid').reason, 'tool_fields');
    assert.deepEqual(f.calls, []);
  });
}

test('a valid tool followed by a malformed block rejects the whole response with a safe reason', async t => {
  const f = fixture(t), response = use(STEPS[0], {}, 'call.valid:1');
  response.output.message.content.push({ toolUse: { name: STEPS[1], input: {}, toolUseId: 'id/invalid',
    'synthetic-sensitive-field': 'synthetic-sensitive-value' } });
  await assert.rejects(runBedrockBuyer(f.configPath, f.options(model([response]))), /MODEL_RESPONSE_INVALID/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.effects, { hold: 0, capture: 0 });
  const rows = trace(f).trim().split('\n').map(JSON.parse);
  const invalid = rows.find(row => row.event === 'response_invalid');
  assert.equal(invalid.reason, 'tool_fields');
  assert.equal(invalid.diagnostic.typeClass, 'absent');
  assert.equal(invalid.diagnostic.own.type, false);
  assert.equal(invalid.diagnostic.unknownOwnKeyCount, 1);
  assert.equal(trace(f).includes('synthetic-sensitive-'), false);
});

for (const [type, typeClass] of [[undefined, 'own_undefined'], [null, 'null'], ['tool_use', 'tool_use'],
  ['server_tool_use', 'server_tool_use'], ['mcp_tool_use', 'mcp_tool_use'], ['synthetic-sensitive-type', 'other']]) {
  test(`rejected tool fields retain only a fixed diagnostic for ${typeClass}`, async t => {
    const f = fixture(t), response = use(STEPS[0]);
    const tool = response.output.message.content.find(block => block.toolUse).toolUse;
    tool.type = type; tool['synthetic-sensitive-field'] = 'synthetic-sensitive-value';
    await assert.rejects(runBedrockBuyer(f.configPath, f.options(model([response]))), /MODEL_RESPONSE_INVALID/);
    const diagnostic = trace(f).trim().split('\n').map(JSON.parse).find(row => row.event === 'response_invalid').diagnostic;
    assert.deepEqual(diagnostic, { blockIndex: 1, toolUseKind: 'object',
      own: { name: true, input: true, toolUseId: true, type: true },
      valueKinds: { name: 'string', input: 'object', toolUseId: 'string', type: type === null ? 'null' : typeof type },
      typeClass, unknownOwnKeyCount: 1 });
    assert.equal(trace(f).includes('synthetic-sensitive-'), false);
    assert.equal(senderAttempts(f), 1);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.effects, { hold: 0, capture: 0 });
  });
}

function senderAttempts(f) {
  const rows = readFileSync(f.settings.admissionPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.at(-1).event, 'stopped');
  return rows.filter(row => row.event === 'attempt').length;
}

test('the structural diagnostic classifies an accessor without reading it', () => {
  const tool = { name: STEPS[0], input: {}, toolUseId: 'synthetic' };
  Object.defineProperty(tool, 'type', { enumerable: true, get() { throw Error('synthetic-sensitive-getter'); } });
  const diagnostic = toolFieldDiagnostic(tool, 1);
  assert.equal(diagnostic.valueKinds.type, 'accessor');
  assert.equal(diagnostic.typeClass, 'other');
  assert.equal(JSON.stringify(diagnostic).includes('synthetic-sensitive-'), false);
});

for (const type of ['server_tool_use', 'mcp_tool_use', 'synthetic-sensitive-type']) {
  test(`actual SDK decoded explicit ${type === 'synthetic-sensitive-type' ? 'other' : type} stays refused with a safe shape`, async t => {
    const f = fixture(t), settings = validateBedrockSettings(f.settings), path = join(f.root, 'settings.json');
    writeFileSync(path, JSON.stringify(f.settings), { mode: 0o600 });
    const response = use('bedrock_ping');
    response.output.message.content.find(block => block.toolUse).toolUse.type = type;
    let dispatches = 0;
    const sdk = createBedrockSender(settings, { credentials: { accessKeyId: 'SYNTHETIC', secretAccessKey: 'synthetic-secret' },
      requestHandler: { async handle() {
        dispatches++;
        return { response: { statusCode: 200, headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify(response)) } };
      }, destroy() {} } });
    t.after(() => sdk.close());
    const directory = join(f.root, 'smoke');
    await assert.rejects(runBedrockSmoke(path, directory, { send: sdk.send, authEnv: {} }), /MODEL_RESPONSE_INVALID/);
    const text = readFileSync(join(directory, 'model-tool-trace.jsonl'), 'utf8');
    const diagnostic = text.trim().split('\n').map(JSON.parse).find(row => row.event === 'response_invalid').diagnostic;
    assert.equal(diagnostic.typeClass, type === 'synthetic-sensitive-type' ? 'other' : type);
    assert.equal(diagnostic.own.type, true);
    assert.equal(diagnostic.unknownOwnKeyCount, 0);
    assert.equal(text.includes('synthetic-sensitive-'), false);
    assert.equal(dispatches, 1);
    assert.equal(senderAttempts(f), 1);
    assert.deepEqual(f.calls, []);
  });
}

test('safe protocol smoke shares the durable budget and never connects to payment MCP', async t => {
  const f = fixture(t), settingsPath = join(f.root, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify(f.settings), { mode: 0o600 });
  const sender = model([use('bedrock_ping'), { stopReason: 'end_turn', output: { message: { role: 'assistant', content: [{ text: 'BEDROCK_OK' }] } } }]);
  const result = await runBedrockSmoke(settingsPath, join(f.root, 'smoke'), { send: sender.send, authEnv: {} });
  assert.equal(result.attempts, 2);
  assert.equal(result.inference, 'injected');
  assert.deepEqual(f.effects, { hold: 0, capture: 0 });
  const buyer = model(); await runBedrockBuyer(f.configPath, f.options(buyer));
  assert.equal(readFileSync(f.settings.admissionPath, 'utf8').split('\n').filter(line => line.includes('"event":"attempt"')).length, 7);
});
