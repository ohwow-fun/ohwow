/**
 * Seed task definitions for the self-evolution system.
 * Each task is a concrete, bounded code improvement.
 */

export const SEED_TASKS = [
  {
    taskId: 'fix-hardcoded-models-ohwow-fun',
    title: 'Replace hardcoded Claude model strings in ohwow.fun with config-driven selection',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow.fun',
    validationCmd: 'npx tsc --noEmit 2>&1 | tail -20',
    description: `
Two files in ohwow.fun hardcode specific Claude model strings that should use the
existing config-driven model selection pattern instead:

1. src/lib/autofix/fix-generator.ts line 57:
   model: 'claude-sonnet-4-20250514'
   This is inside callAnthropic() which makes a raw fetch to the Anthropic API.
   Replace with a constant imported from a shared location (or inline constant
   AUTOFIX_MODEL = process.env.AUTOFIX_MODEL || 'claude-sonnet-4-5' at the top of the file).

2. src/lib/agents/co-evolution/model-tier.ts line 34:
   if (progress < 0.8) return 'claude-sonnet-4-20250514';
   This is the mid-refinement tier in getEvolutionModelTier(). Replace with a
   named constant CO_EVOLUTION_MID_TIER_MODEL = 'claude-sonnet-4-5' at the top
   of that file (the function already uses 'claude-haiku-4-20250414' which is
   similarly hardcoded — leave haiku as-is since that one is intentional breadth
   model selection; only fix the sonnet reference on line 34).

The goal is to make these model strings obvious and easy to update centrally.
Use env-variable fallback pattern: process.env.X || 'model-string' is acceptable.
Do NOT change the existing getSiteBuilderModel() infrastructure — it's already correct.
`,
    acceptanceCriteria: [
      'No hardcoded "claude-sonnet-4-20250514" strings remain in src/',
      'TypeScript typecheck passes (npx tsc --noEmit)',
      'Model references use a named constant or env-variable fallback',
    ],
  },
  {
    taskId: 'add-intel-pipeline-test',
    title: 'Add seen-file dedup utility and Vitest tests for market-intel pipeline',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm test -- --reporter=verbose src/lib/__tests__/seen-file-utils.test.ts 2>&1 | tail -40',
    description: `
      The market-intel pipeline (scripts/intel/market-intel.mjs) has a seen-file dedup
      mechanism but the logic is embedded in the script with no tests.

      Your job is to create TWO new files:

      FILE 1: src/lib/seen-file-utils.ts
      Export these three pure functions:

        import fs from 'node:fs';

        /** Load all IDs already recorded in a JSONL seen-file. Returns an empty Set if the file doesn't exist. */
        export function loadSeen(seenPath: string): Set<string> {
          const seen = new Set<string>();
          if (!fs.existsSync(seenPath)) return seen;
          const lines = fs.readFileSync(seenPath, 'utf8').split('\\n').filter(Boolean);
          for (const line of lines) {
            try { seen.add((JSON.parse(line) as { id: string }).id); } catch {}
          }
          return seen;
        }

        /** Append items to the JSONL seen-file. Each line: {"id":"...","ts":"..."} */
        export function appendSeen(seenPath: string, items: Array<{ id: string }>): void {
          const lines = items.map(item => JSON.stringify({ id: item.id, ts: new Date().toISOString() }));
          if (lines.length === 0) return;
          fs.appendFileSync(seenPath, lines.join('\\n') + '\\n');
        }

        /** Filter out items whose IDs are already in the seen set. */
        export function filterFresh<T extends { id: string }>(items: T[], seen: Set<string>): T[] {
          return items.filter(item => !seen.has(item.id));
        }

      FILE 2: src/lib/__tests__/seen-file-utils.test.ts
      Write at least 5 Vitest test cases. Use a tmp directory for all file I/O.
      Follow this exact pattern (matches the project's existing test style):

        import { describe, it, expect, beforeEach, afterEach } from 'vitest';
        import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
        import { join } from 'node:path';
        import { tmpdir } from 'node:os';
        import { loadSeen, appendSeen, filterFresh } from '../seen-file-utils.js';

        const TMP = join(tmpdir(), \`seen-file-test-\${Date.now()}\`);

        beforeEach(() => mkdirSync(TMP, { recursive: true }));
        afterEach(() => rmSync(TMP, { recursive: true, force: true }));

        describe('loadSeen', () => {
          it('returns empty set when file does not exist', () => { ... });
          it('parses ids from JSONL lines', () => { ... });
          it('skips malformed lines without throwing', () => { ... });
        });

        describe('appendSeen', () => {
          it('creates file and appends JSONL entries', () => { ... });
          it('appends to existing file without overwriting', () => { ... });
          it('does nothing when items array is empty', () => { ... });
        });

        describe('filterFresh', () => {
          it('excludes items already in the seen set', () => { ... });
          it('returns all items when seen set is empty', () => { ... });
        });

      IMPORTANT:
      - Vitest scans src/**. Do NOT put tests anywhere else.
      - Both files must be TypeScript (.ts). No .mjs files.
      - Do NOT import from scripts/ — the utility is standalone.
      - Do NOT modify market-intel.mjs or any existing file.
      - Do NOT modify package.json or vitest.config.ts.
      - After writing both files, run: npm test -- src/lib/__tests__/seen-file-utils.test.ts
        to confirm tests pass before declaring done.
    `,
    acceptanceCriteria: [
      'New file src/lib/seen-file-utils.ts exists and exports loadSeen, appendSeen, filterFresh',
      'New file src/lib/__tests__/seen-file-utils.test.ts exists with at least 5 test cases',
      'All tests pass: npm test -- src/lib/__tests__/seen-file-utils.test.ts',
    ],
  },
  {
    taskId: 'ohwow-fun-add-contact-search-route-test',
    title: 'Add test for ohwow.fun contact search API route',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow.fun',
    validationCmd: 'npm test 2>&1 | tail -20',
    description: `
      ohwow.fun has many API routes with zero test coverage. Add a test for the contacts search
      endpoint. Find the contacts route in src/app/api/ and write a test using Next.js route
      handler testing patterns (or jest/vitest mocks as appropriate for the project's test setup).
      Cover: basic search, filtering by custom_field_key, empty results.
    `,
    acceptanceCriteria: [
      'New test file created',
      'At least 3 test cases',
      'Tests pass',
    ],
  },
];
