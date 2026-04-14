import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  PatchAuthorExperiment,
  extractAffectedFiles,
  listTier2Prefixes,
  collectFindingIdsAlreadyPatched,
  type PatchCandidate,
} from '../experiments/patch-author.js';
import {
  _setPathTierRegistryForTests,
  type PathTierEntry,
} from '../path-trust-tiers.js';
import type { ExperimentContext } from '../experiment-types.js';

interface FakeRow {
  id: string;
  experiment_id: string;
  subject: string | null;
  verdict: string;
  ran_at: string;
  evidence: unknown;
}

function fakeCtx(rows: FakeRow[]): ExperimentContext {
  return {
    db: {
      from: () => ({
        select: () => ({
          gte: () => ({
            limit: async () => ({ data: rows, error: null }),
          }),
        }),
      }),
    } as unknown as ExperimentContext['db'],
    workspaceId: 'test',
    engine: {} as ExperimentContext['engine'],
    recentFindings: async () => [],
  };
}

describe('extractAffectedFiles', () => {
  it('returns empty for missing or malformed evidence', () => {
    expect(extractAffectedFiles(null)).toEqual([]);
    expect(extractAffectedFiles({})).toEqual([]);
    expect(extractAffectedFiles({ affected_files: 'not-an-array' })).toEqual([]);
    expect(extractAffectedFiles({ affected_files: [1, 2, 3] })).toEqual([]);
  });

  it('normalizes valid file paths', () => {
    expect(
      extractAffectedFiles({ affected_files: ['src/lib/x.ts', 'src/y/../y/z.ts'] }),
    ).toEqual(['src/lib/x.ts', 'src/y/z.ts']);
  });
});

describe('listTier2Prefixes', () => {
  afterEach(() => _setPathTierRegistryForTests(null));

  it('returns only the tier-2 entries from the registry', () => {
    const entries: PathTierEntry[] = [
      { prefix: 'src/a/', tier: 'tier-1', rationale: 'r1' },
      { prefix: 'src/b/x.ts', tier: 'tier-2', rationale: 'r2' },
      { prefix: 'src/c/', tier: 'tier-1', rationale: 'r3' },
      { prefix: 'src/d/y.ts', tier: 'tier-2', rationale: 'r4' },
    ];
    _setPathTierRegistryForTests(entries);
    expect(listTier2Prefixes().sort()).toEqual(['src/b/x.ts', 'src/d/y.ts']);
  });
});

describe('collectFindingIdsAlreadyPatched', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-author-test-'));
    execSync('git init -q --initial-branch=main', { cwd: dir });
    execSync('git config --local user.email t@t', { cwd: dir });
    execSync('git config --local user.name t', { cwd: dir });
    execSync('git config --local commit.gpgsign false', { cwd: dir });
    fs.writeFileSync(path.join(dir, 'a'), '1');
    execSync('git add a && git commit -q -m seed', { cwd: dir });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns empty when no commits carry the trailer', () => {
    fs.writeFileSync(path.join(dir, 'b'), '1');
    execSync('git add b && git commit -q -m "feat: b"', { cwd: dir });
    expect(collectFindingIdsAlreadyPatched(dir, 60 * 60 * 1000).size).toBe(0);
  });

  it('extracts every Fixes-Finding-Id trailer from in-window commits', () => {
    fs.writeFileSync(path.join(dir, 'b'), '1');
    execSync('git add b', { cwd: dir });
    execSync(
      'git commit -q -F -',
      {
        cwd: dir,
        input: 'feat: b\n\nFixes-Finding-Id: aaaa-1111\n',
      } as { cwd: string; input: string },
    );
    fs.writeFileSync(path.join(dir, 'c'), '1');
    execSync('git add c', { cwd: dir });
    execSync(
      'git commit -q -F -',
      {
        cwd: dir,
        input: 'feat: c\n\nFixes-Finding-Id: bbbb-2222\n',
      } as { cwd: string; input: string },
    );
    const ids = collectFindingIdsAlreadyPatched(dir, 60 * 60 * 1000);
    expect(ids.has('aaaa-1111')).toBe(true);
    expect(ids.has('bbbb-2222')).toBe(true);
    expect(ids.size).toBe(2);
  });
});

describe('PatchAuthorExperiment.probe', () => {
  afterEach(() => _setPathTierRegistryForTests(null));

  function withTier2(...prefixes: string[]): void {
    _setPathTierRegistryForTests(
      prefixes.map((p) => ({ prefix: p, tier: 'tier-2', rationale: 'test' })),
    );
  }

  it('returns no_tier2_paths when registry has no tier-2 entries', async () => {
    _setPathTierRegistryForTests([
      { prefix: 'src/x/', tier: 'tier-1', rationale: 'r' },
    ]);
    const exp = new PatchAuthorExperiment();
    const r = await exp.probe(fakeCtx([]));
    expect(r.evidence).toMatchObject({ reason: 'no_tier2_paths', candidates: [] });
    expect(exp.judge(r, [])).toBe('pass');
  });

  it('skips findings whose verdict is pass', async () => {
    withTier2('src/lib/format-duration.ts');
    const rows: FakeRow[] = [
      {
        id: 'f1',
        experiment_id: 'e1',
        subject: null,
        verdict: 'pass',
        ran_at: new Date().toISOString(),
        evidence: { affected_files: ['src/lib/format-duration.ts'] },
      },
    ];
    const exp = new PatchAuthorExperiment();
    const r = await exp.probe(fakeCtx(rows));
    expect((r.evidence as { candidates: PatchCandidate[] }).candidates).toEqual([]);
  });

  it('skips findings whose affected_files do not intersect tier-2 prefixes', async () => {
    withTier2('src/lib/format-duration.ts');
    const rows: FakeRow[] = [
      {
        id: 'f1',
        experiment_id: 'e1',
        subject: null,
        verdict: 'fail',
        ran_at: new Date().toISOString(),
        evidence: { affected_files: ['src/lib/other.ts'] },
      },
    ];
    const exp = new PatchAuthorExperiment();
    const r = await exp.probe(fakeCtx(rows));
    expect((r.evidence as { candidates: PatchCandidate[] }).candidates).toEqual([]);
  });

  it('surfaces warning|fail findings whose affected_files include a tier-2 path', async () => {
    withTier2('src/lib/format-duration.ts');
    const rows: FakeRow[] = [
      {
        id: 'f1',
        experiment_id: 'fmt-fuzz',
        subject: 'src/lib/format-duration.ts',
        verdict: 'fail',
        ran_at: new Date().toISOString(),
        evidence: {
          affected_files: ['src/lib/format-duration.ts', 'src/lib/other.ts'],
        },
      },
    ];
    const exp = new PatchAuthorExperiment();
    const r = await exp.probe(fakeCtx(rows));
    const candidates = (r.evidence as { candidates: PatchCandidate[] }).candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      findingId: 'f1',
      experimentId: 'fmt-fuzz',
      verdict: 'fail',
      tier2Files: ['src/lib/format-duration.ts'],
    });
    expect(exp.judge(r, [])).toBe('warning');
  });
});
