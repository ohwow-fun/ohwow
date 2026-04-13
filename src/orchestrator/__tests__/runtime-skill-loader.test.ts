import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RuntimeSkillLoader } from '../runtime-skill-loader.js';
import { runtimeToolRegistry } from '../runtime-tool-registry.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { makeCtx } from '../../__tests__/helpers/mock-db.js';

/**
 * Minimal chainable mock for the single query the loader issues:
 *
 *   db.from('agent_workforce_skills')
 *     .select(...)
 *     .eq(...).eq(...).eq(...).eq(...)
 *     .limit(1)
 *
 * We return a promise-like from .limit() so the awaited call resolves
 * with the matching row. The full `DatabaseAdapter` surface is huge
 * (insert/update/delete/rpc/range/order etc.), so we widen to it once
 * at the factory boundary via a single `as unknown as DatabaseAdapter`
 * cast — every in-file reference stays typed as the narrower shape.
 */
interface LoaderSkillRow {
  id: string;
  promoted_at: string | null;
  script_path: string;
}

type LoaderDbChain = {
  select: () => LoaderDbChain;
  eq: (col: string, val: unknown) => LoaderDbChain;
  limit: (n: number) => Promise<{ data: LoaderSkillRow[]; error: null }>;
};

function makeDbWithSkills(rows: LoaderSkillRow[]): DatabaseAdapter {
  const makeChain = (table: string): LoaderDbChain => {
    const filters: Record<string, unknown> = {};
    const chain: LoaderDbChain = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      },
      limit: () => {
        if (table !== 'agent_workforce_skills') {
          return Promise.resolve({ data: [], error: null });
        }
        const match = rows.find((r) => r.script_path === filters.script_path);
        return Promise.resolve({ data: match ? [match] : [], error: null });
      },
    };
    return chain;
  };
  const mock = {
    from: (table: string): { select: () => LoaderDbChain } => ({
      select: () => makeChain(table),
    }),
  };
  return mock as unknown as DatabaseAdapter;
}

const VALID_SKILL_TS = `
export const definition = {
  name: 'unit_test_echo',
  description: 'echoes input back',
  input_schema: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
  },
};

export async function handler(_ctx: unknown, input: { message: string }) {
  return { success: true, data: { echoed: input.message } };
}
`;

const FORBIDDEN_SKILL_TS = `
import { spawn } from 'child_process';
export const definition = {
  name: 'evil_skill',
  description: 'should be rejected',
  input_schema: { type: 'object', properties: {}, required: [] },
};
export async function handler() {
  spawn('echo', ['hi']);
  return { success: true };
}
`;

const INVALID_SHAPE_TS = `
export const definition = {
  name: 'bad_shape',
  description: 'no handler exported',
  input_schema: { type: 'object', properties: {}, required: [] },
};
// no handler export
`;

describe('RuntimeSkillLoader', () => {
  let dir: string;
  let skillsDir: string;
  let compiledDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ohwow-skill-loader-'));
    skillsDir = join(dir, 'skills');
    compiledDir = join(skillsDir, '.compiled');
    await mkdir(skillsDir, { recursive: true });
    runtimeToolRegistry._clear();
  });

  afterEach(async () => {
    runtimeToolRegistry._clear();
    await rm(dir, { recursive: true, force: true });
  });

  it('compiles, validates, and registers a valid skill on loadFile', async () => {
    const tsPath = join(skillsDir, 'echo.ts');
    await writeFile(tsPath, VALID_SKILL_TS);

    const db = makeDbWithSkills([
      { id: 'sk-echo', promoted_at: null, script_path: tsPath },
    ]);
    const loader = new RuntimeSkillLoader({ skillsDir, compiledDir, db, workspaceId: 'ws-1' });
    await loader.loadFile(tsPath);

    const def = runtimeToolRegistry.get('unit_test_echo');
    expect(def).toBeDefined();
    expect(def?.skillId).toBe('sk-echo');
    expect(def?.probation).toBe(true); // null promoted_at → probation
    expect(def?.description).toBe('echoes input back');

    // Handler is runnable. Use the shared makeCtx() helper so we
    // hand the handler a real LocalToolContext-shaped value rather
    // than a blind `{} as any` cast.
    const result = await def!.handler(makeCtx(), { message: 'hello' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ echoed: 'hello' });
  });

  it('marks probation=false when promoted_at is set', async () => {
    const tsPath = join(skillsDir, 'echo.ts');
    await writeFile(tsPath, VALID_SKILL_TS);
    const db = makeDbWithSkills([
      { id: 'sk-echo', promoted_at: '2026-04-13T20:00:00Z', script_path: tsPath },
    ]);
    const loader = new RuntimeSkillLoader({ skillsDir, compiledDir, db, workspaceId: 'ws-1' });
    await loader.loadFile(tsPath);
    expect(runtimeToolRegistry.get('unit_test_echo')?.probation).toBe(false);
  });

  it('rejects a skill that imports child_process (forbidden source lint)', async () => {
    const tsPath = join(skillsDir, 'evil.ts');
    await writeFile(tsPath, FORBIDDEN_SKILL_TS);
    const db = makeDbWithSkills([
      { id: 'sk-evil', promoted_at: null, script_path: tsPath },
    ]);
    const loader = new RuntimeSkillLoader({ skillsDir, compiledDir, db, workspaceId: 'ws-1' });
    await loader.loadFile(tsPath);
    expect(runtimeToolRegistry.get('evil_skill')).toBeUndefined();
  });

  it('rejects a skill that does not export a handler', async () => {
    const tsPath = join(skillsDir, 'bad.ts');
    await writeFile(tsPath, INVALID_SHAPE_TS);
    const db = makeDbWithSkills([
      { id: 'sk-bad', promoted_at: null, script_path: tsPath },
    ]);
    const loader = new RuntimeSkillLoader({ skillsDir, compiledDir, db, workspaceId: 'ws-1' });
    await loader.loadFile(tsPath);
    expect(runtimeToolRegistry.get('bad_shape')).toBeUndefined();
  });

  it('skips a skill with no backing agent_workforce_skills row', async () => {
    const tsPath = join(skillsDir, 'orphan.ts');
    await writeFile(tsPath, VALID_SKILL_TS);
    const db = makeDbWithSkills([]);
    const loader = new RuntimeSkillLoader({ skillsDir, compiledDir, db, workspaceId: 'ws-1' });
    await loader.loadFile(tsPath);
    expect(runtimeToolRegistry.get('unit_test_echo')).toBeUndefined();
  });

  it('hot-reloads when the file changes', async () => {
    const tsPath = join(skillsDir, 'echo.ts');
    await writeFile(tsPath, VALID_SKILL_TS);
    const db = makeDbWithSkills([
      { id: 'sk-echo', promoted_at: null, script_path: tsPath },
    ]);
    const loader = new RuntimeSkillLoader({ skillsDir, compiledDir, db, workspaceId: 'ws-1' });
    await loader.loadFile(tsPath);
    expect(runtimeToolRegistry.get('unit_test_echo')?.description).toBe('echoes input back');

    // Bump the description and reload.
    const v2 = VALID_SKILL_TS.replace('echoes input back', 'echoes input back (v2)');
    await writeFile(tsPath, v2);
    await loader.loadFile(tsPath);
    expect(runtimeToolRegistry.get('unit_test_echo')?.description).toBe('echoes input back (v2)');
  });

  it('loadAll picks up existing files on start', async () => {
    const tsPath = join(skillsDir, 'echo.ts');
    await writeFile(tsPath, VALID_SKILL_TS);
    const db = makeDbWithSkills([
      { id: 'sk-echo', promoted_at: '2026-04-13T00:00:00Z', script_path: tsPath },
    ]);
    const loader = new RuntimeSkillLoader({ skillsDir, compiledDir, db, workspaceId: 'ws-1' });
    await loader.start();
    try {
      expect(runtimeToolRegistry.get('unit_test_echo')?.skillId).toBe('sk-echo');
    } finally {
      loader.stop();
    }
  });

  it('unregisters when the source file is removed', async () => {
    const tsPath = join(skillsDir, 'echo.ts');
    await writeFile(tsPath, VALID_SKILL_TS);
    const db = makeDbWithSkills([
      { id: 'sk-echo', promoted_at: null, script_path: tsPath },
    ]);
    const loader = new RuntimeSkillLoader({ skillsDir, compiledDir, db, workspaceId: 'ws-1' });
    await loader.loadFile(tsPath);
    expect(runtimeToolRegistry.get('unit_test_echo')).toBeDefined();

    await unlink(tsPath);
    runtimeToolRegistry.unregisterByScriptPath(tsPath);
    expect(runtimeToolRegistry.get('unit_test_echo')).toBeUndefined();
  });
});
