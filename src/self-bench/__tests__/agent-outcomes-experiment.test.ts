import { describe, it, expect, vi } from 'vitest';
import { AgentOutcomesExperiment } from '../experiments/agent-outcomes.js';
import type { Experiment, ExperimentContext } from '../experiment-types.js';

/**
 * Build a fake ExperimentContext whose DB serves canned rows for
 * both tables the probe reads. The shape is deliberately narrow —
 * we only need .from(table).select(...).eq/gte/in(...) to resolve
 * to {data, error}.
 */
function makeCtx(rows: {
  tasks: Array<{ id: string; agent_id: string; status: string; created_at: string; error_message: string | null }>;
  agents: Array<{ id: string; name: string }>;
}): ExperimentContext {
  const makeTaskChain = () => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.gte = () => Promise.resolve({ data: rows.tasks, error: null });
    return chain;
  };
  const makeAgentChain = () => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.in = () => Promise.resolve({ data: rows.agents, error: null });
    return chain;
  };
  return {
    db: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      from: vi.fn().mockImplementation((table: string) =>
        table === 'agent_workforce_tasks' ? makeTaskChain() : makeAgentChain(),
      ),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    workspaceId: 'ws-outcomes',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async () => [],
  };
}

function task(agent_id: string, status: string, err: string | null = null) {
  return { id: crypto.randomUUID(), agent_id, status, created_at: new Date().toISOString(), error_message: err };
}

describe('AgentOutcomesExperiment', () => {
  const exp: Experiment = new AgentOutcomesExperiment();

  it('passes when every agent is completing most of its work', async () => {
    const ctx = makeCtx({
      tasks: [
        ...Array.from({ length: 5 }, () => task('a1', 'completed')),
        ...Array.from({ length: 6 }, () => task('a2', 'completed')),
        task('a2', 'failed', 'transient'),
      ],
      agents: [
        { id: 'a1', name: 'Healthy Agent' },
        { id: 'a2', name: 'Mostly Healthy' },
      ],
    });
    const result = await exp.probe(ctx);
    const ev = result.evidence as { offenders: unknown[]; total_agents_checked: number };
    expect(ev.offenders).toHaveLength(0);
    expect(ev.total_agents_checked).toBe(2);
    expect(exp.judge(result, [])).toBe('pass');
    expect(result.subject).toBeNull();
  });

  it('ignores agents below the minimum task threshold', async () => {
    // The Ear here has 4 tasks, all failed, rate 100% — but below
    // MIN_TASKS_FOR_RATE (5) so it should NOT surface. Four
    // failures is a flake, not a signal.
    const ctx = makeCtx({
      tasks: [
        task('ear', 'failed', 'terminated'),
        task('ear', 'failed', 'terminated'),
        task('ear', 'failed', 'terminated'),
        task('ear', 'failed', 'terminated'),
      ],
      agents: [{ id: 'ear', name: 'The Ear' }],
    });
    const result = await exp.probe(ctx);
    const ev = result.evidence as { offenders: unknown[] };
    expect(ev.offenders).toHaveLength(0);
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('flags one drowning agent as warning', async () => {
    // 6 tasks, 5 failed — rate ~83%, above threshold.
    const ctx = makeCtx({
      tasks: [
        task('ear', 'failed', 'context window blown'),
        task('ear', 'failed', 'context window blown'),
        task('ear', 'failed', 'terminated'),
        task('ear', 'failed', 'terminated'),
        task('ear', 'failed', 'terminated'),
        task('ear', 'completed', null),
      ],
      agents: [{ id: 'ear', name: 'The Ear' }],
    });
    const result = await exp.probe(ctx);
    const ev = result.evidence as {
      offenders: Array<{ agent_name: string; failure_rate: number; sample_error: string | null }>;
    };
    expect(ev.offenders).toHaveLength(1);
    expect(ev.offenders[0].agent_name).toBe('The Ear');
    expect(ev.offenders[0].failure_rate).toBeCloseTo(0.833, 2);
    expect(ev.offenders[0].sample_error).toContain('context window');
    expect(result.summary).toMatch(/The Ear/);
    expect(result.subject).toBe('agent:ear');
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('fails when two or more agents are drowning simultaneously', async () => {
    const ctx = makeCtx({
      tasks: [
        ...Array.from({ length: 5 }, () => task('a1', 'failed', 'ctx overflow')),
        ...Array.from({ length: 3 }, () => task('a2', 'failed')),
        ...Array.from({ length: 2 }, () => task('a2', 'completed')),
        ...Array.from({ length: 5 }, () => task('a3', 'completed')),
      ],
      agents: [
        { id: 'a1', name: 'Agent One' },
        { id: 'a2', name: 'Agent Two' },
        { id: 'a3', name: 'Agent Three' },
      ],
    });
    const result = await exp.probe(ctx);
    const ev = result.evidence as { offenders: Array<{ agent_id: string; failure_rate: number }> };
    expect(ev.offenders).toHaveLength(2);
    // Worst-first ordering
    expect(ev.offenders[0].agent_id).toBe('a1');
    expect(ev.offenders[0].failure_rate).toBe(1);
    expect(ev.offenders[1].agent_id).toBe('a2');
    expect(exp.judge(result, [])).toBe('fail');
  });

  it('no intervene method exists (pure observation)', () => {
    expect(exp.intervene).toBeUndefined();
  });
});
