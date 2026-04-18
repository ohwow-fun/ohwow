import type { ModeLens } from './types.js';

/**
 * Polish lens — distilled from
 * `.claude/skills/be-ohwow/briefs/polish.md`. Polish work almost always
 * lands in the cloud repo (`ohwow.fun/src/app/`); the runtime side is
 * read-only for this lens, which is why `tables` and `mcp_verbs` are
 * empty here.
 */
export const polishLens: ModeLens = {
  mode: 'polish',
  description:
    'Bring one customer-facing screen to its bar: snap before, fix the punch list, freeze the behavior in a Playwright test.',
  plan_brief_preamble: [
    'MODE: polish. Target ONE route. State its bar in one paragraph and attempt the real customer job.',
    'Snap "before" via ohwow.fun/scripts/ux-audit/snap.mjs against the :9222 debug Chrome (founder profile). Never spawn a fresh playwright chromium.',
    'Fix only what this trio can finish in one round each; everything else goes to NEXT ACTION.',
    'Copy rules: no em-dashes, no "Failed to X" (use "Couldn\'t X. Try again?"), no "(s)" pluralization, no "please" in validation.',
    'QA re-snaps "after", verifies the bar visually, and writes a Playwright e2e at ohwow.fun/e2e/<area>.spec.ts (run with --workers=1).',
  ].join('\n'),
  tables: [],
  mcp_verbs: [],
  experiment_families: [
    'dashboard-smoke',
    'dashboard-copy',
    'list-completeness-summary',
    'handler-schema-drift',
  ],
};
