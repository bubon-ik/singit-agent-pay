#!/usr/bin/env node
import { inspectState } from "../src/inspection.js";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--state-dir") {
  console.error("Usage: inspect-state --state-dir /absolute/private/state-directory (offline, never opens economic admission)");
  process.exitCode = 2;
} else {
  const result = inspectState(args[1]);
  console.log(JSON.stringify(result));
  process.exitCode = result.complete ? 0 : 2;
}
