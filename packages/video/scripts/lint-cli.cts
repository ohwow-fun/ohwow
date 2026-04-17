/**
 * Standalone VideoSpec linter runner. Invoked by the `ohwow video lint` CLI
 * via `npx tsx scripts/lint-cli.cts <spec.json> [--strict]`.
 *
 * Exit codes:
 *   0 — clean (no errors; warnings allowed unless --strict)
 *   1 — lint failed (errors present, or --strict with warnings)
 *   2 — usage / file-read error
 */
import { readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { lintVideoSpec, formatLintResult } from "../src/spec/lint";

const args = process.argv.slice(2);
const positional: string[] = [];
let strict = false;
for (const a of args) {
  if (a === "--strict") strict = true;
  else if (a === "--help" || a === "-h") {
    process.stdout.write("Usage: lint-cli.cts <spec.json> [--strict]\n");
    process.exit(0);
  } else if (a.startsWith("--")) {
    process.stderr.write(`Unknown flag: ${a}\n`);
    process.exit(2);
  } else {
    positional.push(a);
  }
}

const specArg = positional[0];
if (!specArg) {
  process.stderr.write("Usage: lint-cli.cts <spec.json> [--strict]\n");
  process.exit(2);
}

const specPath = isAbsolute(specArg) ? specArg : resolve(process.cwd(), specArg);

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(specPath, "utf8"));
} catch (err) {
  process.stderr.write(`Couldn't read or parse ${specPath}. ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}

const result = lintVideoSpec(raw, { strictParams: strict });
process.stdout.write(formatLintResult(result) + "\n");

if (result.errors.length > 0) process.exit(1);
if (strict && result.warnings.length > 0) process.exit(1);
process.exit(0);
