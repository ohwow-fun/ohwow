import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildPatternCandidate,
  hashToolSequence,
  synthesizeSkills,
} from '../skill-synthesizer.js';
import type { MinedPattern } from '../types.js';
import type {
  PatternSynthesisCandidate,
  SynthesisCandidateAny,
} from '../../../scheduling/synthesis-failure-detector.js';
import {
  isPatternCandidate,
} from '../../../scheduling/synthesis-failure-detector.js';
import { generateCodeSkillFromPattern } from '../../../orchestrator/tools/synthesis-pattern-generator.js';
import { mockDb } from '../../../__tests__/helpers/mock-db.js';
import type { DatabaseAdapter } from '../../../db/adapter-types.js';
import type { ModelRouter } from '../../../execution/model-router.js';

function pattern(tools: string[], support = 3, successRate = 0.9): MinedPattern {
  return {
    toolSequence: tools,
    support,
    sourceTaskIds: Array.from({ length: support }, (_, i) => `task-${i}`),
    avgSuccessRate: successRate,
  };
}

const NOOP_ROUTER = {} as ModelRouter;

describe('hashToolSequence', () => {
  it('produces a stable 12-char hex id for a given sequence', () => {
    const a = hashToolSequence(['browser_navigate', 'browser_click', 'browser_type']);
    const b = hashToolSequence(['browser_navigate', 'browser_click', 'browser_type']);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it('produces different ids for different sequences', () => {
    const a = hashToolSequence(['x_compose_tweet']);
    const b = hashToolSequence(['x_compose_article']);
    expect(a).not.toBe(b);
  });

  it('distinguishes order — [a,b] and [b,a] are different patterns', () => {
    const a = hashToolSequence(['a', 'b']);
    const b = hashToolSequence(['b', 'a']);
    expect(a).not.toBe(b);
  });
});

describe('buildPatternCandidate', () => {
  it('maps every MinedPattern field onto the bus payload', () => {
    const p = pattern(['navigate', 'click', 'type'], 4, 0.75);
    const c = buildPatternCandidate(p, 'agent-x');
    expect(c.kind).toBe('pattern');
    expect(c.toolSequence).toEqual(['navigate', 'click', 'type']);
    expect(c.support).toBe(4);
    expect(c.avgSuccessRate).toBe(0.75);
    expect(c.sourceTaskIds).toEqual(['task-0', 'task-1', 'task-2', 'task-3']);
    expect(c.agentId).toBe('agent-x');
    expect(c.patternId).toMatch(/^[0-9a-f]{12}$/);
    expect(() => new Date(c.createdAt)).not.toThrow();
  });
});

describe('synthesizeSkills — pattern bridge', () => {
  const originalFlag = process.env.OHWOW_ENABLE_SYNTHESIS;

  beforeEach(() => {
    process.env.OHWOW_ENABLE_SYNTHESIS = '1';
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.OHWOW_ENABLE_SYNTHESIS;
    } else {
      process.env.OHWOW_ENABLE_SYNTHESIS = originalFlag;
    }
  });

  it('emits one synthesis:candidate event per mined pattern', async () => {
    const bus = new EventEmitter();
    const received: SynthesisCandidateAny[] = [];
    bus.on('synthesis:candidate', (c: SynthesisCandidateAny) => received.push(c));

    const patterns = [
      pattern(['browser_navigate', 'browser_click']),
      pattern(['browser_snapshot', 'browser_type', 'browser_click']),
    ];

    const db = mockDb() as unknown as DatabaseAdapter;
    const result = await synthesizeSkills(db, NOOP_ROUTER, 'ws-1', 'agent-1', patterns, { bus });

    expect(received).toHaveLength(2);
    expect(received.every(isPatternCandidate)).toBe(true);
    expect(received[0].kind).toBe('pattern');
    expect((received[0] as PatternSynthesisCandidate).toolSequence).toEqual([
      'browser_navigate',
      'browser_click',
    ]);
    expect(result.patternsFound).toBe(2);
    expect(result.skillsCreated).toBe(0);
    expect(result.tracesAnalyzed).toBe(6);
  });

  it('stays dormant when no bus is provided (pre-phase-C callers still work)', async () => {
    const patterns = [pattern(['navigate', 'click'])];
    const db = mockDb() as unknown as DatabaseAdapter;
    const result = await synthesizeSkills(db, NOOP_ROUTER, 'ws-1', 'agent-1', patterns);
    expect(result.patternsFound).toBe(1);
    expect(result.skillsCreated).toBe(0);
  });

  it('stays dormant when OHWOW_ENABLE_SYNTHESIS is unset, even with a bus', async () => {
    delete process.env.OHWOW_ENABLE_SYNTHESIS;
    const bus = new EventEmitter();
    const received: SynthesisCandidateAny[] = [];
    bus.on('synthesis:candidate', (c) => received.push(c));

    const patterns = [pattern(['navigate', 'click'])];
    const db = mockDb() as unknown as DatabaseAdapter;
    await synthesizeSkills(db, NOOP_ROUTER, 'ws-1', 'agent-1', patterns, { bus });
    expect(received).toHaveLength(0);
  });
});

describe('generateCodeSkillFromPattern', () => {
  it('inserts a code-skill row with the tool sequence in definition on first encounter', async () => {
    const insertSpy = vi.fn();
    const db = mockDb() as unknown as DatabaseAdapter;
    // Override the from() implementation to intercept inserts to
    // agent_workforce_skills and surface the inserted payload so the
    // assertions can check the shape.
    const originalFrom = db.from.bind(db);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).from = (table: string) => {
      const chain = originalFrom(table);
      if (table === 'agent_workforce_skills') {
        // Default mock returns empty array for select — pattern not
        // found, so generator should insert.
        const originalInsert = chain.insert;
        chain.insert = vi.fn().mockImplementation((row: Record<string, unknown>) => {
          insertSpy(row);
          return originalInsert(row);
        });
      }
      return chain;
    };

    const candidate = buildPatternCandidate(
      pattern(['browser_navigate', 'browser_click', 'browser_type']),
      'agent-1',
    );

    const result = await generateCodeSkillFromPattern({
      db,
      workspaceId: 'ws-1',
      candidate,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reused).toBeUndefined();
    expect(result.name).toBe(`pattern_${candidate.patternId}`);

    expect(insertSpy).toHaveBeenCalledTimes(1);
    const inserted = insertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.skill_type).toBe('code');
    expect(inserted.source_type).toBe('pattern-mined');
    expect(inserted.workspace_id).toBe('ws-1');
    expect(inserted.is_active).toBe(1);
    expect(inserted.script_path).toBeNull();
    const definition = JSON.parse(inserted.definition as string);
    expect(definition.tool_sequence).toEqual([
      'browser_navigate',
      'browser_click',
      'browser_type',
    ]);
    expect(definition.source).toBe('pattern-mined');
    expect(definition.support).toBe(3);
  });

  it('short-circuits with reused=true when a row with the same name already exists', async () => {
    const existingRow = { id: 'existing-skill', name: 'unused', is_active: 1 };
    const db = mockDb({
      agent_workforce_skills: { data: [existingRow], count: 1 },
    }) as unknown as DatabaseAdapter;

    const candidate = buildPatternCandidate(pattern(['a', 'b']), 'agent-1');
    const result = await generateCodeSkillFromPattern({
      db,
      workspaceId: 'ws-1',
      candidate,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reused).toBe(true);
    expect(result.skillId).toBe('existing-skill');
  });
});
