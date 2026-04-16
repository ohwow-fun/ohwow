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
  remainingPostPatchLiterals,
  listTier2Prefixes,
  collectFindingIdsAlreadyPatched,
  isPatchAuthorEnabled,
  stripCodeFences,
  buildSalesSignalTrailer,
  buildCrossDomainHypothesis,
  _setPatchAuthorKillSwitchPathForTests,
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
  // Chainable stub: every method except limit() returns a fresh
  // proxy so new query builder methods (e.g. .order()) don't break
  // the chain. Terminal payload depends on the table name — only
  // self_findings returns the seeded rows; other tables (e.g.
  // patches_attempted_log reads from the Phase 3 pre-flight) return
  // empty so they don't accidentally mask candidates.
  const makeHandler = (table: string): ProxyHandler<object> => ({
    get(_t, prop) {
      if (prop === 'limit') {
        return async () => ({
          data: table === 'self_findings' ? rows : [],
          error: null,
        });
      }
      return () => new Proxy({}, makeHandler(table));
    },
  });
  return {
    db: {
      from: (table: string) => new Proxy({}, makeHandler(table)),
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

  it('returns true when evidence has no violations array (permissive)', () => {
    expect(evidenceLiteralsAppearInSource(tmp, ['src/file.tsx'], {})).toBe(true);
    expect(evidenceLiteralsAppearInSource(tmp, ['src/file.tsx'], null)).toBe(true);
    expect(evidenceLiteralsAppearInSource(tmp, ['src/file.tsx'], { violations: 'x' })).toBe(true);
  });

  it('returns false in strict mode when evidence has no literals', () => {
    expect(evidenceLiteralsAppearInSource(tmp, ['src/file.tsx'], {}, true)).toBe(false);
    expect(evidenceLiteralsAppearInSource(tmp, ['src/file.tsx'], null, true)).toBe(false);
    expect(evidenceLiteralsAppearInSource(tmp, ['src/file.tsx'], { violations: [] }, true)).toBe(false);
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

  it('ignores violations whose literal/match is too short to be specific (no ruleId)', () => {
    const ev = { violations: [{ literal: '—' }] };
    expect(evidenceLiteralsAppearInSource(tmp, ['src/file.tsx'], ev)).toBe(true);
  });

  it('accepts short literals when the violation carries a ruleId (deterministic copy-lint)', () => {
    // With ruleId present, `—` (length 1) is a valid freshness check —
    // the copy-lint rule itself identifies the violation, so we just
    // need to confirm the char is still in the source. Without this
    // branch, every source-copy-lint em-dash warning was being filtered
    // out of the patch-author candidate list in strict mode, silently
    // denying the loop its largest fuel stream (3000+ warnings/day).
    const ev = { violations: [{ ruleId: 'no-em-dash', literal: '—' }] };
    // Permissive mode: literal appears in source → true
    expect(evidenceLiteralsAppearInSource(tmp, ['src/file.tsx'], ev)).toBe(true);
    // Strict mode (string-literal tier-2 targets): same result — this
    // is the regression we're guarding against
    expect(evidenceLiteralsAppearInSource(tmp, ['src/file.tsx'], ev, true)).toBe(true);
  });

  it('returns true if any listed file matches (OR across files)', () => {
    fs.writeFileSync(path.join(tmp, 'src/other.tsx'), 'nothing relevant\n');
    const ev = { violations: [{ literal: 'Observer — every action' }] };
    expect(
      evidenceLiteralsAppearInSource(tmp, ['src/other.tsx', 'src/file.tsx'], ev),
    ).toBe(true);
  });
});

describe('remainingPostPatchLiterals', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remaining-literals-'));
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns literals that are still present in the post-commit file', () => {
    fs.writeFileSync(
      path.join(tmp, 'src/file.tsx'),
      `const a = "Failed to load";\nconst b = "fixed copy";\n`,
    );
    const remaining = remainingPostPatchLiterals(tmp, 'src/file.tsx', [
      { literal: 'Failed to load' },
      { literal: 'Please enter a name' },
    ]);
    expect(remaining).toEqual(['Failed to load']);
  });

  it('returns empty when every cited literal was removed', () => {
    fs.writeFileSync(
      path.join(tmp, 'src/file.tsx'),
      `const a = "Couldn't load. Try again?";\n`,
    );
    expect(
      remainingPostPatchLiterals(tmp, 'src/file.tsx', [{ literal: 'Failed to load' }]),
    ).toEqual([]);
  });

  it('dedupes repeated literals and skips literals shorter than 3 chars', () => {
    fs.writeFileSync(path.join(tmp, 'src/file.tsx'), `const a = "xyz";\n`);
    const remaining = remainingPostPatchLiterals(tmp, 'src/file.tsx', [
      { literal: 'xyz' },
      { literal: 'xyz' },
      { literal: '—' },
    ]);
    expect(remaining).toEqual(['xyz']);
  });

  it('returns empty when the target file cannot be read', () => {
    expect(
      remainingPostPatchLiterals(tmp, 'src/missing.tsx', [{ literal: 'anything' }]),
    ).toEqual([]);
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
  afterEach(() => _setPatchAuthorKillSwitchPathForTests(null));

  it('returns true by default (opt-out model — no disabled file)', () => {
    // Point the disabled-file path to a file that does NOT exist.
    _setPatchAuthorKillSwitchPathForTests('/tmp/patch-author-disabled-does-not-exist-' + Math.random());
    expect(isPatchAuthorEnabled()).toBe(true);
  });

  it('returns false when the disabled file exists', () => {
    const disabledFile = path.join(os.tmpdir(), `patch-author-disabled-${Date.now()}`);
    fs.writeFileSync(disabledFile, '');
    _setPatchAuthorKillSwitchPathForTests(disabledFile);
    try {
      expect(isPatchAuthorEnabled()).toBe(false);
    } finally {
      try { fs.unlinkSync(disabledFile); } catch { /* ignore */ }
    }
  });

  it('returns false when OHWOW_PATCH_AUTHOR_TEST_DENY=1', () => {
    process.env.OHWOW_PATCH_AUTHOR_TEST_DENY = '1';
    try {
      expect(isPatchAuthorEnabled()).toBe(false);
    } finally {
      delete process.env.OHWOW_PATCH_AUTHOR_TEST_DENY;
    }
  });
});

describe('PatchAuthorExperiment.intervene', () => {
  afterEach(() => {
    _setPathTierRegistryForTests(null);
    _setPatchAuthorKillSwitchPathForTests(null);
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

  it('returns observe-only when the kill switch is closed (disabled file exists)', async () => {
    // Simulate kill switch closed by pointing disabled-file path at an existing file.
    const disabledFile = path.join(os.tmpdir(), `patch-author-disabled-test-${Date.now()}`);
    fs.writeFileSync(disabledFile, '');
    _setPatchAuthorKillSwitchPathForTests(disabledFile);
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
    try { fs.unlinkSync(disabledFile); } catch { /* ignore */ }
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

describe('buildSalesSignalTrailer', () => {
  it('formats the trailer with experiment, subject, score, and revenue_proximity', () => {
    const candidate: PatchCandidate = {
      findingId: 'f-1',
      experimentId: 'attribution-observer',
      subject: 'attribution:rollup',
      verdict: 'warning',
      ranAt: new Date().toISOString(),
      tier2Files: ['src/self-bench/experiments/attribution-observer.ts'],
    };
    const topPick = {
      findingId: 'f-1',
      score: 4.2,
      breakdown: {
        revenue_proximity: 1,
        evidence_strength: 0.4,
        blast_radius: 0.75,
        recency: 1,
      },
      rationale: ['+3.0 revenue-proximal experiment'],
    };
    const trailer = buildSalesSignalTrailer(candidate, topPick);
    expect(trailer).toContain('experiment=attribution-observer');
    expect(trailer).toContain('subject=attribution:rollup');
    expect(trailer).toContain('score=4.20');
    expect(trailer).toContain('revenue_proximity=1.00');
    expect(trailer).toContain('evidence_strength=0.40');
  });

  it('omits evidence_strength when the breakdown is zero', () => {
    const candidate: PatchCandidate = {
      findingId: 'f-1',
      experimentId: 'outreach-thermostat',
      subject: null,
      verdict: 'warning',
      ranAt: new Date().toISOString(),
      tier2Files: ['src/self-bench/experiments/outreach-thermostat.ts'],
    };
    const topPick = {
      findingId: 'f-1',
      score: 3,
      breakdown: { revenue_proximity: 1, evidence_strength: 0, blast_radius: 0, recency: 0 },
      rationale: [],
    };
    const trailer = buildSalesSignalTrailer(candidate, topPick);
    expect(trailer).not.toContain('evidence_strength');
  });
});

describe('buildCrossDomainHypothesis', () => {
  it('names the attribution metric for the attribution-observer experiment', () => {
    const h = buildCrossDomainHypothesis(
      {
        findingId: 'f-1',
        experimentId: 'attribution-observer',
        subject: 'attribution:rollup',
        verdict: 'warning',
        ranAt: new Date().toISOString(),
        tier2Files: ['src/self-bench/experiments/attribution-observer.ts'],
      },
      'market_signal bucket converts at 0%',
      'summary here',
    );
    expect(h).toMatch(/^When I change src\/self-bench\/experiments\/attribution-observer\.ts, overall_conversion_rate should move because/);
  });

  it('names proposal rejection rate for the outreach-thermostat experiment', () => {
    const h = buildCrossDomainHypothesis(
      {
        findingId: 'f-1',
        experimentId: 'outreach-thermostat',
        subject: null,
        verdict: 'warning',
        ranAt: new Date().toISOString(),
        tier2Files: ['src/self-bench/experiments/outreach-thermostat.ts'],
      },
      null,
      null,
    );
    expect(h).toContain('proposal rejection rate');
  });

  it('falls back to generic metric when no revenue-experiment signal is present', () => {
    const h = buildCrossDomainHypothesis(
      {
        findingId: 'f-1',
        experimentId: 'source-copy-lint',
        subject: 'copy:Agents.tsx',
        verdict: 'warning',
        ranAt: new Date().toISOString(),
        tier2Files: ['src/web/src/pages/Agents.tsx'],
      },
      'em dash in copy',
      'summary',
    );
    expect(h).toMatch(/^When I change src\/web\/src\/pages\/Agents\.tsx, a revenue metric should move/);
  });
});
