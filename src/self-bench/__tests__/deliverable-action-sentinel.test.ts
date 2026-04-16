import { describe, it, expect } from 'vitest';
import {
  DeliverableActionSentinelExperiment,
  NARRATED_FAILURE_CANARIES,
  type DeliverableActionSentinelEvidence,
} from '../experiments/deliverable-action-sentinel.js';
import type { ExperimentContext } from '../experiment-types.js';

interface FakeTaskRow {
  id: string;
  title: string | null;
  status: string;
  output: string | null;
  deferred_action: string | null;
  completed_at: string | null;
}

function makeCtx(rows: FakeTaskRow[]): ExperimentContext {
  const filters: Record<string, unknown> = {};
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (col: string, val: unknown) => {
    filters[col] = val;
    return chain;
  };
  chain.gte = (_col: string, _val: unknown) => chain;
  chain.not = (_col: string, _op: string, _val: unknown) => chain;
  chain.order = (_col: string, _opts: unknown) => chain;
  chain.limit = (_n: number) => Promise.resolve({ data: rows, error: null });
  return {
    db: { from: () => ({ select: () => chain }) } as never,
    workspaceId: filters.workspace_id as string ?? 'ws-1',
    workspaceSlug: 'test',
    engine: {} as never,
    recentFindings: async () => [],
  };
}

function row(overrides: Partial<FakeTaskRow>): FakeTaskRow {
  return {
    id: 't-' + Math.random().toString(36).slice(2, 10),
    title: 'Post one tweet today',
    status: 'completed',
    output: null,
    deferred_action: JSON.stringify({ type: 'post_tweet', provider: 'x' }),
    completed_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('DeliverableActionSentinelExperiment', () => {
  it('passes when there are no deferred-action tasks in the window', async () => {
    const exp = new DeliverableActionSentinelExperiment();
    const res = await exp.probe(makeCtx([]));
    const ev = res.evidence as DeliverableActionSentinelEvidence;
    expect(ev.tasks_in_window).toBe(0);
    expect(ev.flagged_tasks).toBe(0);
    expect(exp.judge(res, [])).toBe('pass');
  });

  it('passes when every deferred-action task output is clean', async () => {
    const exp = new DeliverableActionSentinelExperiment();
    const res = await exp.probe(makeCtx([
      row({ output: 'Posted the tweet. All good.' }),
      row({ output: 'Tweet went out, URL: https://x.com/foo/status/123' }),
    ]));
    const ev = res.evidence as DeliverableActionSentinelEvidence;
    expect(ev.tasks_in_window).toBe(2);
    expect(ev.flagged_tasks).toBe(0);
    expect(exp.judge(res, [])).toBe('pass');
  });

  it('warns when one output trips the login-page canary', async () => {
    const exp = new DeliverableActionSentinelExperiment();
    const res = await exp.probe(makeCtx([
      row({ id: 't-bad', output: "I see we're at a login page. I cannot log in and post." }),
      row({ output: 'Posted.' }),
    ]));
    const ev = res.evidence as DeliverableActionSentinelEvidence;
    expect(ev.flagged_tasks).toBe(1);
    expect(ev.flagged[0].task_id).toBe('t-bad');
    expect(ev.flagged[0].canary).toBe('login page');
    expect(ev.by_action_type).toEqual({ post_tweet: 1 });
    expect(exp.judge(res, [])).toBe('warning');
  });

  it('fails when flagged count ≥ MIN_FAIL_SAMPLES and rate ≥ FAIL_RATE', async () => {
    const exp = new DeliverableActionSentinelExperiment();
    const res = await exp.probe(makeCtx([
      row({ output: "I don't have access to the @ohwow_fun account credentials" }),
      row({ output: 'not signed in; cannot post' }),
      row({ output: 'Posted successfully.' }),
    ]));
    const ev = res.evidence as DeliverableActionSentinelEvidence;
    // 2/3 flagged = 0.666… ≥ 0.5
    expect(ev.flagged_tasks).toBe(2);
    expect(ev.narrated_failure_rate_6h).toBeGreaterThanOrEqual(0.5);
    expect(exp.judge(res, [])).toBe('fail');
  });

  it('stays at warning on a single flagged task even at 100% rate', async () => {
    const exp = new DeliverableActionSentinelExperiment();
    const res = await exp.probe(makeCtx([
      row({ output: 'login page blocked me' }),
    ]));
    const ev = res.evidence as DeliverableActionSentinelEvidence;
    expect(ev.flagged_tasks).toBe(1);
    expect(ev.narrated_failure_rate_6h).toBe(1);
    expect(exp.judge(res, [])).toBe('warning');
  });

  it('groups flagged tasks by action_type across deferred_action shapes', async () => {
    const exp = new DeliverableActionSentinelExperiment();
    const res = await exp.probe(makeCtx([
      row({
        deferred_action: JSON.stringify({ type: 'post_tweet', provider: 'x' }),
        output: 'permission denied',
      }),
      row({
        deferred_action: JSON.stringify({ type: 'send_email', provider: 'gmail' }),
        output: "cannot authenticate with gmail",
      }),
      row({
        deferred_action: JSON.stringify({ type: 'post_tweet', provider: 'x' }),
        output: 'not signed in to any account',
      }),
    ]));
    const ev = res.evidence as DeliverableActionSentinelEvidence;
    expect(ev.flagged_tasks).toBe(3);
    expect(ev.by_action_type).toEqual({ post_tweet: 2, send_email: 1 });
  });

  it('tolerates malformed deferred_action JSON without crashing', async () => {
    const exp = new DeliverableActionSentinelExperiment();
    const res = await exp.probe(makeCtx([
      row({ deferred_action: '{not json', output: 'login dialog shown' }),
    ]));
    const ev = res.evidence as DeliverableActionSentinelEvidence;
    // Malformed deferred_action → no parseable type → unknown bucket
    expect(ev.flagged_tasks).toBe(1);
    expect(ev.flagged[0].action_type).toBe('unknown');
  });

  it('handles an already-parsed deferred_action object from the DB adapter', async () => {
    // Our DB adapter surfaces JSONB columns as plain objects for most
    // table reads. Before this contract was pinned down the experiment
    // did `JSON.parse(object)`, silently threw, and bucketed every row
    // under `unknown`. Here we pass an object to make the regression
    // path explicit.
    const exp = new DeliverableActionSentinelExperiment();
    const res = await exp.probe(makeCtx([
      row({
        deferred_action: { type: 'post_tweet', provider: 'x', params: {} } as unknown as string,
        output: "I don't have access to the account",
      }),
    ]));
    const ev = res.evidence as DeliverableActionSentinelEvidence;
    expect(ev.flagged_tasks).toBe(1);
    expect(ev.flagged[0].action_type).toBe('post_tweet');
    expect(ev.by_action_type).toEqual({ post_tweet: 1 });
  });

  it('flags the "ready for manual posting" capitulation pattern', async () => {
    const exp = new DeliverableActionSentinelExperiment();
    const res = await exp.probe(makeCtx([
      row({ output: '## Tweet Ready for Manual Posting\n\n**Tweet Content:** ...' }),
    ]));
    const ev = res.evidence as DeliverableActionSentinelEvidence;
    expect(ev.flagged_tasks).toBe(1);
    // "manual posting" or "ready for manual" — either is acceptable; the
    // earliest match in the canary list wins.
    expect(['manual posting', 'ready for manual']).toContain(ev.flagged[0].canary);
  });

  it('exports a non-empty canary list for downstream consumers', () => {
    expect(NARRATED_FAILURE_CANARIES.length).toBeGreaterThan(10);
    expect(NARRATED_FAILURE_CANARIES).toContain('login page');
    expect(NARRATED_FAILURE_CANARIES).toContain("don't have access");
  });
});
