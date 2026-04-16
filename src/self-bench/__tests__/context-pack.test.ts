import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildContextPack } from '../context-pack.js';
import {
  _resetRuntimeConfigCacheForTests,
  _seedRuntimeConfigCacheForTests,
} from '../runtime-config.js';

type Row = Record<string, unknown>;

/**
 * Minimal chainable DB stub covering the shapes context-pack sources use:
 *   self_findings: .select.gte.in.order.limit
 *   agent_workforce_goals: .select.eq.eq (terminal await)
 *
 * Each table has its own seed array; unsupported operators fall through
 * (no-op) so the source still gets a plausible result.
 */
function buildDb(seed: {
  self_findings?: Row[];
  agent_workforce_goals?: Row[];
}) {
  const tables: Record<string, Row[]> = {
    self_findings: seed.self_findings ?? [],
    agent_workforce_goals: seed.agent_workforce_goals ?? [],
  };
  function makeBuilder(table: string) {
    const filters: Array<{ col: string; op: 'eq' | 'gte' | 'in'; val: unknown }> = [];
    let limitN: number | null = null;
    let orderCol: string | null = null;
    let orderAsc = true;

    const apply = () => {
      let out = tables[table].filter((row) =>
        filters.every((f) => {
          if (f.op === 'eq') return row[f.col] === f.val;
          if (f.op === 'gte') return String(row[f.col] ?? '') >= String(f.val);
          if (f.op === 'in') return Array.isArray(f.val) && (f.val as unknown[]).includes(row[f.col]);
          return true;
        }),
      );
      if (orderCol) {
        out = [...out].sort((a, b) =>
          orderAsc
            ? String(a[orderCol!] ?? '').localeCompare(String(b[orderCol!] ?? ''))
            : String(b[orderCol!] ?? '').localeCompare(String(a[orderCol!] ?? '')),
        );
      }
      if (limitN !== null) out = out.slice(0, limitN);
      return out;
    };

    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => {
      filters.push({ col, op: 'eq', val });
      return builder;
    };
    builder.gte = (col: string, val: unknown) => {
      filters.push({ col, op: 'gte', val });
      return builder;
    };
    builder.in = (col: string, vals: unknown[]) => {
      filters.push({ col, op: 'in', val: vals });
      return builder;
    };
    builder.order = (col: string, opts: { ascending: boolean }) => {
      orderCol = col;
      orderAsc = opts.ascending;
      return builder;
    };
    builder.limit = (n: number) => {
      limitN = n;
      return Promise.resolve({ data: apply(), error: null });
    };
    builder.then = (resolve: (v: unknown) => void) =>
      resolve({ data: apply(), error: null });
    return builder;
  }

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: { from: vi.fn().mockImplementation((t: string) => makeBuilder(t)) } as any,
    tables,
  };
}

describe('buildContextPack', () => {
  beforeEach(() => {
    _resetRuntimeConfigCacheForTests();
  });

  it('returns an empty pack when every source is absent', async () => {
    const env = buildDb({});
    const pack = await buildContextPack({
      db: env.db,
      workspaceId: 'ws-1',
      repoRoot: null,
      approvalsJsonlPath: null,
    });
    expect(pack.sections).toEqual([]);
    expect(pack.toPromptString()).toBe('');
  });

  it('surfaces recent warning/fail findings with affected files', async () => {
    const now = new Date().toISOString();
    const env = buildDb({
      self_findings: [
        {
          id: 'f1',
          experiment_id: 'source-copy-lint',
          subject: 'copy:Agents.tsx',
          verdict: 'warning',
          summary: 'em dash in Agents.tsx:42',
          ran_at: now,
          evidence: { affected_files: ['src/web/src/pages/Agents.tsx'] },
        },
        {
          id: 'f2',
          experiment_id: 'attribution-observer',
          subject: 'attribution:rollup',
          verdict: 'warning',
          summary: '0/11 qualified→paid in market_signal bucket',
          ran_at: now,
          evidence: { worst_performing_bucket: { bucket: 'market_signal' } },
        },
      ],
    });
    const pack = await buildContextPack({
      db: env.db,
      workspaceId: 'ws-1',
      repoRoot: null,
      approvalsJsonlPath: null,
    });
    const findings = pack.sections.find((s) => s.name === 'recent-findings');
    expect(findings).toBeDefined();
    expect(findings!.body).toContain('[warning] source-copy-lint');
    expect(findings!.body).toContain('Agents.tsx');
    expect(findings!.body).toContain('attribution-observer');
  });

  it('surfaces revenue-gap-focus and attribution-findings from runtime config', async () => {
    _seedRuntimeConfigCacheForTests(
      'strategy.revenue_gap_focus',
      "goal 'MRR' at 120/500 (24% of pace)",
    );
    _seedRuntimeConfigCacheForTests('strategy.revenue_gap_priorities', [
      'x-engagement-observer',
      'revenue-pipeline-observer',
    ]);
    _seedRuntimeConfigCacheForTests('strategy.attribution_findings', {
      verdict: 'warning',
      total_qualified: 11,
      total_paid: 0,
      worst_performing_bucket: { bucket: 'market_signal', conversion_rate: 0 },
    });
    const env = buildDb({});
    const pack = await buildContextPack({
      db: env.db,
      workspaceId: 'ws-1',
      repoRoot: null,
      approvalsJsonlPath: null,
    });
    const gap = pack.sections.find((s) => s.name === 'revenue-gap-focus');
    expect(gap?.body).toContain("goal 'MRR'");
    expect(gap?.body).toContain('x-engagement-observer');
    const attr = pack.sections.find((s) => s.name === 'attribution-findings');
    expect(attr?.body).toContain('"worst_performing_bucket"');
    expect(attr?.body).toContain('market_signal');
  });

  it('renders active goals with progress percentages', async () => {
    const env = buildDb({
      agent_workforce_goals: [
        {
          id: 'g1',
          workspace_id: 'ws-1',
          status: 'active',
          title: 'MRR',
          target_metric: 'mrr_cents',
          target_value: 50000,
          current_value: 12000,
          unit: 'cents',
          due_date: '2026-06-01T00:00:00Z',
        },
      ],
    });
    const pack = await buildContextPack({
      db: env.db,
      workspaceId: 'ws-1',
      repoRoot: null,
      approvalsJsonlPath: null,
    });
    const goals = pack.sections.find((s) => s.name === 'active-goals');
    expect(goals?.body).toContain("'MRR'");
    expect(goals?.body).toContain('12000/50000');
    expect(goals?.body).toContain('(24%)');
    expect(goals?.body).toContain('by 2026-06-01');
  });

  it('parses operator rejections from approvals jsonl with notes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxpack-'));
    const approvals = path.join(tmpDir, 'x-approvals.jsonl');
    const rows = [
      {
        id: 'a1',
        ts: '2026-04-14T00:00:00Z',
        kind: 'x_dm_outbound',
        workspace: 'default',
        summary: 'first-touch dm to @foo',
        payload: {},
        status: 'rejected',
        notes: 'opens with "Hey" — operator said too cold',
        ratedAt: '2026-04-14T01:00:00Z',
      },
      {
        id: 'a2',
        ts: '2026-04-15T00:00:00Z',
        kind: 'x_outbound_reply',
        workspace: 'default',
        summary: 'reply with generic pitch',
        payload: {},
        status: 'rejected',
        notes: 'too salesy, drop the CTA',
        ratedAt: '2026-04-15T01:00:00Z',
      },
    ];
    fs.writeFileSync(approvals, rows.map((r) => JSON.stringify(r)).join('\n'), 'utf-8');

    const env = buildDb({});
    const pack = await buildContextPack({
      db: env.db,
      workspaceId: 'ws-1',
      repoRoot: null,
      approvalsJsonlPath: approvals,
    });
    const rej = pack.sections.find((s) => s.name === 'operator-rejections');
    expect(rej?.body).toContain('x_dm_outbound');
    expect(rej?.body).toContain('too cold');
    expect(rej?.body).toContain('too salesy');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes roadmap gaps when the file exists', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxpack-roadmap-'));
    fs.mkdirSync(path.join(tmpRoot, 'roadmap'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'roadmap', 'gaps.md'),
      '# Known Gaps\n\n### P0 — test gap\n\nbody\n',
      'utf-8',
    );
    const env = buildDb({});
    const pack = await buildContextPack({
      db: env.db,
      workspaceId: 'ws-1',
      repoRoot: tmpRoot,
      approvalsJsonlPath: null,
    });
    const roadmap = pack.sections.find((s) => s.name === 'roadmap-gaps');
    expect(roadmap?.body).toContain('Known Gaps');
    expect(roadmap?.body).toContain('P0 — test gap');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('truncates oversize sections while keeping the section present', async () => {
    // Build a findings source whose summary dominates 20 rows at ~250 chars each (5KB+).
    const now = new Date().toISOString();
    const padding = 'x'.repeat(240);
    const env = buildDb({
      self_findings: Array.from({ length: 20 }, (_, i) => ({
        id: `f${i}`,
        experiment_id: 'source-copy-lint',
        subject: `copy:F${i}.tsx`,
        verdict: 'warning',
        summary: padding,
        ran_at: now,
        evidence: { affected_files: [`src/F${i}.tsx`] },
      })),
    });
    const pack = await buildContextPack({
      db: env.db,
      workspaceId: 'ws-1',
      repoRoot: null,
      approvalsJsonlPath: null,
    });
    const findings = pack.sections.find((s) => s.name === 'recent-findings');
    expect(findings).toBeDefined();
    expect(findings!.body).toContain('(truncated to');
    expect(Buffer.byteLength(findings!.body, 'utf-8')).toBeLessThanOrEqual(4200);
  });

  it('survives a DB that throws on every query — no section, no throw', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rejectingDb: any = {
      from: () => {
        throw new Error('db unavailable');
      },
    };
    const pack = await buildContextPack({
      db: rejectingDb,
      workspaceId: 'ws-1',
      repoRoot: null,
      approvalsJsonlPath: null,
    });
    expect(pack.sections).toEqual([]);
  });

  it('surfaces active priorities from the workspace priorities dir', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxpack-priorities-'));
    fs.mkdirSync(path.join(tmpDir, 'priorities'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'priorities', 'market-signal.md'),
      [
        '---',
        'title: "Market signal rubric tuning"',
        'status: active',
        'tags: [attribution, market-signal]',
        '---',
        '',
        '## Goal',
        'Get market_signal conversion above 10%.',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'priorities', 'done-one.md'),
      '---\ntitle: "Done already"\nstatus: done\n---\n',
      'utf-8',
    );
    const env = buildDb({});
    const pack = await buildContextPack({
      db: env.db,
      workspaceId: 'ws-1',
      repoRoot: null,
      approvalsJsonlPath: null,
      workspaceDataDir: tmpDir,
    });
    const section = pack.sections.find((s) => s.name === 'active-priorities');
    expect(section).toBeDefined();
    expect(section!.body).toContain('Market signal rubric tuning');
    expect(section!.body).toContain('tags=[attribution, market-signal]');
    expect(section!.body).not.toContain('Done already'); // status=done filtered

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('omits active-priorities section when no priorities dir is provided', async () => {
    const env = buildDb({});
    const pack = await buildContextPack({
      db: env.db,
      workspaceId: 'ws-1',
      repoRoot: null,
      approvalsJsonlPath: null,
      workspaceDataDir: null,
    });
    expect(pack.sections.find((s) => s.name === 'active-priorities')).toBeUndefined();
  });

  it('renders a prompt string with <context> blocks for each section', async () => {
    _seedRuntimeConfigCacheForTests(
      'strategy.revenue_gap_focus',
      'focus string',
    );
    const env = buildDb({});
    const pack = await buildContextPack({
      db: env.db,
      workspaceId: 'ws-1',
      repoRoot: null,
      approvalsJsonlPath: null,
    });
    const rendered = pack.toPromptString();
    expect(rendered).toMatch(/<context name="revenue-gap-focus">[\s\S]*<\/context>/);
  });
});
