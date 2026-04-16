import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CodePaperCompareProbeExperiment,
  extractConcepts,
  type CodePaperCompareEvidence,
} from '../experiments/code-paper-compare-probe.js';
import type { ExperimentContext, Finding } from '../experiment-types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  setSelfCommitRepoRoot,
  _resetSelfCommitForTests,
} from '../self-commit.js';

function fakeCtx(rows: Record<string, Array<Record<string, unknown>>>, workspaceSlug = 'default'): ExperimentContext {
  const build = (table: string, filters: Array<{ column: string; op: string; value: unknown }> = []) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = (column: string, value: unknown) => {
      filters.push({ column, op: 'eq', value });
      return chain;
    };
    chain.order = () => chain;
    chain.limit = () => chain;
    chain.then = (resolve: (v: unknown) => void) => {
      let data = rows[table] ?? [];
      for (const f of filters) {
        if (f.op === 'eq') data = data.filter((r) => r[f.column] === f.value);
      }
      return resolve({ data, error: null });
    };
    return chain;
  };
  return {
    db: { from: (table: string) => build(table) } as unknown as ExperimentContext['db'],
    workspaceId: 'ws-test',
    workspaceSlug,
    engine: {} as ExperimentContext['engine'],
    recentFindings: async (): Promise<Finding[]> => [],
  };
}

describe('extractConcepts', () => {
  it('strips stopwords and surfaces concept tokens', () => {
    const tokens = extractConcepts(
      'We propose a contextual bandit approach for exploration; bandit policy explores bandit arms',
      4,
    );
    // 'bandit' dominates by frequency (3x) — guaranteed to appear.
    expect(tokens).toContain('bandit');
    // 'propose' and 'approach' are stopwords — must not appear.
    expect(tokens).not.toContain('propose');
    expect(tokens).not.toContain('approach');
    // At least one of the supporting concept tokens makes the cut.
    const supporting = tokens.filter((t) => ['contextual', 'exploration', 'policy', 'explore', 'arm'].includes(t));
    expect(supporting.length).toBeGreaterThan(0);
  });

  it('folds plural morphology so "bandits" matches code with "bandit"', () => {
    const tokens = extractConcepts('Bandits and policies for exploration bandits', 3);
    // Folded stem "bandit" appears (plural -s stripped); should dominate by frequency.
    expect(tokens).toContain('bandit');
  });

  it('caps output at the requested max', () => {
    const tokens = extractConcepts('alpha beta gamma delta epsilon zeta eta theta iota', 3);
    expect(tokens).toHaveLength(3);
  });

  it('returns empty for all-stopword text', () => {
    const tokens = extractConcepts('the and for with our', 5);
    expect(tokens).toEqual([]);
  });
});

describe('CodePaperCompareProbeExperiment', () => {
  const exp = new CodePaperCompareProbeExperiment();

  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-paper-'));
    execSync('git init -b main', { cwd: tmpRoot, stdio: 'pipe' });
    setSelfCommitRepoRoot(tmpRoot);
  });

  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    _resetSelfCommitForTests();
  });

  it('returns stood-down when no repo root is set', async () => {
    _resetSelfCommitForTests();
    const ctx = fakeCtx({ agent_workforce_knowledge_documents: [] });
    const r = await exp.probe(ctx);
    const ev = r.evidence as CodePaperCompareEvidence;
    expect(ev.repo_root).toBeNull();
    expect(ev.papers_scanned).toBe(0);
    expect(exp.judge(r, [])).toBe('pass');
  });

  it('full gap — all concepts absent from repo — yields gap_ratio=1', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'unrelated.ts'), 'export const pineapple = 42;\n');
    const ctx = fakeCtx({
      agent_workforce_knowledge_documents: [
        {
          workspace_id: 'ws-test',
          source_type: 'arxiv',
          title: 'Self-Supervised Online Reward Shaping in Sparse-Reward Environments',
          compiled_text:
            'We introduce SORS: a novel reward-shaping algorithm for sparse-reward environments using online self-supervised reinforcement learning signals.',
          source_url: 'https://arxiv.org/abs/2103.04529v3',
        },
      ],
    });
    const r = await exp.probe(ctx);
    const ev = r.evidence as CodePaperCompareEvidence;
    expect(ev.papers_scanned).toBe(1);
    expect(ev.entries).toHaveLength(1);
    expect(ev.entries[0].concepts.length).toBeGreaterThan(0);
    expect(ev.entries[0].gap_concepts.length).toBe(ev.entries[0].concepts.length);
    expect(ev.entries[0].gap_ratio).toBe(1);
    expect(exp.judge(r, [])).toBe('pass');
  });

  it('partial match — at least one concept present in repo — gap_ratio < 1', async () => {
    fs.writeFileSync(
      path.join(tmpRoot, 'reward.ts'),
      'export const rewardShaping = (x: number) => x * 2;\n',
    );
    const ctx = fakeCtx({
      agent_workforce_knowledge_documents: [
        {
          workspace_id: 'ws-test',
          source_type: 'arxiv',
          title: 'Reward Shaping via Diffusion',
          compiled_text: 'A reward-shaping diffusion approach for reinforcement learning agents.',
          source_url: 'https://arxiv.org/abs/x',
        },
      ],
    });
    const r = await exp.probe(ctx);
    const ev = r.evidence as CodePaperCompareEvidence;
    const hits = Object.values(ev.entries[0].hit_counts);
    expect(hits.some((h) => h > 0)).toBe(true);
    expect(ev.entries[0].gap_ratio).toBeLessThan(1);
  });
});
