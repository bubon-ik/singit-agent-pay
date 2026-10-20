import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startBuyerMcp } from './buyer-mcp.mjs';
import { STEPS, outsideGit, readRunConfig, buyerProcessEnv } from './run-config.mjs';
export { BUYER_ENV, STEPS, readRunConfig } from './run-config.mjs';

const here = fileURLToPath(import.meta.url);

export function codexArguments(configPath, workdir, answerPath, schemaPath) {
  // No credential is put in an argument or prompt. Only the trusted MCP adapter reads the private config.
  const mcp = `{report_buyer={command=${JSON.stringify(process.execPath)},args=${JSON.stringify([here, '--mcp', configPath])},required=true,startup_timeout_sec=30,tool_timeout_sec=180,enabled_tools=${JSON.stringify(STEPS)},default_tools_approval_mode="approve"}}`;
  return ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
    '--json', '--color', 'never', '--cd', workdir, '--output-last-message', answerPath, '--output-schema', schemaPath,
    '-c', 'approval_policy="never"', '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"', '-c', 'agents.enabled=false',
    ...['shell_tool', 'apps', 'plugins', 'memories', 'multi_agent', 'view_image', 'image_generation', 'browser_use',
      'browser_use_external', 'computer_use', 'hooks', 'workspace_dependencies', 'skill_search', 'request_permissions_tool']
      .flatMap(name => ['--disable', name]),
    '-c', 'skills.bundled.enabled=false', '-c', `mcp_servers=${mcp}`, '-'];
}

export function validateModelResult(trace, answer, profile) {
  const calls = trace.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.type === 'item.completed' && event.item?.type === 'mcp_tool_call').map(event => event.item);
  if (calls.length !== STEPS.length || calls.some((call, index) => call.server !== 'report_buyer' ||
      call.tool !== STEPS[index] || call.status !== 'completed' || call.result?.is_error || call.result?.isError ||
      !call.arguments || Object.keys(call.arguments).length)) throw Error('MODEL_TRACE_INCOMPLETE_PRESERVE_ORIGINALS');
  const data = item => item.result?.structured_content ?? item.result?.structuredContent ??
    JSON.parse(item.result?.content?.find(part => part.type === 'text')?.text ?? '{}');
  const purchase = data(calls[2]), received = data(calls[3]);
  if (received.stage !== 'done' || JSON.stringify(purchase) !== JSON.stringify(received) ||
      typeof received.artifact?.utf8 !== 'string' ||
      createHash('sha256').update(received.artifact.utf8).digest('hex') !== received.artifact.sha256 ||
      answer.artifactSha256 !== received.artifact.sha256 || answer.profile !== profile ||
      received.receipt?.profile !== profile || typeof answer.summary !== 'string' || answer.summary.length < 80) {
    throw Error('MODEL_REPORT_INCOMPLETE');
  }
}

export async function runCodexBuyer(configPath) {
  const config = readRunConfig(configPath);
  outsideGit(config.evidenceDir);
  mkdirSync(config.evidenceDir, { recursive: true, mode: 0o700 });
  const info = lstatSync(config.evidenceDir);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw Error('PRIVATE_RUN_REQUIRED');
  const dir = realpathSync(config.evidenceDir); outsideGit(dir);
  const workdir = join(dir, 'model-work'); mkdirSync(workdir, { mode: 0o700 });
  const schemaPath = join(dir, 'answer-schema.json'), answerPath = join(dir, 'answer.json');
  writeFileSync(schemaPath, JSON.stringify({ type: 'object', additionalProperties: false,
    properties: { summary: { type: 'string' }, artifactSha256: { type: 'string' }, profile: { type: 'string', enum: ['mock', 'devnet'] } },
    required: ['summary', 'artifactSha256', 'profile'] }), { flag: 'wx', mode: 0o600 });
  const trace = openSync(join(dir, 'model-tool-trace.jsonl'), 'wx', 0o600);
  const errors = openSync(join(dir, 'model-client.log'), 'wx', 0o600);
  // Reuse the user's existing CLI login; do not inherit API keys, wallets, RPC or role credentials.
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'CODEX_HOME'].filter(key => process.env[key] !== undefined)
    .map(key => [key, process.env[key]]));
  let exitCode;
  try {
    const child = spawn('codex', codexArguments(configPath, workdir, answerPath, schemaPath), { env, stdio: ['pipe', trace, errors] });
    child.stdin.end('Obtain the expense-quality report through report_buyer MCP. First quote_report, then hold_report, then purchase_report, then get_report. Use each step once. The trusted adapter already fixes the human mandate, roles, input, amounts and stable keys. Never create or expand a mandate, change payment identity, use another tool, or retry an uncertain payment. Stop on any refusal. Analyse exact totals, category concentrations and duplicate invoice IDs from the purchased artifact. Return a useful report, its exact digest and the actual profile; mock is not live money.');
    exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  } finally { fsyncSync(trace); fsyncSync(errors); closeSync(trace); closeSync(errors); }
  if (exitCode !== 0 || !existsSync(answerPath)) throw Error('MODEL_RUN_STOPPED_PRESERVE_ORIGINALS');
  const answer = JSON.parse(readFileSync(answerPath, 'utf8'));
  validateModelResult(readFileSync(join(dir, 'model-tool-trace.jsonl'), 'utf8'), answer, config.environment.PAYMENT_PROFILE);
  return { answerPath, tracePath: join(dir, 'model-tool-trace.jsonl') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [first, second] = process.argv.slice(2);
  const run = first === '--mcp' ? async () => {
    const config = readRunConfig(second);
    const env = buyerProcessEnv(config);
    await startBuyerMcp({ env, inputPath: config.inputPath, mandateId: config.mandateId, intent: config.intent });
  } : async () => { await runCodexBuyer(first); console.log('Model run finished; inspect the private answer and tool trace.'); };
  run().catch(() => { console.error('Model buyer stopped; preserve private state and originals.'); process.exitCode = 1; });
}
