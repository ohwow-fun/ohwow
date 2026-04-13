import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { parseVisionVerdict, testSynthesizedSkill } from '../synthesis-tester.js';
import { runtimeToolRegistry } from '../../runtime-tool-registry.js';
import type { DatabaseAdapter } from '../../../db/adapter-types.js';
import type { ModelRouter } from '../../../execution/model-router.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// A minimal mock db that:
//   - records update() patches by row id
//   - returns a configurable fail_count on select().eq().maybeSingle()
function makeMockDb(initialFailCount = 0): {
  db: DatabaseAdapter;
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
} {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  let currentFail = initialFailCount;

  const makeChain = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {};
    for (const method of ['select', 'eq', 'neq', 'gt', 'gte', 'in', 'order', 'limit']) {
      chain[method] = vi.fn(() => chain);
    }
    chain.maybeSingle = vi.fn(() => Promise.resolve({ data: { fail_count: currentFail }, error: null }));
    chain.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    chain.then = vi.fn((resolve: (v: unknown) => void) =>
      resolve({ data: [], error: null }),
    );
    return chain;
  };

  const db = {
    from: vi.fn(() => ({
      select: () => makeChain(),
      update: vi.fn((patch: Record<string, unknown>) => ({
        eq: vi.fn((_col: string, id: unknown) => {
          updates.push({ id: String(id), patch });
          if (typeof patch.fail_count === 'number') {
            currentFail = patch.fail_count;
          }
          return Promise.resolve({ data: null, error: null });
        }),
      })),
    })),
  } as unknown as DatabaseAdapter;

  return { db, updates };
}

function registerFakeSkill(options: {
  name?: string;
  skillId?: string;
  handler: (ctx: unknown, input: Record<string, unknown>) => Promise<unknown>;
}) {
  runtimeToolRegistry.register({
    name: options.name ?? 'fake_skill',
    description: 'fake',
    input_schema: { type: 'object', properties: {}, required: [] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: options.handler as any,
    skillId: options.skillId ?? 'sk-fake',
    scriptPath: '/tmp/fake.ts',
    probation: true,
  });
}

describe('parseVisionVerdict', () => {
  it('accepts a bare JSON verdict', () => {
    expect(parseVisionVerdict('{"ok": true, "reason": "looks good"}')).toEqual({
      ok: true,
      reason: 'looks good',
    });
  });

  it('extracts JSON from prose', () => {
    const raw = 'Here is my verdict:\n\n{"ok": false, "reason": "login wall"}\n\nHope that helps.';
    expect(parseVisionVerdict(raw)).toEqual({ ok: false, reason: 'login wall' });
  });

  it('rejects when no JSON object is present', () => {
    expect(parseVisionVerdict('I cannot tell').ok).toBe(false);
  });

  it('rejects when `ok` is not a boolean', () => {
    expect(parseVisionVerdict('{"ok": "yes", "reason": "x"}').ok).toBe(false);
  });

  it('tolerates missing reason', () => {
    const v = parseVisionVerdict('{"ok": true}');
    expect(v.ok).toBe(true);
    expect(v.reason).toBeTruthy();
  });
});

describe('testSynthesizedSkill', () => {
  beforeEach(() => {
    runtimeToolRegistry._clear();
  });
  afterEach(() => {
    runtimeToolRegistry._clear();
  });

  it('returns not_found when the skill is not registered', async () => {
    const { db } = makeMockDb();
    const result = await testSynthesizedSkill({
      db,
      modelRouter: {} as ModelRouter,
      skillName: 'missing_skill',
      testInput: {},
      goal: 'Do the thing',
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('not_found');
  });

  it('promotes a skill that succeeds and passes vision eval', async () => {
    registerFakeSkill({
      name: 'promote_me',
      skillId: 'sk-promote',
      handler: async () => ({
        success: true,
        message: 'dry run ok',
        screenshotBase64: 'a'.repeat(64),
        currentUrl: 'https://example.com/done',
      }),
    });
    const { db, updates } = makeMockDb();
    const result = await testSynthesizedSkill({
      db,
      modelRouter: {} as ModelRouter,
      skillName: 'promote_me',
      testInput: {},
      goal: 'Compose a tweet',
      _visionEvalForTest: async () => ({ ok: true, reason: 'textarea has text' }),
    });

    expect(result.ok).toBe(true);
    expect(result.stage).toBe('promoted');
    expect(result.visionVerdict?.ok).toBe(true);

    // The row was updated with promoted_at set.
    const promoteUpdates = updates.filter((u) => u.patch.promoted_at);
    expect(promoteUpdates).toHaveLength(1);
    expect(promoteUpdates[0].id).toBe('sk-promote');
    expect(typeof promoteUpdates[0].patch.promoted_at).toBe('string');
  });

  it('records a fail_count bump when the handler throws', async () => {
    registerFakeSkill({
      name: 'will_throw',
      skillId: 'sk-throw',
      handler: async () => {
        throw new Error('boom');
      },
    });
    const { db, updates } = makeMockDb(0);
    const result = await testSynthesizedSkill({
      db,
      modelRouter: {} as ModelRouter,
      skillName: 'will_throw',
      testInput: {},
      goal: 'Do the thing',
      _visionEvalForTest: async () => ({ ok: true, reason: 'shouldnt get here' }),
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('handler_error');
    expect(result.message).toMatch(/boom/);
    const bump = updates.find((u) => typeof u.patch.fail_count === 'number');
    expect(bump?.patch.fail_count).toBe(1);
  });

  it('records a fail_count bump when the handler returns success=false', async () => {
    registerFakeSkill({
      name: 'reports_fail',
      skillId: 'sk-fail',
      handler: async () => ({ success: false, message: 'nope' }),
    });
    const { db, updates } = makeMockDb(5);
    const result = await testSynthesizedSkill({
      db,
      modelRouter: {} as ModelRouter,
      skillName: 'reports_fail',
      testInput: {},
      goal: 'Do the thing',
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('handler_error');
    expect(updates.find((u) => typeof u.patch.fail_count === 'number')?.patch.fail_count).toBe(6);
  });

  it('fails when no screenshot is returned', async () => {
    registerFakeSkill({
      name: 'no_shot',
      skillId: 'sk-noshot',
      handler: async () => ({ success: true, message: 'ok' }),
    });
    const { db, updates } = makeMockDb();
    const result = await testSynthesizedSkill({
      db,
      modelRouter: {} as ModelRouter,
      skillName: 'no_shot',
      testInput: {},
      goal: 'Do the thing',
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('no_screenshot');
    expect(updates.find((u) => typeof u.patch.fail_count === 'number')).toBeDefined();
  });

  it('fails when the vision model rejects the screenshot', async () => {
    registerFakeSkill({
      name: 'vision_fail',
      skillId: 'sk-vfail',
      handler: async () => ({
        success: true,
        message: 'dry run ok',
        screenshotBase64: 'b'.repeat(64),
      }),
    });
    const { db, updates } = makeMockDb();
    const result = await testSynthesizedSkill({
      db,
      modelRouter: {} as ModelRouter,
      skillName: 'vision_fail',
      testInput: {},
      goal: 'Compose a tweet',
      _visionEvalForTest: async () => ({ ok: false, reason: 'saw login wall' }),
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('vision_reject');
    expect(result.visionVerdict?.reason).toBe('saw login wall');
    expect(updates.find((u) => typeof u.patch.fail_count === 'number')).toBeDefined();
    // promoted_at must NOT have been set
    expect(updates.find((u) => u.patch.promoted_at)).toBeUndefined();
  });

  it('forces dry_run=true on the handler input even if caller tries to override', async () => {
    let seenInput: Record<string, unknown> | undefined;
    registerFakeSkill({
      name: 'check_dryrun',
      skillId: 'sk-dry',
      handler: async (_ctx, input) => {
        seenInput = input;
        return {
          success: true,
          message: 'ok',
          screenshotBase64: 'c'.repeat(64),
        };
      },
    });
    const { db } = makeMockDb();
    await testSynthesizedSkill({
      db,
      modelRouter: {} as ModelRouter,
      skillName: 'check_dryrun',
      testInput: { text: 'hi', dry_run: false },
      goal: 'Compose a tweet',
      _visionEvalForTest: async () => ({ ok: true, reason: 'ok' }),
    });
    expect(seenInput?.dry_run).toBe(true);
    expect(seenInput?.text).toBe('hi');
  });
});
