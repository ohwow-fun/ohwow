import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  PatchAuthorExperiment,
  extractAffectedFiles,
  evidenceLiteralsAppearInSource,
  extractViolationsForFile,
  listTier2Prefixes,
  collectFindingIdsAlreadyPatched,
  isPatchAuthorEnabled,
  stripCodeFences,
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

describe('extractViolationsForFile', () => {
  it('returns empty for missing violations', () => {
    expect(extractViolationsForFile(null, 'a.tsx')).toEqual([]);
    expect(extractViolationsForFile({}, 'a.tsx')).toEqual([]);
  });

  it('keeps all violations in the target file and dedupes identical literals', () => {
    const ev = {
      violations: [
        { file: 'a.tsx', ruleId: 'no-em-dash', literal: 'Observer — one', message: 'no em-dash' },
        { file: 'a.tsx', ruleId: 'no-em-dash', literal: 'Observer — two' },
        { file: 'a.tsx', ruleId: 'no-em-dash', literal: 'Observer — one' },
        { file: 'b.tsx', ruleId: 'no-em-dash', literal: 'Should not appear' },
      ],
    };
    const out = extractViolationsForFile(ev, 'a.tsx');
    expect(out.map((v) => v.literal)).toEqual(['Observer — one', 'Observer — two']);
    expect(out[0].ruleId).toBe('no-em-dash');
    expect(out[0].message).toBe('no em-dash');
  });

  it('falls back to match when literal missing, and skips short literals', () => {
    const ev = {
      violations: [
        { file: 'a.tsx', match: 'longer match' },
        { file: 'a.tsx', match: '—' },
      ],
    };
    expect(extractViolationsForFile(ev, 'a.tsx').map((v) => v.literal)).toEqual(['longer match']);
  });

  it('accepts violations without a file field (older shapes)', () => {
    const ev = { violations: [{ literal: 'Failed to save' }] };
    expect(extractViolationsForFile(ev, 'a.tsx')).toHaveLength(1);
  });
});

describe('evidenceLiteralsAppearInSource', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-literals-'));
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'src/file.tsx'),
      `const msg = "Observer — every action";\n`,
    );
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns true when evidence has no violations array', () => {
    expect(evidenceLiteralsAppearInSource(tmp, ['src/file.tsx'], {})).toBe(true);
    expect(evidenceLiteralsAppearInSource(tmp, ['src/file.tsx'], null)).toBe(true);
    expect(evidenceLiteralsAppearInSource(tmp, ['src/file.tsx'], { violations: 'x' })).toBe(true);
  });

  it('returns true when a violation literal is present verbatim in source', () => {
    const ev = { violations: [{ literal: 'Observer — every action' }] };
    expect(evidenceLiteralsAppearInSource(tmp, ['src/file.tsx'], ev)).toBe(true);
  });

  it('returns false when all violation literals are absent from source', () => {
    const ev = { violations: [{ literal: 'Chief of Staff — Mario Gonzalez' }] };
    expect(evidenceLiteralsAppearInSource(tmp, ['src/file.tsx'], ev)).toBe(false);
  });

  it('falls back to match field when literal is missing', () => {
    const ev = { violations: [{ match: 'every action' }] };
    expect(evidenceLiteralsAppearInSource(tmp, ['src/file.tsx'], ev)).toBe(true);
  });

  it('ignores violations whose literal/match is too short to be specific', () => {
    const ev = { violations: [{ literal: '—' }] };
    expect(evidenceLiteralsAppearInSource(tmp, ['src/file.tsx'], ev)).toBe(true);
  });

  it('returns true if any listed file matches (OR across files)', () => {
    fs.writeFileSync(path.join(tmp, 'src/other.tsx'), 'nothing relevant\n');
    const ev = { violations: [{ literal: 'Observer — every action' }] };
    expect(
      evidenceLiteralsAppearInSource(tmp, ['src/other.tsx', 'src/file.tsx'], ev),
    ).toBe(true);
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

describe('stripCodeFences', () => {
  it('returns input unchanged when there are no fences', () => {
    expect(stripCodeFences('export const x = 1;')).toBe('export const x = 1;');
  });

  it('strips a single ```typescript fenced block', () => {
    const wrapped = '```typescript\nexport const x = 1;\n```';
    expect(stripCodeFences(wrapped)).toBe('export const x = 1;');
  });

  it('strips a bare ``` fenced block', () => {
    expect(stripCodeFences('```\nfoo\n```')).toBe('foo');
  });

  it('trims surrounding whitespace either way', () => {
    expect(stripCodeFences('  \nexport const x = 1;\n  ')).toBe('export const x = 1;');
  });
});

describe('isPatchAuthorEnabled', () => {
  it('returns false when neither file nor env bypass is set', () => {
    const prior = process.env.OHWOW_PATCH_AUTHOR_TEST_ALLOW;
    delete process.env.OHWOW_PATCH_AUTHOR_TEST_ALLOW;
    try {
      expect(isPatchAuthorEnabled()).toBe(false);
    } finally {
      if (prior !== undefined) process.env.OHWOW_PATCH_AUTHOR_TEST_ALLOW = prior;
    }
  });

  it('returns true when the env bypass is set to 1', () => {
    const prior = process.env.OHWOW_PATCH_AUTHOR_TEST_ALLOW;
    process.env.OHWOW_PATCH_AUTHOR_TEST_ALLOW = '1';
    try {
      expect(isPatchAuthorEnabled()).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.OHWOW_PATCH_AUTHOR_TEST_ALLOW;
      else process.env.OHWOW_PATCH_AUTHOR_TEST_ALLOW = prior;
    }
  });
});

describe('PatchAuthorExperiment.intervene', () => {
  afterEach(() => {
    _setPathTierRegistryForTests(null);
    delete process.env.OHWOW_PATCH_AUTHOR_TEST_ALLOW;
  });

  it('returns null when verdict is pass', async () => {
    const exp = new PatchAuthorExperiment();
    const r = await exp.intervene!(
      'pass',
      { summary: '', evidence: { candidates: [] } },
      fakeCtx([]),
    );
    expect(r).toBeNull();
  });

  it('returns observe-only when the kill switch is closed', async () => {
    _setPathTierRegistryForTests([
      { prefix: 'src/lib/format-duration.ts', tier: 'tier-2', rationale: 't' },
    ]);
    const candidate: PatchCandidate = {
      findingId: 'f1',
      experimentId: 'e1',
      subject: null,
      verdict: 'fail',
      ranAt: new Date().toISOString(),
      tier2Files: ['src/lib/format-duration.ts'],
    };
    const exp = new PatchAuthorExperiment();
    const r = await exp.intervene!(
      'warning',
      {
        summary: '',
        evidence: {
          repo_root: '/tmp/nope',
          tier2_prefixes: ['src/lib/format-duration.ts'],
          findings_scanned: 1,
          candidates: [candidate],
        },
      },
      fakeCtx([]),
    );
    expect(r?.description).toContain('observe-only');
    expect((r?.details as { mode?: string })?.mode).toBe('observe-only');
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
