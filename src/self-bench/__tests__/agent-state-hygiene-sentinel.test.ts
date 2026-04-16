import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AgentStateHygieneSentinelExperiment,
  STATE_POISON_MARKERS,
  sanitizePoisonedValue,
  type AgentStateHygieneEvidence,
} from '../experiments/agent-state-hygiene-sentinel.js';
import type { ExperimentContext } from '../experiment-types.js';

// Mock the state executor at module level so intervene() writes via
// a stub we can assert against. Routing through the real executor
// would try to hit a DB.
const setStateMock = vi.hoisted(() => vi.fn());
vi.mock('../../execution/state/index.js', () => ({
  executeStateTool: setStateMock,
}));

interface FakeStateRow {
  agent_id: string;
  key: string;
  // `unknown` mirrors the runtime type — our DB adapter surfaces JSONB
  // columns as plain objects for most reads, so the experiment has to
  // tolerate both string and object inputs without crashing.
  value: unknown;
  updated_at: string | null;
}

function makeCtx(rows: FakeStateRow[], opts?: { lookupByAgentKey?: Map<string, unknown> }): ExperimentContext {
  // One chain supporting BOTH the probe's `.limit(n)` terminal AND
  // intervene's `.maybeSingle()` terminal, because both operate on
  // `agent_workforce_task_state`. The chain remembers the most
  // recent .eq() filters so .maybeSingle() can return a specific
  // row when the test provided a lookup map.
  let agentIdFilter: string | undefined;
  let keyFilter: string | undefined;
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (col: string, val: string) => {
    if (col === 'agent_id') agentIdFilter = val;
    if (col === 'key') keyFilter = val;
    return chain;
  };
  chain.limit = (_n: number) => Promise.resolve({ data: rows, error: null });
  chain.maybeSingle = () => {
    if (!opts?.lookupByAgentKey) return Promise.resolve({ data: null });
    const match = opts.lookupByAgentKey.get(`${agentIdFilter}::${keyFilter}`);
    return Promise.resolve({ data: match ?? null });
  };
  return {
    db: {
      from: () => ({ select: () => chain }),
    } as never,
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

  it('handles an already-parsed object-valued row (JSONB adapter surface)', async () => {
    // The DB adapter JSON-parses TEXT columns whose content is valid
    // JSON. A prior version of the sentinel crashed with
    // "e.toLowerCase is not a function" in production because it
    // assumed string. Keep an object-valued row in the test fixture so
    // this regression can't re-land silently.
    const exp = new AgentStateHygieneSentinelExperiment();
    const res = await exp.probe(makeCtx([
      row({
        value: { text: 'hi', status: 'posting_manually', reason: 'drafted' },
      }),
    ]));
    const ev = res.evidence as AgentStateHygieneEvidence;
    expect(ev.flagged_rows).toBe(1);
    expect(ev.flagged[0].marker).toBe('posting_manually');
    expect(ev.flagged[0].value_preview).toContain('posting_manually');
  });

  it('ignores primitive-valued rows that happen to be numbers', async () => {
    const exp = new AgentStateHygieneSentinelExperiment();
    const res = await exp.probe(makeCtx([
      row({ key: 'x_posts_count', value: 4 }),
    ]));
    const ev = res.evidence as AgentStateHygieneEvidence;
    expect(ev.flagged_rows).toBe(0);
  });

  it('exports a non-empty marker list with the stickiest patterns', () => {
    expect(STATE_POISON_MARKERS.length).toBeGreaterThan(5);
    expect(STATE_POISON_MARKERS).toContain('posting_manually');
    expect(STATE_POISON_MARKERS).toContain('cannot_automate');
  });
});

describe('sanitizePoisonedValue', () => {
  it('drops fields whose value matches a marker but preserves the rest', () => {
    const cleaned = sanitizePoisonedValue({
      text: 'Your AI tools stay dumb.',
      status: 'posting_manually',
      note: 'cannot_automate',
      scheduled_time: 'now',
    });
    expect(cleaned).toEqual({
      text: 'Your AI tools stay dumb.',
      scheduled_time: 'now',
    });
  });

  it('drops fields whose KEY name matches a marker even when value is innocent', () => {
    const cleaned = sanitizePoisonedValue({
      text: 'hi',
      posting_manually: true,
    });
    expect(cleaned).toEqual({ text: 'hi' });
  });

  it('accepts a JSON string input and returns {} for unparseable input', () => {
    expect(sanitizePoisonedValue('{"text":"ok","status":"cannot_automate"}')).toEqual({ text: 'ok' });
    expect(sanitizePoisonedValue('not json')).toEqual({});
    expect(sanitizePoisonedValue(null)).toEqual({});
    expect(sanitizePoisonedValue(42)).toEqual({});
    expect(sanitizePoisonedValue(['a', 'b'])).toEqual({});
  });
});

describe('AgentStateHygieneSentinelExperiment.intervene', () => {
  beforeEach(() => {
    setStateMock.mockReset();
    setStateMock.mockResolvedValue({ content: 'ok', is_error: false });
  });

  // `status` matches the `posting_manually` marker by value; `reason`
  // matches `credentials_missing` by value. Both should be stripped;
  // `text` should survive.
  const POISONED_ROW: FakeStateRow = {
    agent_id: 'agent-1aaa9707',
    key: 'tweet_to_post',
    value: { text: 'hi', status: 'posting_manually', reason: 'credentials_missing' },
    updated_at: new Date().toISOString(),
  };

  it('returns null when verdict is pass (no work to do)', async () => {
    const exp = new AgentStateHygieneSentinelExperiment();
    const probe = await exp.probe(makeCtx([]));
    const result = await exp.intervene('pass', probe, makeCtx([]));
    expect(result).toBeNull();
    expect(setStateMock).not.toHaveBeenCalled();
  });

  it('calls executeStateTool(set_state) with sanitized value for each flagged row', async () => {
    const exp = new AgentStateHygieneSentinelExperiment();
    const lookup = new Map([[`${POISONED_ROW.agent_id}::${POISONED_ROW.key}`, {
      value: POISONED_ROW.value,
      value_type: 'object',
      scope: 'agent',
      scope_id: null,
    }]]);
    const ctx = makeCtx([POISONED_ROW], { lookupByAgentKey: lookup });
    const probe = await exp.probe(ctx);
    const result = await exp.intervene('warning', probe, ctx);
    expect(result).not.toBeNull();
    expect(setStateMock).toHaveBeenCalledTimes(1);
    const [toolName, input, stateCtx] = setStateMock.mock.calls[0];
    expect(toolName).toBe('set_state');
    expect(input.key).toBe('tweet_to_post');
    // Both `status` (poisoned value) and `reason` (poisoned value) stripped;
    // `text` survives.
    expect(input.value).toEqual({ text: 'hi' });
    expect(stateCtx.agentId).toBe('agent-1aaa9707');
    expect(stateCtx.workspaceId).toBe('ws-1');
  });

  it('records dropped keys + the original marker in the intervention details', async () => {
    const exp = new AgentStateHygieneSentinelExperiment();
    const lookup = new Map([[`${POISONED_ROW.agent_id}::${POISONED_ROW.key}`, {
      value: POISONED_ROW.value,
      value_type: 'object',
      scope: 'agent',
      scope_id: null,
    }]]);
    const ctx = makeCtx([POISONED_ROW], { lookupByAgentKey: lookup });
    const probe = await exp.probe(ctx);
    const result = await exp.intervene('warning', probe, ctx);
    expect(result).not.toBeNull();
    const details = result!.details as { cleaned: Array<{ dropped_keys: string[]; marker: string }> };
    expect(details.cleaned[0].marker).toBe('posting_manually');
    expect(details.cleaned[0].dropped_keys).toContain('status');
    expect(details.cleaned[0].dropped_keys).toContain('reason');
  });

  it('still returns a report when setState fails, with errors listed', async () => {
    setStateMock.mockResolvedValueOnce({ content: 'Error: locked', is_error: true });
    const exp = new AgentStateHygieneSentinelExperiment();
    const lookup = new Map([[`${POISONED_ROW.agent_id}::${POISONED_ROW.key}`, {
      value: POISONED_ROW.value,
      value_type: 'object',
      scope: 'agent',
      scope_id: null,
    }]]);
    const ctx = makeCtx([POISONED_ROW], { lookupByAgentKey: lookup });
    const probe = await exp.probe(ctx);
    const result = await exp.intervene('warning', probe, ctx);
    expect(result).not.toBeNull();
    const details = result!.details as { cleaned: unknown[]; errors: Array<{ error: string }> };
    expect(details.cleaned.length).toBe(0);
    expect(details.errors.length).toBe(1);
    expect(details.errors[0].error).toContain('locked');
  });
});
