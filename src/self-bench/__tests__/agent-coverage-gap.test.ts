import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentCoverageGapExperiment } from '../experiments/agent-coverage-gap.js';
import type { Experiment, ExperimentContext } from '../experiment-types.js';

/**
 * DB stub supporting:
 *   .from('agent_workforce_agents').select(...).eq('workspace_id', val)
 *   .from('agent_workforce_tasks').select(...).eq('workspace_id', val).gte('created_at', val)
 *   .from('self_findings').insert(row)  — from intervene's writeFinding calls
 *
 * Different tables return different rows via seed data.
 */
function buildDb(seed: {
  agents: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
}) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    agent_workforce_agents: seed.agents,
    agent_workforce_tasks: seed.tasks,
    self_findings: [],
  };

  function makeBuilder(table: string) {
    const filters: Array<{ col: string; op: 'eq' | 'gte'; val: unknown }> = [];

    const apply = () => tables[table].filter((row) =>
      filters.every((f) => {
        if (f.op === 'eq') return row[f.col] === f.val;
        if (f.op === 'gte') return String(row[f.col] ?? '') >= String(f.val);
        return true;
      }),
    );

    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => { filters.push({ col, op: 'eq', val }); return builder; };
    builder.gte = (col: string, val: unknown) => { filters.push({ col, op: 'gte', val }); return builder; };
    builder.then = (resolve: (v: unknown) => void) =>
      resolve({ data: apply(), error: null });
    builder.insert = (row: Record<string, unknown>) => {
      tables[table].push({ ...row });
      return Promise.resolve({ data: null, error: null });
    };
    return builder;
  }

  return {
    db: { from: vi.fn().mockImplementation((table: string) => makeBuilder(table)) },
    tables,
  };
}

function makeCtx(env: ReturnType<typeof buildDb>): ExperimentContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: env.db as any,
    workspaceId: 'ws-1',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async () => [],
  };
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

// Baseline-fresh task — created in the last minute so it counts in all windows.
function freshTask(agentId: string, status: string) {
  return {
    agent_id: agentId,
    status,
    created_at: new Date(Date.now() - 60 * 1000).toISOString(),
    workspace_id: 'ws-1',
  };
}

describe('AgentCoverageGapExperiment', () => {
  const exp: Experiment = new AgentCoverageGapExperiment();

  it('probe passes when every agent has recent healthy tasks', async () => {
    const env = buildDb({
      agents: [
        { id: 'a1', name: 'Writer', status: 'working', workspace_id: 'ws-1' },
        { id: 'a2', name: 'Researcher', status: 'idle', workspace_id: 'ws-1' },
      ],
      tasks: [
        freshTask('a1', 'completed'),
        freshTask('a1', 'completed'),
        freshTask('a2', 'completed'),
      ],
    });
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { concerning_count: number; total_agents: number };
    expect(ev.total_agents).toBe(2);
    expect(ev.concerning_count).toBe(0);
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('flags a stale agent: zero tasks in 14d with non-idle status', async () => {
    const env = buildDb({
      agents: [
        { id: 'a1', name: 'Zombie', status: 'working', workspace_id: 'ws-1' },
      ],
      tasks: [], // no tasks
    });
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { stale_count: number; agents: Array<{ stale: boolean; concern_reason?: string }> };
    expect(ev.stale_count).toBe(1);
    expect(ev.agents[0].stale).toBe(true);
    expect(ev.agents[0].concern_reason).toBe('stale');
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('does NOT flag an idle agent with zero tasks (just dormant)', async () => {
    const env = buildDb({
      agents: [
        { id: 'a1', name: 'Fresh', status: 'idle', workspace_id: 'ws-1' },
      ],
      tasks: [],
    });
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { stale_count: number; concerning_count: number };
    expect(ev.stale_count).toBe(0);
    expect(ev.concerning_count).toBe(0);
  });

  it('flags an agent with >50% fail rate over 5+ recent tasks', async () => {
    const env = buildDb({
      agents: [
        { id: 'a1', name: 'Broken', status: 'working', workspace_id: 'ws-1' },
      ],
      tasks: [
        freshTask('a1', 'failed'),
        freshTask('a1', 'failed'),
        freshTask('a1', 'failed'),
        freshTask('a1', 'failed'),
        freshTask('a1', 'completed'),
        freshTask('a1', 'completed'),
      ],
    });
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as {
      high_fail_rate_count: number;
      agents: Array<{ concerning: boolean; fail_rate_7d: number; concern_reason?: string }>;
    };
    expect(ev.high_fail_rate_count).toBe(1);
    expect(ev.agents[0].concerning).toBe(true);
    expect(ev.agents[0].fail_rate_7d).toBeCloseTo(0.67, 1);
    expect(ev.agents[0].concern_reason).toBe('high_fail_rate');
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('does NOT flag an agent with fewer than 5 recent tasks (insufficient samples)', async () => {
    const env = buildDb({
      agents: [
        { id: 'a1', name: 'Small-sample', status: 'working', workspace_id: 'ws-1' },
      ],
      tasks: [
        freshTask('a1', 'failed'),
        freshTask('a1', 'failed'),
        freshTask('a1', 'failed'),
      ],
    });
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { concerning_count: number; agents: Array<{ fail_rate_7d: number }> };
    expect(ev.concerning_count).toBe(0);
    expect(ev.agents[0].fail_rate_7d).toBe(1.0); // rate is computed but doesn't trigger
  });

  it('warning verdict when no agents exist at all (odd shape)', async () => {
    const env = buildDb({ agents: [], tasks: [] });
    const result = await exp.probe(makeCtx(env));
    expect(result.summary).toContain('no agents registered');
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('intervene writes one finding per concerning agent', async () => {
    const env = buildDb({
      agents: [
        { id: 'good', name: 'Good', status: 'idle', workspace_id: 'ws-1' },
        { id: 'stale', name: 'Stale', status: 'working', workspace_id: 'ws-1' },
        { id: 'fails', name: 'Fails', status: 'working', workspace_id: 'ws-1' },
      ],
      tasks: [
        freshTask('good', 'completed'),
        // stale has nothing
        freshTask('fails', 'failed'),
        freshTask('fails', 'failed'),
        freshTask('fails', 'failed'),
        freshTask('fails', 'failed'),
        freshTask('fails', 'completed'),
      ],
    });
    const ctx = makeCtx(env);
    const result = await exp.probe(ctx);
    const intervention = await exp.intervene!('warning', result, ctx);
    expect(intervention).not.toBeNull();
    expect((intervention!.details.gap_filler_finding_ids as string[])).toHaveLength(2);
    // Two rows written to self_findings
    expect(env.tables.self_findings).toHaveLength(2);
    const subjects = env.tables.self_findings.map((f) => String(f.subject));
    expect(subjects.sort()).toEqual(['agent:fails', 'agent:stale']);
  });

  it('intervene returns null when there are no concerning agents', async () => {
    const env = buildDb({
      agents: [
        { id: 'a1', name: 'Healthy', status: 'idle', workspace_id: 'ws-1' },
      ],
      tasks: [freshTask('a1', 'completed')],
    });
    const ctx = makeCtx(env);
    const result = await exp.probe(ctx);
    const intervention = await exp.intervene!('pass', result, ctx);
    expect(intervention).toBeNull();
    expect(env.tables.self_findings).toHaveLength(0);
  });

  it('per-agent finding captures concern_reason and full stats', async () => {
    const env = buildDb({
      agents: [
        { id: 'broken', name: 'Broken', status: 'working', workspace_id: 'ws-1' },
      ],
      tasks: [
        freshTask('broken', 'failed'),
        freshTask('broken', 'failed'),
        freshTask('broken', 'failed'),
        freshTask('broken', 'failed'),
        freshTask('broken', 'completed'),
      ],
    });
    const ctx = makeCtx(env);
    const result = await exp.probe(ctx);
    await exp.intervene!('warning', result, ctx);
    const finding = env.tables.self_findings[0];
    expect(finding.subject).toBe('agent:broken');
    expect(finding.verdict).toBe('warning');
    expect(String(finding.summary)).toContain('failure rate');
    expect(String(finding.summary)).toContain('Broken');
    const evidence = JSON.parse(finding.evidence as string);
    expect(evidence.is_gap_filler).toBe(true);
    expect(evidence.concern_reason).toBe('high_fail_rate');
    expect(evidence.tasks_7d).toBe(5);
    expect(evidence.failed_7d).toBe(4);
  });

  it('an agent with recent tasks but status=working that stopped recently is NOT flagged stale', async () => {
    const env = buildDb({
      agents: [
        { id: 'a1', name: 'Recent', status: 'working', workspace_id: 'ws-1' },
      ],
      tasks: [
        // 10 days ago — still within 14d window
        {
          agent_id: 'a1',
          status: 'completed',
          created_at: daysAgo(10),
          workspace_id: 'ws-1',
        },
      ],
    });
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { stale_count: number; concerning_count: number };
    expect(ev.stale_count).toBe(0);
    expect(ev.concerning_count).toBe(0);
  });

  it('only counts tasks in the 7d window for fail rate', async () => {
    const env = buildDb({
      agents: [
        { id: 'a1', name: 'Older-failures', status: 'working', workspace_id: 'ws-1' },
      ],
      tasks: [
        // 5 failed tasks 10 days ago — outside fail-rate window
        ...[10, 10, 10, 10, 10].map((d) => ({
          agent_id: 'a1',
          status: 'failed',
          created_at: daysAgo(d),
          workspace_id: 'ws-1',
        })),
        // 1 recent fresh completed task
        freshTask('a1', 'completed'),
      ],
    });
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { agents: Array<{ tasks_7d: number; total_14d: number; concerning: boolean }> };
    expect(ev.agents[0].total_14d).toBe(6);
    expect(ev.agents[0].tasks_7d).toBe(1); // only the fresh one
    expect(ev.agents[0].concerning).toBe(false); // 1 task is below min sample size
  });
});
