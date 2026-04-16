import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  RoadmapObserverExperiment,
  parseKnownGaps,
  type RoadmapObserverEvidence,
} from '../experiments/roadmap-observer.js';
import {
  setSelfCommitRepoRoot,
  _resetSelfCommitForTests,
} from '../self-commit.js';
import {
  _resetRuntimeConfigCacheForTests,
  getRuntimeConfigCacheSnapshot,
} from '../runtime-config.js';
import type {
  ExperimentContext,
  Finding,
} from '../experiment-types.js';

let tempRoot: string;

function initRepo(root: string) {
  execSync('git init -b main', { cwd: root, stdio: 'pipe' });
  execSync('git config user.email "t@t.local"', { cwd: root, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: root, stdio: 'pipe' });
  execSync('git config commit.gpgsign false', { cwd: root, stdio: 'pipe' });
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n');
  execSync('git add seed.txt', { cwd: root, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: root, stdio: 'pipe' });
}

function writeFile(rel: string, body: string) {
  const abs = path.join(tempRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf-8');
}

function makeCtx(): ExperimentContext {
  const inserts: Array<Record<string, unknown>> = [];
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: {
      from: () => {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.delete = () => chain;
        chain.insert = (row: Record<string, unknown>) => {
          inserts.push(row);
          return Promise.resolve({ data: null, error: null });
        };
        chain.then = (resolve: (v: unknown) => void) =>
          resolve({ data: [], error: null });
        return chain;
      },
    } as any,
    workspaceId: 'ws-test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async (_id: string, _limit?: number) => [] as Finding[],
  };
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-obs-'));
  initRepo(tempRoot);
  setSelfCommitRepoRoot(tempRoot);
  _resetRuntimeConfigCacheForTests();
});

afterEach(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  _resetSelfCommitForTests();
  _resetRuntimeConfigCacheForTests();
});

describe('parseKnownGaps', () => {
  it('extracts P0-P4 headings from AUTONOMY_ROADMAP.md', () => {
    writeFile(
      'AUTONOMY_ROADMAP.md',
      [
        '# Autonomy',
        '',
        '## 4. Known Gaps',
        '',
        '### P0 — Loop Convergence is Unobservable',
        'Body of P0.',
        '',
        '### P1 — No Post-Patch Verification',
        'Body of P1.',
        '',
        '### P3 — Deterministic Replay',
        'Body of P3.',
      ].join('\n'),
    );
    const gaps = parseKnownGaps(tempRoot);
    expect(gaps.map((g) => g.priority)).toEqual(['P0', 'P1', 'P3']);
    expect(gaps[0].title).toBe('Loop Convergence is Unobservable');
    // Tokens are lowercased with stopwords stripped.
    expect(gaps[0].tokens).toContain('loop');
    expect(gaps[0].tokens).toContain('convergence');
    expect(gaps[0].tokens).toContain('unobservable');
    expect(gaps[0].tokens).not.toContain('is');
  });

  it('accepts en-dash and plain dash in the heading separator', () => {
    writeFile(
      'AUTONOMY_ROADMAP.md',
      [
        '## 4. Known Gaps',
        '### P0 – En dash variant',
        '### P1 - Plain dash variant',
      ].join('\n'),
    );
    const gaps = parseKnownGaps(tempRoot);
    expect(gaps).toHaveLength(2);
    expect(gaps[0].title).toBe('En dash variant');
    expect(gaps[1].title).toBe('Plain dash variant');
  });

  it('dedupes when the same gap appears in both AUTONOMY_ROADMAP.md and roadmap/gaps.md', () => {
    writeFile(
      'AUTONOMY_ROADMAP.md',
      '## 4. Known Gaps\n### P0 — Shared Gap\n',
    );
    writeFile(
      'roadmap/gaps.md',
      '## Known Gaps\n### P0 — Shared Gap\n',
    );
    const gaps = parseKnownGaps(tempRoot);
    expect(gaps).toHaveLength(1);
  });
});

describe('RoadmapObserverExperiment', () => {
  const exp = new RoadmapObserverExperiment();

  it('scores a gap active when multiple of its tokens match recent commits', async () => {
    writeFile(
      'AUTONOMY_ROADMAP.md',
      [
        '## 4. Known Gaps',
        '### P0 — Migration Schema Regression',
        'Body.',
      ].join('\n'),
    );
    // A commit whose subject names two of the gap's tokens — 'migration'
    // and 'schema' — should flip activity from stale to active.
    fs.writeFileSync(path.join(tempRoot, 'hit.txt'), 'hit\n');
    execSync('git add hit.txt', { cwd: tempRoot, stdio: 'pipe' });
    execSync(
      'git commit -m "fix(self-bench): migration schema regression fix"',
      { cwd: tempRoot, stdio: 'pipe' },
    );

    const ctx = makeCtx();
    const result = await exp.probe(ctx);
    const ev = result.evidence as RoadmapObserverEvidence;
    expect(ev.parsed_gaps).toBe(1);
    expect(ev.gaps[0].activity).toBe('active');
    expect(ev.stale_p0_count).toBe(0);
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('scores a gap stale when no tokens match, and intervene writes roadmap_priorities', async () => {
    writeFile(
      'AUTONOMY_ROADMAP.md',
      [
        '## 4. Known Gaps',
        '### P0 — Browser Testing Observe Only',
        'Body.',
      ].join('\n'),
    );
    // Seed a commit that names none of the P0 tokens.
    fs.writeFileSync(path.join(tempRoot, 'unrelated.txt'), 'ur\n');
    execSync('git add unrelated.txt', { cwd: tempRoot, stdio: 'pipe' });
    execSync('git commit -m "chore: unrelated touch"', { cwd: tempRoot, stdio: 'pipe' });

    const ctx = makeCtx();
    const result = await exp.probe(ctx);
    const ev = result.evidence as RoadmapObserverEvidence;
    expect(ev.gaps[0].activity).toBe('stale');
    expect(ev.stale_p0_count).toBe(1);
    expect(ev.stale_tokens.length).toBeGreaterThan(0);
    expect(exp.judge(result, [])).toBe('warning');

    const intervention = await exp.intervene!('warning', result, ctx);
    expect(intervention).not.toBeNull();
    expect(intervention!.details.config_key).toBe('strategy.roadmap_priorities');

    // Confirm the cache actually carries the tokens now so the ranker
    // would pick them up on its next synchronous getRuntimeConfig call.
    const snap = getRuntimeConfigCacheSnapshot();
    const entry = snap.find((e) => e.key === 'strategy.roadmap_priorities');
    expect(entry).toBeDefined();
    expect(Array.isArray(entry!.value)).toBe(true);
    expect((entry!.value as string[]).length).toBeGreaterThan(0);
  });

  it('returns pass + no intervention when the roadmap has no parseable gaps', async () => {
    writeFile('AUTONOMY_ROADMAP.md', '# nothing\n');
    const ctx = makeCtx();
    const result = await exp.probe(ctx);
    const ev = result.evidence as RoadmapObserverEvidence;
    expect(ev.parsed_gaps).toBe(0);
    expect(exp.judge(result, [])).toBe('pass');
    const intervention = await exp.intervene!('pass', result, ctx);
    expect(intervention).toBeNull();
  });
});
