import { describe, it, expect, vi } from 'vitest';
import {
  LogTailWatcher,
  parseServiceList,
  parseThreshold,
  extractErrorSample,
  LOG_TAIL_WATCHER_EXPERIMENT_ID,
} from '../log-tail-watcher.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

interface Capture { inserts: Array<{ table: string; row: Record<string, unknown> }>; }

function mockDb(): { db: DatabaseAdapter; capture: Capture } {
  const capture: Capture = { inserts: [] };
  const db = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        capture.inserts.push({ table, row });
        return Promise.resolve({ data: null, error: null });
      },
    }),
  } as unknown as DatabaseAdapter;
  return { db, capture };
}

describe('parseServiceList', () => {
  it('returns [] when unset', () => {
    expect(parseServiceList(undefined)).toEqual([]);
  });
  it('splits valid services', () => {
    expect(parseServiceList('supabase, vercel')).toEqual(['supabase', 'vercel']);
  });
  it('drops unknown entries', () => {
    expect(parseServiceList('supabase,aws,fly')).toEqual(['supabase', 'fly']);
  });
});

describe('parseThreshold', () => {
  it('default 0.15 when unset', () => {
    expect(parseThreshold(undefined)).toBe(0.15);
  });
  it('rejects out-of-range values', () => {
    expect(parseThreshold('1.5')).toBe(0.15);
    expect(parseThreshold('-0.1')).toBe(0.15);
    expect(parseThreshold('nope')).toBe(0.15);
  });
  it('accepts valid values', () => {
    expect(parseThreshold('0.25')).toBe(0.25);
  });
});

describe('extractErrorSample', () => {
  it('returns at most `limit` error-looking lines', () => {
    const out = [
      'INFO ok',
      'ERROR one',
      'ERROR two',
      '500 server error three',
      'WARN skipped',
      'panic four',
    ].join('\n');
    expect(extractErrorSample(out, 3)).toHaveLength(3);
  });
});

describe('LogTailWatcher.tick', () => {
  it('no-ops when OHWOW_LOG_TAIL_WATCH is unset', async () => {
    const { db, capture } = mockDb();
    const run = vi.fn();
    const watcher = new LogTailWatcher(db, { env: {}, runLogTail: run as never });
    await watcher.tick();
    expect(run).not.toHaveBeenCalled();
    expect(capture.inserts).toHaveLength(0);
  });

  it('writes a warning finding when error_density >= threshold', async () => {
    const { db, capture } = mockDb();
    const run = vi.fn(async () => ({
      content: JSON.stringify({
        ok: true,
        service: 'supabase',
        target: 'proj_example',
        lines_returned: 100,
        error_density: 0.25,
        output: 'INFO ok\nERROR bad\nfatal: kaput\n',
      }),
    }));
    const watcher = new LogTailWatcher(db, {
      env: { OHWOW_LOG_TAIL_WATCH: 'supabase', OHWOW_LOG_TAIL_ERROR_THRESHOLD: '0.2' },
      runLogTail: run,
      now: () => new Date('2026-04-15T16:00:00Z'),
    });
    await watcher.tick();
    expect(run).toHaveBeenCalledOnce();
    expect(capture.inserts).toHaveLength(1);
    const row = capture.inserts[0].row;
    expect(row.experiment_id).toBe(LOG_TAIL_WATCHER_EXPERIMENT_ID);
    expect(row.subject).toBe('supabase:proj_example');
    expect(row.verdict).toBe('warning');
    expect(row.category).toBe('production_logs');
    const evidence = JSON.parse(row.evidence as string);
    expect(evidence.service).toBe('supabase');
    expect(evidence.error_density).toBe(0.25);
    expect(evidence.sample.length).toBeGreaterThan(0);
  });

  it('does NOT write a finding when below threshold', async () => {
    const { db, capture } = mockDb();
    const run = vi.fn(async () => ({
      content: JSON.stringify({ ok: true, service: 'vercel', lines_returned: 100, error_density: 0.05 }),
    }));
    const watcher = new LogTailWatcher(db, {
      env: { OHWOW_LOG_TAIL_WATCH: 'vercel' },
      runLogTail: run,
    });
    await watcher.tick();
    expect(capture.inserts).toHaveLength(0);
  });

  it('skips gracefully when log_tail returns ok=false', async () => {
    const { db, capture } = mockDb();
    const run = vi.fn(async () => ({
      content: JSON.stringify({ ok: false, service: 'fly', lines_returned: 0, error_density: 0, reason: 'cli_unavailable' }),
    }));
    const watcher = new LogTailWatcher(db, {
      env: { OHWOW_LOG_TAIL_WATCH: 'fly' },
      runLogTail: run,
    });
    await watcher.tick();
    expect(capture.inserts).toHaveLength(0);
  });

  it('handles multiple services per tick independently', async () => {
    const { db, capture } = mockDb();
    const run = vi.fn(async (service: string) => {
      const density = service === 'supabase' ? 0.3 : 0.01;
      return {
        content: JSON.stringify({ ok: true, service, lines_returned: 50, error_density: density }),
      };
    });
    const watcher = new LogTailWatcher(db, {
      env: { OHWOW_LOG_TAIL_WATCH: 'supabase,vercel' },
      runLogTail: run,
    });
    await watcher.tick();
    expect(run).toHaveBeenCalledTimes(2);
    expect(capture.inserts).toHaveLength(1);
    expect((capture.inserts[0].row as { subject: string }).subject).toMatch(/^supabase:/);
  });
});
