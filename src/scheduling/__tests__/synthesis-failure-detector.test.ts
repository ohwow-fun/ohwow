import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  SynthesisFailureDetector,
  qualifyTask,
  inferTargetUrl,
  type SynthesisCandidate,
} from '../synthesis-failure-detector.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// A chainable mock that captures update() calls and returns a preset
// list of rows from the initial select chain.
function makeMockDb(rows: Array<Record<string, unknown>>) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

  const selectChain = {
    select: vi.fn(() => selectChain),
    eq: vi.fn(() => selectChain),
    gt: vi.fn(() => selectChain),
    order: vi.fn(() => selectChain),
    limit: vi.fn(() => Promise.resolve({ data: rows, error: null })),
  };

  const makeUpdateChain = (patch: Record<string, unknown>) => {
    const chain = {
      eq: vi.fn((_col: string, value: unknown) => {
        updates.push({ id: String(value), patch });
        return Promise.resolve({ data: null, error: null });
      }),
    };
    return chain;
  };

  const db = {
    from: vi.fn(() => ({
      select: selectChain.select,
      update: vi.fn((patch: Record<string, unknown>) => makeUpdateChain(patch)),
    })),
  } as unknown as DatabaseAdapter;

  return { db, updates };
}

describe('qualifyTask', () => {
  const base = {
    id: 't-1',
    status: 'completed',
    tokens_used: 100_000,
    output: '',
    created_at: new Date().toISOString(),
    metadata: '{}',
  };

  it('accepts a high-token empty-output completed task', () => {
    expect(qualifyTask(base, 50_000, 7).eligible).toBe(true);
  });

  it('rejects non-completed tasks', () => {
    expect(qualifyTask({ ...base, status: 'in_progress' }, 50_000, 7).eligible).toBe(false);
  });

  it('rejects low-token tasks', () => {
    expect(qualifyTask({ ...base, tokens_used: 10 }, 50_000, 7).eligible).toBe(false);
  });

  it('rejects tasks with substantive output', () => {
    const longOutput = 'x'.repeat(1000);
    expect(qualifyTask({ ...base, output: longOutput }, 50_000, 7).eligible).toBe(false);
  });

  it('rejects already-considered tasks via metadata flag', () => {
    expect(
      qualifyTask(
        { ...base, metadata: JSON.stringify({ synthesis_considered: true }) },
        50_000,
        7,
      ).eligible,
    ).toBe(false);
  });

  it('accepts object-typed metadata (already parsed by the adapter)', () => {
    expect(qualifyTask({ ...base, metadata: { foo: 'bar' } }, 50_000, 7).eligible).toBe(true);
  });

  it('rejects tasks older than maxAgeDays', () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    expect(qualifyTask({ ...base, created_at: oldDate }, 50_000, 7).eligible).toBe(false);
  });
});

describe('inferTargetUrl', () => {
  it('extracts from a navigate action inputSummary', () => {
    const trace = [
      {
        iteration: 1,
        actions: [
          { tool: 'browser_navigate', inputSummary: 'url=https://x.com/compose/post' },
        ],
      },
    ];
    expect(inferTargetUrl(trace, null)).toBe('https://x.com/compose/post');
  });

  it('falls through any-tool URL mention when no navigate is found', () => {
    const trace = [
      {
        iteration: 1,
        actions: [
          { tool: 'run_agent', inputSummary: 'please visit https://example.com/page right now' },
        ],
      },
    ];
    expect(inferTargetUrl(trace, null)).toBe('https://example.com/page');
  });

  it('falls back to input field when trace has no URL', () => {
    expect(inferTargetUrl([], { endpoint: 'https://api.example.com/v1/run' })).toBe(
      'https://api.example.com/v1/run',
    );
  });

  it('returns null when neither trace nor input has a URL', () => {
    expect(inferTargetUrl([], null)).toBeNull();
    expect(inferTargetUrl([], { description: 'do the thing' })).toBeNull();
  });
});

describe('SynthesisFailureDetector.checkFailures', () => {
  it('emits candidates for high-token empty-output tasks and marks them considered', async () => {
    const rows = [
      {
        id: 'task-eligible',
        title: 'Post a tweet LIVE',
        description: 'Desktop automation to post a tweet',
        input: JSON.stringify({ handle: 'ohwow_fun', text: 'hi' }),
        output: '',
        status: 'completed',
        tokens_used: 408_000,
        agent_id: 'agent-social',
        metadata: JSON.stringify({
          react_trace: [
            { iteration: 1, actions: [{ tool: 'browser_navigate', inputSummary: 'url=https://x.com/compose/post' }] },
            { iteration: 2, actions: [{ tool: 'desktop_type', inputSummary: 'text=hi' }] },
          ],
        }),
        created_at: new Date().toISOString(),
      },
      {
        id: 'task-skipped-output',
        title: 'Something else',
        input: '{}',
        output: 'this is a real, substantive answer that the agent successfully produced',
        status: 'completed',
        tokens_used: 80_000,
        metadata: '{}',
        created_at: new Date().toISOString(),
      },
    ];

    const { db, updates } = makeMockDb(rows);
    const bus = new EventEmitter();
    const received: SynthesisCandidate[] = [];
    bus.on('synthesis:candidate', (c: SynthesisCandidate) => received.push(c));

    const detector = new SynthesisFailureDetector({
      db,
      workspaceId: 'ws-1',
      bus,
      minTokensUsed: 50_000,
    });

    const emitted = await detector.checkFailures();

    expect(emitted).toHaveLength(1);
    expect(received).toHaveLength(1);
    expect(received[0].taskId).toBe('task-eligible');
    expect(received[0].tokensUsed).toBe(408_000);
    expect(received[0].targetUrlGuess).toBe('https://x.com/compose/post');
    expect(received[0].reactTrace).toHaveLength(2);

    // The eligible row got a single update call that patches metadata.
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('task-eligible');
    const patchedMetadata = JSON.parse(String(updates[0].patch.metadata));
    expect(patchedMetadata.synthesis_considered).toBe(true);
    expect(patchedMetadata.synthesis_candidate_emitted_at).toBeTruthy();
    expect(patchedMetadata.react_trace).toHaveLength(2); // preserved
  });

  it('does not re-emit a task that is already marked synthesis_considered', async () => {
    const rows = [
      {
        id: 'task-already-seen',
        title: 'X',
        input: '{}',
        output: '',
        status: 'completed',
        tokens_used: 200_000,
        metadata: JSON.stringify({ synthesis_considered: true }),
        created_at: new Date().toISOString(),
      },
    ];
    const { db, updates } = makeMockDb(rows);
    const bus = new EventEmitter();
    const received: SynthesisCandidate[] = [];
    bus.on('synthesis:candidate', (c: SynthesisCandidate) => received.push(c));

    const detector = new SynthesisFailureDetector({ db, workspaceId: 'ws-1', bus });
    const emitted = await detector.checkFailures();

    expect(emitted).toEqual([]);
    expect(received).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('handles object-typed metadata returned by the SQLite adapter', async () => {
    const rows = [
      {
        id: 'task-obj-meta',
        title: 'Y',
        input: { anyKey: 'val' },
        output: null,
        status: 'completed',
        tokens_used: 70_000,
        metadata: { react_trace: [] },
        created_at: new Date().toISOString(),
      },
    ];
    const { db } = makeMockDb(rows);
    const bus = new EventEmitter();
    const detector = new SynthesisFailureDetector({ db, workspaceId: 'ws-1', bus });
    const emitted = await detector.checkFailures();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].taskId).toBe('task-obj-meta');
  });
});
