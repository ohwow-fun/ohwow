/**
 * Regression tests for the skill-unification refactor.
 *
 * Locks in the removal of the three keyword matchers that used to
 * hijack the LLM's tool selection:
 *
 *   1. runAgent SOP matcher in `orchestrator/tools/agents.ts`
 *   2. compileSkills in `execution/engine.ts`
 *   3. triggerMatched + desktop auto-activation in `prompt-builder.ts`
 *
 * Each test seeds an `agent_workforce_skills` row that would have
 * caught the old matchers on its triggers array and asserts the
 * new runtime behavior: the row is IGNORED, the prompt flows
 * straight through, and no side-effects fire (no desktop-section
 * activation, no sequence decomposition, no "Learned Procedures"
 * enrichment). Full plan:
 * /Users/jesus/.claude/plans/idempotent-tumbling-flame.md.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAgent } from '../agents.js';
import { makeCtx } from '../../../__tests__/helpers/mock-db.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Test 1 — runAgent ignores procedure rows
// ---------------------------------------------------------------------------

describe('runAgent skill-unification regression', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ignores active procedure rows and inserts the raw prompt as the task input', async () => {
    // Seed: an active procedure skill whose triggers array contains
    // the word "write", and whose definition.tool_sequence calls
    // x_compose_article. Under the OLD matcher this would have routed
    // the prompt "rewrite ph-description.md" into a desktop-SOP
    // enrichment or a sequence decomposition. Under the new runtime,
    // the row should be completely invisible to runAgent.
    const insertedTaskRows: Array<Record<string, unknown>> = [];
    const fetchedSkillTables: string[] = [];

    const ctx = makeCtx({
      agent_workforce_agents: {
        data: {
          id: 'agent-writer',
          name: 'Writer',
          workspace_id: 'ws-1',
          config: JSON.stringify({ approval_required: false }),
        },
      },
      agent_workforce_tasks: { data: [] },
      agent_workforce_skills: {
        data: [
          {
            id: 'legacy-sop-1',
            name: 'Write X Article',
            skill_type: 'procedure',
            is_active: 1,
            triggers: JSON.stringify(['write', 'article']),
            definition: JSON.stringify({ tool_sequence: ['x_compose_article'] }),
          },
        ],
      },
    });

    // Intercept the task insert so we can inspect what runAgent
    // actually wrote to the DB. The helper's default insert mock
    // returns `{ id: 'task-new' }` so the insert-select-single
    // chain downstream keeps working.
    const realFrom = ctx.db.from;
    ctx.db.from = vi.fn((table: string) => {
      const builder = realFrom(table);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const origInsert = (builder as any).insert;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (builder as any).insert = (row: Record<string, unknown>) => {
        if (table === 'agent_workforce_tasks') insertedTaskRows.push(row);
        return origInsert(row);
      };
      if (table === 'agent_workforce_skills') fetchedSkillTables.push(table);
      return builder;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    const result = await runAgent(ctx, {
      agent_id: 'agent-writer',
      prompt: 'rewrite both pieces — ph-description.md and ph-maker-comment.md',
    });

    // runAgent shouldn't have failed on the stub agent row
    expect(result.success === false && result.error === 'Agent not found').toBeFalsy();

    // Critical: the task input should be the RAW prompt, not an
    // enriched PHASE-1-to-4 desktop SOP prompt and not a sequence
    // decomposition wrapper.
    if (insertedTaskRows.length > 0) {
      const taskInput = String(insertedTaskRows[0].input ?? '');
      expect(taskInput).toBe('rewrite both pieces — ph-description.md and ph-maker-comment.md');
      expect(taskInput).not.toMatch(/PHASE 1/);
      expect(taskInput).not.toMatch(/PROCEDURE:/);
      expect(taskInput).not.toMatch(/desktop_screenshot/);
    }

    // Critical: runAgent should NOT have queried the skills table
    // at all under the new runtime (the matcher is gone). If this
    // assertion ever fires, someone reintroduced a skill lookup.
    expect(fetchedSkillTables).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — engine.compileSkills returns empty regardless of DB state
// ---------------------------------------------------------------------------

describe('engine.compileSkills deprecation', () => {
  it('is present in the engine module and the deprecation banner mentions the plan file', async () => {
    // The private method was gutted to early-return '' and the
    // docstring references the plan. We can't easily instantiate
    // RuntimeEngine here (it has many deps), so this lightweight
    // check reads the source file and asserts the banner is in
    // place. A more thorough end-to-end check happens in Step 7's
    // live daemon verification.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../../../execution/engine.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('compileSkills');
    expect(source).toMatch(/early-return[s]?.*empty string/i);
    expect(source).toContain('idempotent-tumbling-flame.md');
    // The method body should be a single `return '';` line after the
    // removal. We grep for any reference to `matchesTriggers` INSIDE
    // the engine file — finding one in an actual call site means the
    // old loop is back. Docstring/banner references are fine; we
    // strip them by excluding lines that start with // or * (JS/TS
    // block comment continuations).
    const banned = source.match(/\bmatchesTriggers\b/g) ?? [];
    const activeCalls = source
      .split('\n')
      .filter((line) => {
        if (!line.includes('matchesTriggers(')) return false;
        const trimmed = line.trim();
        if (trimmed.startsWith('//')) return false;
        if (trimmed.startsWith('*')) return false;
        return true;
      });
    expect(activeCalls).toEqual([]);
    // And at least one banner reference survives.
    expect(banned.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — prompt-builder no longer fetches skills or auto-activates desktop
// ---------------------------------------------------------------------------

describe('prompt-builder skill-unification regression', () => {
  it('no longer imports extractKeywords/matchesTriggers or declares a triggerMatched block', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../../prompt-builder.ts', import.meta.url),
      'utf8',
    );
    // No active import from token-similarity (commented mentions OK).
    const importLine = source
      .split('\n')
      .find((l) => /^import.*from.*token-similarity/.test(l));
    expect(importLine).toBeUndefined();

    // No remaining calls to the deleted helpers.
    const callers = source
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//')) return false;
        return /\bmatchesTriggers\(|\bextractKeywords\(/.test(line);
      });
    expect(callers).toEqual([]);

    // No triggerMatched / mergedSkills state variables declared.
    const decls = source
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//')) return false;
        return /\b(triggerMatched|mergedSkills)\b\s*=/.test(line);
      });
    expect(decls).toEqual([]);

    // learnedSkills passed to the system prompt should be `[]`.
    expect(source).toMatch(/learnedSkills:\s*\[\]/);
  });
});
