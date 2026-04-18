/**
 * file-mirror tests — freezes the per-arc markdown mirror behaviour:
 *   1. golden tree shape: 2 phases x 1 trio x 3 rounds -> exactly 9 files
 *      under <data>/autonomy/arcs/<arc_id>/
 *   2. idempotency: a second mirrorArcToDisk call produces byte-identical
 *      output and leaves no `.tmp` files behind
 *   3. failure path: when the persistence reader throws, mirrorArcToDisk
 *      surfaces the error so the Director's hook can demote it to warn
 *      (see director.test.ts for the hook-level non-fatal contract)
 *
 * The mirror writes under the real ~/.ohwow/workspaces tree because
 * `workspaceLayoutFor` reads `homedir()` at module-load time. We isolate
 * by using a unique random slug per test (e.g. `test_mirror_<random>`)
 * and clean it up in afterEach. We never touch the user's `default`
 * workspace.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { promises as fsp } from 'node:fs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqliteAdapter } from '../../db/sqlite-adapter.js';
import { workspaceLayoutFor } from '../../config.js';
import { mirrorArcToDisk, mirrorPaths } from '../file-mirror.js';
import {
  runArc,
  staticQueuePicker,
  type ArcInput,
  type DirectorIO,
  type PickerOutput,
} from '../director.js';
import type { PulseSnapshot } from '../director-persistence.js';
import { StubExecutor, planContinue, implContinue, qaPassed } from './_stubs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

function setupDb(): {
  rawDb: InstanceType<typeof Database>;
  adapter: ReturnType<typeof createSqliteAdapter>;
} {
  const rawDb = new Database(':memory:');
  rawDb.pragma('foreign_keys = OFF');
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const statements = sql.split(/^-- @statement$/m);
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      try {
        rawDb.exec(trimmed);
      } catch {
        // tolerate idempotent ALTERs / pre-existing tables
      }
    }
  }
  const adapter = createSqliteAdapter(rawDb);
  return { rawDb, adapter };
}

function uniqueSlug(): string {
  return `test_mirror_${randomBytes(6).toString('hex')}`;
}

interface FakeIOOptions {
  pulses?: PulseSnapshot[];
  defaultPulse?: PulseSnapshot;
  runtimeSha?: string | null;
  cloudSha?: string | null;
  tickMs?: number;
  startMs?: number;
}

function makeFakeIO(opts: FakeIOOptions = {}): DirectorIO {
  const pulses = [...(opts.pulses ?? [])];
  const defaultPulse: PulseSnapshot = opts.defaultPulse ?? { ts: 'fake' };
  const tickMs = opts.tickMs ?? 1000;
  let nowMs = opts.startMs ?? Date.UTC(2026, 3, 18, 12, 0, 0);
  return {
    async readPulse() {
      return pulses.length > 0 ? pulses.shift()! : { ...defaultPulse };
    },
    async readRuntimeSha() {
      return opts.runtimeSha === undefined ? 'sha1234' : opts.runtimeSha;
    },
    async readCloudSha() {
      return opts.cloudSha === undefined ? null : opts.cloudSha;
    },
    now() {
      const d = new Date(nowMs);
      nowMs += tickMs;
      return d;
    },
  };
}

function basePicked(over: Partial<PickerOutput> = {}): PickerOutput {
  return {
    phase_id: 'phase_001',
    mode: 'plumbing',
    goal: 'wire the mirror',
    initial_plan_brief: 'plan brief body',
    ...over,
  };
}

function baseArcInput(over: Partial<ArcInput> = {}): ArcInput {
  return {
    workspace_id: 'ws-test',
    thesis: 'land the file mirror',
    mode_of_invocation: 'autonomous',
    ...over,
  };
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function rmRf(p: string): Promise<void> {
  await fsp.rm(p, { recursive: true, force: true });
}

describe('mirrorArcToDisk — golden 9-file shape', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;
  let slug: string;

  beforeEach(() => {
    ({ rawDb, adapter } = setupDb());
    slug = uniqueSlug();
  });
  afterEach(async () => {
    rawDb.close();
    await rmRf(workspaceLayoutFor(slug).dataDir);
  });

  it('writes arc.md + 2 phase mds + 6 round mds for 2 phases x 1 trio x 3 rounds', async () => {
    // Drive a real arc so the DB state is the production shape.
    const io = makeFakeIO();
    const picker = staticQueuePicker([
      basePicked({ phase_id: 'phase_A', mode: 'plumbing' }),
      basePicked({ phase_id: 'phase_B', mode: 'tooling', goal: 'follow-up' }),
    ]);
    const exec = new StubExecutor({
      plan: [planContinue, planContinue],
      impl: [implContinue, implContinue],
      qa: [qaPassed, qaPassed],
    });
    const arc = await runArc(baseArcInput(), picker, exec, adapter, io);
    expect(arc.phases_run).toBe(2);
    expect(arc.reports).toHaveLength(2);

    // Now mirror. The Director hook would have called this if we'd
    // injected an io with mirrorArc; here we call it directly to keep
    // the contract test focused on the writer.
    const result = await mirrorArcToDisk({
      db: adapter,
      workspace_slug: slug,
      arc_id: arc.arc_id,
    });

    const { baseDir, arcMdPath } = mirrorPaths(slug, arc.arc_id);
    expect(arcMdPath).toBe(join(baseDir, 'arc.md'));

    // 9 files: arc.md + 2 phase mds + 6 round mds.
    expect(result.written).toHaveLength(9);

    // Spell out the exact relative paths the spec promises. mode names
    // come from the picker outputs above (plumbing / tooling).
    const expected = [
      'arc.md',
      'phase-01-plumbing.md',
      'phase-01/round-01-plan.md',
      'phase-01/round-02-impl.md',
      'phase-01/round-03-qa.md',
      'phase-02-tooling.md',
      'phase-02/round-01-plan.md',
      'phase-02/round-02-impl.md',
      'phase-02/round-03-qa.md',
    ].sort();
    const actualRel = result.written
      .map((p) => p.slice(baseDir.length + 1))
      .sort();
    expect(actualRel).toEqual(expected);

    // Every promised file actually exists on disk.
    for (const rel of expected) {
      expect(existsSync(join(baseDir, rel))).toBe(true);
    }

    // arc.md links to both phase files by exact filename (the picker's
    // mode strings flow through the renderer).
    const arcMd = readFileSync(arcMdPath, 'utf8');
    expect(arcMd).toContain('./phase-01-plumbing.md');
    expect(arcMd).toContain('./phase-02-tooling.md');
    expect(arcMd).toContain(arc.arc_id);

    // No .tmp leftovers from the atomic-write dance.
    const recurseList = (dir: string): string[] => {
      const out: string[] = [];
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) out.push(...recurseList(full));
        else out.push(full);
      }
      return out;
    };
    const allFiles = recurseList(baseDir);
    expect(allFiles.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('mirrorArcToDisk — idempotency', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;
  let slug: string;

  beforeEach(() => {
    ({ rawDb, adapter } = setupDb());
    slug = uniqueSlug();
  });
  afterEach(async () => {
    rawDb.close();
    await rmRf(workspaceLayoutFor(slug).dataDir);
  });

  it('re-running the mirror over the same arc yields byte-identical files and no .tmp', async () => {
    const io = makeFakeIO();
    const picker = staticQueuePicker([basePicked()]);
    const exec = new StubExecutor({
      plan: [planContinue],
      impl: [implContinue],
      qa: [qaPassed],
    });
    const arc = await runArc(baseArcInput(), picker, exec, adapter, io);

    const first = await mirrorArcToDisk({
      db: adapter,
      workspace_slug: slug,
      arc_id: arc.arc_id,
    });
    const firstHashes = new Map<string, string>();
    for (const p of first.written) {
      firstHashes.set(p, sha256(readFileSync(p)));
    }

    const second = await mirrorArcToDisk({
      db: adapter,
      workspace_slug: slug,
      arc_id: arc.arc_id,
    });
    expect(second.written).toEqual(first.written);
    for (const p of second.written) {
      expect(sha256(readFileSync(p))).toBe(firstHashes.get(p));
    }

    // No .tmp residue under the arc tree after either run.
    const { baseDir } = mirrorPaths(slug, arc.arc_id);
    const recurseList = (dir: string): string[] => {
      const out: string[] = [];
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) out.push(...recurseList(full));
        else out.push(full);
      }
      return out;
    };
    expect(recurseList(baseDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('mirrorArcToDisk — failure path', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;
  let slug: string;

  beforeEach(() => {
    ({ rawDb, adapter } = setupDb());
    slug = uniqueSlug();
  });
  afterEach(async () => {
    rawDb.close();
    await rmRf(workspaceLayoutFor(slug).dataDir);
  });

  it('throws when the arc is missing — surfaced for the Director hook to demote to warn', async () => {
    await expect(
      mirrorArcToDisk({
        db: adapter,
        workspace_slug: slug,
        arc_id: 'arc_does_not_exist',
      }),
    ).rejects.toThrow(/arc not found/);
  });

  it('propagates DB errors so the Director hook can demote them', async () => {
    // Stub the adapter so the very first call (loadArc) fails.
    const explodingAdapter = {
      from() {
        throw new Error('simulated db failure');
      },
    } as unknown as ReturnType<typeof createSqliteAdapter>;

    await expect(
      mirrorArcToDisk({
        db: explodingAdapter,
        workspace_slug: slug,
        arc_id: 'whatever',
      }),
    ).rejects.toThrow(/simulated db failure/);
  });
});
