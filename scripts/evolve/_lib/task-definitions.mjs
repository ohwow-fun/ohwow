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
    title: 'Add Vitest tests for contact field normalizer utilities in ohwow.fun',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow.fun',
    validationCmd: 'npx vitest run src/lib/agents/services/__tests__/contact-normalizers.test.ts 2>&1 | tail -30',
    description: `
      The file src/lib/agents/services/business-metrics.service.ts exports two pure utility
      functions that have zero test coverage: parseContactTags and parseContactCustomFields.
      These are exported at the module level (not class methods) and are 100% pure — no Supabase,
      no Next.js, no I/O needed.

      Your job is to create ONE new test file:

      FILE: src/lib/agents/services/__tests__/contact-normalizers.test.ts

      The test file must import from the service and test both functions.
      Match the existing test style in src/lib/a2a/__tests__/auth.test.ts exactly.

      Here is the EXACT content to write (copy this verbatim, do not deviate):

      ---
      import { describe, it, expect } from 'vitest';
      import {
        parseContactTags,
        parseContactCustomFields,
      } from '../business-metrics.service';

      describe('parseContactTags', () => {
        it('returns empty array for null', () => {
          expect(parseContactTags(null)).toEqual([]);
        });

        it('returns empty array for undefined', () => {
          expect(parseContactTags(undefined)).toEqual([]);
        });

        it('returns array as-is when already an array', () => {
          expect(parseContactTags(['a', 'b'])).toEqual(['a', 'b']);
        });

        it('filters non-string entries from array', () => {
          expect(parseContactTags(['a', 42 as unknown as string, 'b'])).toEqual(['a', 'b']);
        });

        it('parses JSON string to array', () => {
          expect(parseContactTags('["x","y"]')).toEqual(['x', 'y']);
        });

        it('returns empty array for malformed JSON string', () => {
          expect(parseContactTags('not-json')).toEqual([]);
        });

        it('returns empty array for JSON string that is not an array', () => {
          expect(parseContactTags('{"a":1}')).toEqual([]);
        });
      });

      describe('parseContactCustomFields', () => {
        it('returns empty object for null', () => {
          expect(parseContactCustomFields(null)).toEqual({});
        });

        it('returns empty object for undefined', () => {
          expect(parseContactCustomFields(undefined)).toEqual({});
        });

        it('returns object as-is when already an object', () => {
          expect(parseContactCustomFields({ key: 'val' })).toEqual({ key: 'val' });
        });

        it('parses JSON string to object', () => {
          expect(parseContactCustomFields('{"x":1}')).toEqual({ x: 1 });
        });

        it('returns empty object for malformed JSON string', () => {
          expect(parseContactCustomFields('bad-json')).toEqual({});
        });

        it('returns empty object for JSON string that is an array', () => {
          expect(parseContactCustomFields('[1,2]')).toEqual({});
        });
      });
      ---

      IMPORTANT instructions:
      - Create the directory src/lib/agents/services/__tests__/ first with: mkdir -p
      - Write the file using write_file with the exact content above (replacing --- delimiters)
      - The import path does NOT use '.js' extension (vitest resolves TypeScript imports without extension, matching existing test files like src/lib/a2a/__tests__/auth.test.ts)
      - Do NOT modify any existing files
      - Do NOT modify package.json, vitest.config.ts, or any other config
      - After writing the file, run the validation command to confirm tests pass:
        npx vitest run src/lib/agents/services/__tests__/contact-normalizers.test.ts
    `,
    acceptanceCriteria: [
      'New file src/lib/agents/services/__tests__/contact-normalizers.test.ts exists',
      'File imports parseContactTags and parseContactCustomFields from business-metrics.service.js',
      'At least 10 test cases covering both functions',
      'All tests pass: npx vitest run src/lib/agents/services/__tests__/contact-normalizers.test.ts',
    ],
  },

  // -------------------------------------------------------------------------
  // BATCH 2 — added 2026-04-22
  // -------------------------------------------------------------------------

  {
    taskId: 'add-priority-semaphore-tests',
    title: 'Add Vitest tests for PrioritySemaphore (priority queue + timeout)',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm test -- --reporter=verbose src/execution/__tests__/priority-semaphore.test.ts 2>&1 | tail -40',
    description: `
The class PrioritySemaphore in src/execution/priority-semaphore.ts is the core
concurrency gate for the agent execution loop. It has no dedicated tests — the
only semaphore test file covers the simpler base Semaphore class.

Create ONE new file: src/execution/__tests__/priority-semaphore.test.ts

Cover these behaviours with at least 7 Vitest test cases:

1. acquire() immediately resolves when below max concurrency.
2. acquire() queues when at max concurrency.
3. Higher-priority entries are resolved before lower-priority ones
   (queue critical before standard, confirm critical resolves first).
4. release() decrements active count.
5. rejectAll() rejects every waiting entry and returns the count.
6. Timeout: acquire() with timeoutMs rejects if slot not granted in time.
7. getQueueDepths() reflects the waiting counts per priority tier.

Use this import (matches the project's ESM convention):
  import { PrioritySemaphore } from '../priority-semaphore.js';
  import { describe, it, expect, vi, beforeEach } from 'vitest';

Use real timers for the timeout test (no vi.useFakeTimers needed — just keep
timeoutMs small, e.g. 10ms, and await at least that long before asserting rejection).

Do NOT modify priority-semaphore.ts or any other existing file.
Do NOT modify package.json or vitest.config.ts.
    `,
    acceptanceCriteria: [
      'New file src/execution/__tests__/priority-semaphore.test.ts exists',
      'At least 7 test cases covering priority ordering, timeout, and rejectAll',
      'All tests pass: npm test -- src/execution/__tests__/priority-semaphore.test.ts',
      'TypeScript typecheck passes (npm run typecheck)',
    ],
  },

  {
    taskId: 'fix-seed-templates-hardcoded-model',
    title: 'Replace hardcoded claude-sonnet-4-20250514 in seed-templates.ts with a named constant',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm run typecheck 2>&1 | tail -20',
    description: `
src/lib/seed-templates.ts contains 12+ inline occurrences of the string
'claude-sonnet-4-20250514' embedded directly inside agent config objects.
This is a maintenance burden — updating the default seed model requires
a search-and-replace across the whole file.

Fix: at the top of the file (after the existing JSDoc comment) add:

  /** Default LLM model used by seed-template agents. Override via SEED_TEMPLATE_MODEL env var. */
  const SEED_AGENT_MODEL = process.env.SEED_TEMPLATE_MODEL ?? 'claude-sonnet-4-5';

Then replace every occurrence of 'claude-sonnet-4-20250514' in that file
with the constant SEED_AGENT_MODEL. There are occurrences on lines ~24, 40,
56, 72, 88, 104, 120, 136, 152, 168, 188, 189, 209 (check the file for the
exact count — do not leave any behind).

Do NOT touch any other file. Do NOT change the shape of the exported
SEED_TEMPLATES array. Do NOT modify package.json.
    `,
    acceptanceCriteria: [
      'No string literal "claude-sonnet-4-20250514" remains in src/lib/seed-templates.ts',
      'SEED_AGENT_MODEL constant is defined at the top of the file',
      'TypeScript typecheck passes (npm run typecheck)',
      'No other files were changed',
    ],
  },

  {
    taskId: 'add-jsdoc-co-evolution-executor',
    title: 'Add JSDoc to public API surface of co-evolution-executor.ts',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm run typecheck 2>&1 | tail -20',
    description: `
src/orchestrator/co-evolution/co-evolution-executor.ts exposes two public
TypeScript interfaces and one exported async function that are used by the
orchestrator to drive the co-evolution loop. None of them have JSDoc comments.

Add JSDoc to:

1. Interface CoEvolutionProgressEvent (exported) — describe what this union
   type represents: a progress event emitted by the co-evolution loop. Each
   event has a 'type' discriminant field plus optional payload keys.

2. Interface ExecuteLocalCoEvolutionOptions (exported) — describe each
   field: db, engine, workspaceId, config, anthropic (optional, injected
   Anthropic SDK client), modelRouter (optional model routing override),
   onEvent (optional progress event callback).

3. Function executeLocalCoEvolution (exported) — describe the overall flow
   (N agents iterate across R rounds on the same deliverable) and the return
   value (LocalCoEvolutionResult with bestAttempt, score summary, cost, etc.).

Format: standard TSDoc (/** ... */) with @param and @returns tags on the
function. Keep descriptions concise (2-3 sentences each). Do not add
examples or change any logic. Do not touch any other file.
    `,
    acceptanceCriteria: [
      'CoEvolutionProgressEvent has a JSDoc block explaining its purpose',
      'ExecuteLocalCoEvolutionOptions has JSDoc on the interface and each field',
      'executeLocalCoEvolution has JSDoc with @param and @returns',
      'TypeScript typecheck passes (npm run typecheck)',
      'No logic was changed — diff is comments only',
    ],
  },

  {
    taskId: 'ohwow-fun-extract-blog-feed-url-constant',
    title: 'Extract hardcoded https://ohwow.fun URL in blog/feed.xml/route.ts to a named constant',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow.fun',
    validationCmd: 'npx tsc --noEmit 2>&1 | tail -20',
    description: `
src/app/blog/feed.xml/route.ts contains 5+ hardcoded occurrences of the
string 'https://ohwow.fun' embedded in the RSS feed metadata (id, link,
favicon, rss2, and per-article link fields). This is the only file in the
codebase where these strings are NOT read from an env var or a shared
constant.

Fix:
1. At the top of src/app/blog/feed.xml/route.ts, add:
   const SITE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://ohwow.fun';

2. Replace every occurrence of the literal 'https://ohwow.fun' in that file
   with the SITE_URL constant (template literals where needed, e.g.
   \`\${SITE_URL}/blog\`).

3. Do NOT touch src/app/sitemap.ts, src/app/robots.ts, or any other file.
   sitemap.ts already uses its own BASE_URL constant and is out of scope.

The goal is consistency: the feed.xml route should respect the same
NEXT_PUBLIC_APP_URL environment variable that the rest of the app uses.
    `,
    acceptanceCriteria: [
      'No string literal "https://ohwow.fun" remains in src/app/blog/feed.xml/route.ts',
      'SITE_URL constant is defined at the top of the file using process.env.NEXT_PUBLIC_APP_URL',
      'TypeScript typecheck passes (npx tsc --noEmit)',
      'No other files were modified',
    ],
  },

  // -------------------------------------------------------------------------
  // BATCH 4 — added 2026-04-23 showcase
  // -------------------------------------------------------------------------

  {
    taskId: 'add-response-classifier-tests',
    title: 'Add Vitest tests for response-classifier.ts (parseResponseMeta, shouldAutoCreateDeliverable, inferTypeFromContent)',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm test -- --reporter=verbose src/execution/__tests__/response-classifier.test.ts 2>&1 | tail -40',
    description: `
src/execution/response-classifier.ts exports three pure functions with zero test coverage:
parseResponseMeta, shouldAutoCreateDeliverable, and inferTypeFromContent.
These are entirely pure — no DB, no I/O, no mocks required.

Create ONE new file: src/execution/__tests__/response-classifier.test.ts

Cover these behaviours with at least 10 Vitest test cases:

parseResponseMeta:
1. Returns { type: null, cleanContent: original } when no header is present.
2. Returns { type: 'deliverable', cleanContent: stripped } when header has type=deliverable.
3. Returns { type: 'informational', cleanContent: stripped } when header has type=informational.
4. Returns { type: null } when header JSON is malformed.
5. Returns { type: null } when header type is an unknown value.

shouldAutoCreateDeliverable:
6. Returns { create: false } for content shorter than 200 chars.
7. Returns { create: false } for a heartbeat task title even with long content.
8. Returns { create: true } for content >500 chars with at least one structure signal (e.g. a markdown header).
9. Returns { create: true } for very long plain content (>1500 chars) with no structure.
10. Returns { create: true } for 200-500 char content with 2+ structure signals.

inferTypeFromContent:
11. Returns 'code' when content has a fenced code block with a known language.
12. Returns 'report' when title includes 'analysis'.
13. Returns 'document' as the fallback when no pattern matches.

Use this import pattern:
  import { describe, it, expect } from 'vitest';
  import { parseResponseMeta, shouldAutoCreateDeliverable, inferTypeFromContent } from '../response-classifier.js';

Do NOT modify response-classifier.ts or any other existing file.
Do NOT modify package.json or vitest.config.ts.
    `,
    acceptanceCriteria: [
      'New file src/execution/__tests__/response-classifier.test.ts exists',
      'At least 10 test cases covering all 3 exported functions',
      'All tests pass: npm test -- src/execution/__tests__/response-classifier.test.ts',
      'TypeScript typecheck passes (npm run typecheck)',
    ],
  },

  {
    taskId: 'add-model-router-pure-fn-tests',
    title: 'Add Vitest tests for shouldForceLocalForBurn and inferProviderFromModel in model-router.ts',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm test -- --reporter=verbose src/execution/__tests__/model-router-pure.test.ts 2>&1 | tail -40',
    description: `
src/execution/model-router.ts exports two pure standalone functions at the top of the file
that have no dedicated tests:
  - shouldForceLocalForBurn(burnLevel, callerForceLocal): boolean
  - inferProviderFromModel(model): InferredProvider

These are pure — no class instantiation, no network, no DB.

Create ONE new file: src/execution/__tests__/model-router-pure.test.ts

Cover these behaviours with at least 8 Vitest test cases:

shouldForceLocalForBurn:
1. Returns false when burnLevel=0 and callerForceLocal=false.
2. Returns true when callerForceLocal=true regardless of burnLevel.
3. Returns true when burnLevel=1 and callerForceLocal=false.
4. Returns true when burnLevel=2 and callerForceLocal=false.

inferProviderFromModel:
5. Returns 'anthropic' for a model starting with 'claude-'.
6. Returns 'mlx' for a model starting with 'mlx-community/'.
7. Returns 'openrouter' for a model containing '/' but not starting with 'mlx-community/'.
8. Returns 'ollama' for a model containing ':' (e.g. 'llama3:8b').
9. Returns null for an unrecognised model string with no special characters.
10. Returns null for an empty string.

Use this import pattern:
  import { describe, it, expect } from 'vitest';
  import { shouldForceLocalForBurn, inferProviderFromModel } from '../model-router.js';

Do NOT modify model-router.ts or any other existing file.
Do NOT modify package.json or vitest.config.ts.
    `,
    acceptanceCriteria: [
      'New file src/execution/__tests__/model-router-pure.test.ts exists',
      'At least 8 test cases covering both functions',
      'All tests pass: npm test -- src/execution/__tests__/model-router-pure.test.ts',
      'TypeScript typecheck passes (npm run typecheck)',
    ],
  },

  {
    taskId: 'add-savepoint-store-tests',
    title: 'Add Vitest tests for SavepointStore (ring buffer, create, rollbackTo, list)',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm test -- --reporter=verbose src/execution/__tests__/savepoint-store.test.ts 2>&1 | tail -40',
    description: `
src/execution/savepoint-store.ts exports SavepointStore — an in-memory ring-buffer class
with no DB, no network, no I/O. It has zero test coverage despite being a core checkpoint
mechanism in the agent execution loop.

Create ONE new file: src/execution/__tests__/savepoint-store.test.ts

Cover these behaviours with at least 8 Vitest test cases:

1. create() stores a savepoint retrievable via has() and list().
2. rollbackTo() returns a deep copy of the saved data (mutations to result don't affect stored copy).
3. rollbackTo() returns null for an unknown savepoint name.
4. list() returns savepoints in insertion order.
5. Ring buffer: when the store is at maxSavepoints and a new name is added, the oldest is evicted.
6. Overwriting an existing name (same name, new data): size stays the same; list() puts it at the end (re-ordered to back of insertion order); rollbackTo returns the new data.
7. get size property reflects the current count.
8. An empty store has size === 0 and list() returns [].

Use this import:
  import { describe, it, expect } from 'vitest';
  import { SavepointStore } from '../savepoint-store.js';
  import type { SavepointData } from '../savepoint-store.js';

Helper for a minimal SavepointData:
  function makeData(iteration: number): SavepointData {
    return { messages: [], iteration, toolCallHashes: [], totalInputTokens: 0, totalOutputTokens: 0 };
  }

Do NOT modify savepoint-store.ts or any other existing file.
Do NOT modify package.json or vitest.config.ts.
    `,
    acceptanceCriteria: [
      'New file src/execution/__tests__/savepoint-store.test.ts exists',
      'At least 8 test cases covering ring buffer eviction, rollback, and list ordering',
      'All tests pass: npm test -- src/execution/__tests__/savepoint-store.test.ts',
      'TypeScript typecheck passes (npm run typecheck)',
    ],
  },
];
