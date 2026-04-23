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
    title: 'Add integration test for market-intel seen-file dedup behavior',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm test -- --reporter=verbose 2>&1 | tail -30',
    description: `
      The market-intel pipeline at scripts/intel/market-intel.mjs has a seen-file dedup mechanism
      (~/.ohwow/workspaces/default/intel/market-intel-seen.jsonl). There are no tests verifying
      this behavior. Add a Vitest test file at scripts/intel/__tests__/market-intel-dedup.test.ts
      that verifies:
      1. Items already in the seen-file are excluded from fresh[]
      2. DRY=1 mode does NOT write to the seen-file (the bug we fixed)
      3. appendSeen() correctly appends JSONL entries
      Mock the seen-file path using a tmp dir.
    `,
    acceptanceCriteria: [
      'New test file created at scripts/intel/__tests__/market-intel-dedup.test.ts',
      'At least 3 test cases covering dedup logic',
      'All tests pass (npm test)',
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
