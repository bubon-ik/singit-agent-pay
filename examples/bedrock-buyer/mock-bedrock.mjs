import { fileURLToPath, pathToFileURL } from 'node:url';
import { mockLlm } from './mock-llm.mjs';
import { readPrivateJson } from './run-config.mjs';

/** Use this checkout's payment service; AWS inference remains explicitly opt-in. */
export function mockBedrock(root, settingsPath) {
  return mockLlm(fileURLToPath(new URL('../..', import.meta.url)), root,
    { provider: 'bedrock', bedrock: readPrivateJson(settingsPath) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = async () => {
    if (process.argv.length !== 4) throw Error('PRIVATE_RUN_AND_BEDROCK_SETTINGS_REQUIRED');
    return mockBedrock(...process.argv.slice(2));
  };
  run().then(() => console.log('Mock transport/accounting checks complete; report review remains pending. All evidence stays private.'))
    .catch(() => { console.error('Bedrock mock run stopped; preserve this run and its original records.'); process.exitCode = 1; });
}
