#!/usr/bin/env node
import { reviewLegacyJournal } from "../src/legacy-disposition.js";
import { JournalError } from "../src/journal.js";

const [mode, flag, dir, reviewFlag, file, ...extra] = process.argv.slice(2);
if (!["--check", "--apply"].includes(mode) || flag !== "--state-dir" || reviewFlag !== "--review" || !dir || !file || extra.length) {
  console.error("Usage: review-legacy --check|--apply --state-dir /private/state --review /private/review.json");
  process.exitCode = 2;
} else {
  try { console.log(JSON.stringify(await reviewLegacyJournal(dir, file, mode === "--apply"))); }
  catch (error) {
    console.error(error instanceof JournalError ? error.code : "LEGACY_DISPOSITION_REFUSED");
    process.exitCode = 2;
  }
}
