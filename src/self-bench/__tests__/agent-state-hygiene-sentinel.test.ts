import { describe, it, expect } from 'vitest';
import {
  AgentStateHygieneSentinelExperiment,
  STATE_POISON_MARKERS,
  type AgentStateHygieneEvidence,
} from '../experiments/agent-state-hygiene-sentinel.js';
import type { ExperimentContext } from '../experiment-types.js';

interface FakeStateRow {
  agent_id: string;
  key: string;
  value: string | null;
  updated_at: string | null;
}

function makeCtx(rows: FakeStateRow[]): ExperimentContext {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (_col: string, _val: unknown) => chain;
  chain.limit = (_n: number) => Promise.resolve({ data: rows, error: null });
  return {
    db: { from: () => ({ select: () => chain }) } as never,
    workspaceId: 'ws-1',
    workspaceSlug: 'test',
    engine: {} as never,
    recentFindings: async () => [],
  };
}

function row(overrides: Partial<FakeStateRow>): FakeStateRow {
  return {
    agent_id: 'agent-1aaa9707',
    key: 'tweet_to_post',
    value: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('AgentStateHygieneSentinelExperiment', () => {
  it('passes when no state rows exist', async () => {
    const exp = new AgentStateHygieneSentinelExperiment();
    const res = await exp.probe(makeCtx([]));
    const ev = res.evidence as AgentStateHygieneEvidence;
    expect(ev.rows_scanned).toBe(0);
    expect(ev.flagged_rows).toBe(0);
    expect(exp.judge(res, [])).toBe('pass');
  });

  it('passes when no state row carries a poison marker', async () => {
    const exp = new AgentStateHygieneSentinelExperiment();
    const res = await exp.probe(makeCtx([
      row({ value: '{"text":"hello","status":"queued"}' }),
      row({ key: 'x_posts_count', value: '4' }),
    ]));
    const ev = res.evidence as AgentStateHygieneEvidence;
    expect(ev.flagged_rows).toBe(0);
    expect(exp.judge(res, [])).toBe('pass');
  });

  it('warns on a single flagged state row', async () => {
    const exp = new AgentStateHygieneSentinelExperiment();
    const res = await exp.probe(makeCtx([
      row({ value: '{"text":"hi","status":"posting_manually","reason":"drafted"}' }),
      row({ key: 'x_posts_count', value: '4' }),
    ]));
    const ev = res.evidence as AgentStateHygieneEvidence;
    expect(ev.flagged_rows).toBe(1);
    expect(ev.flagged[0].marker).toBe('posting_manually');
    expect(ev.flagged[0].key).toBe('tweet_to_post');
    expect(exp.judge(res, [])).toBe('warning');
  });

  it('fails at 2+ flagged rows across any markers', async () => {
    const exp = new AgentStateHygieneSentinelExperiment();
    const res = await exp.probe(makeCtx([
      row({ value: '{"status":"posting_manually"}' }),
      row({ key: 'last_email', value: '{"status":"cannot_automate"}' }),
    ]));
    expect(exp.judge(res, [])).toBe('fail');
  });

  it('groups flagged rows by (agent_id, key) so repeats are visible', async () => {
    const exp = new AgentStateHygieneSentinelExperiment();
    const res = await exp.probe(makeCtx([
      row({ agent_id: 'a-1', key: 'tweet_to_post', value: '{"status":"posting_manually"}' }),
      row({ agent_id: 'a-1', key: 'email_draft', value: '{"reason":"credentials_missing"}' }),
      row({ agent_id: 'a-2', key: 'tweet_to_post', value: '{"status":"fallback_to_manual"}' }),
    ]));
    const ev = res.evidence as AgentStateHygieneEvidence;
    expect(ev.flagged_rows).toBe(3);
    expect(ev.by_agent_key).toHaveLength(3);
    expect(ev.by_agent_key[0].count).toBe(1);
  });

  it('sorts flagged evidence newest-first by updated_at', async () => {
    const exp = new AgentStateHygieneSentinelExperiment();
    const older = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const newer = new Date().toISOString();
    const res = await exp.probe(makeCtx([
      row({ key: 'old', value: '{"status":"posting_manually"}', updated_at: older }),
      row({ key: 'new', value: '{"status":"posting_manually"}', updated_at: newer }),
    ]));
    const ev = res.evidence as AgentStateHygieneEvidence;
    expect(ev.flagged[0].key).toBe('new');
  });

  it('exports a non-empty marker list with the stickiest patterns', () => {
    expect(STATE_POISON_MARKERS.length).toBeGreaterThan(5);
    expect(STATE_POISON_MARKERS).toContain('posting_manually');
    expect(STATE_POISON_MARKERS).toContain('cannot_automate');
  });
});
