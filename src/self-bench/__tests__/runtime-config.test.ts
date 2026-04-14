import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getRuntimeConfig,
  setRuntimeConfig,
  deleteRuntimeConfig,
  refreshRuntimeConfigCache,
  getRuntimeConfigCacheSnapshot,
  _resetRuntimeConfigCacheForTests,
} from '../runtime-config.js';

/**
 * DB stub that supports the runtime-config store's surface:
 *   .from('runtime_config_overrides').select('*')
 *   .from('runtime_config_overrides').insert(row)
 *   .from('runtime_config_overrides').delete().eq('key', val)
 */
function buildDb() {
  const rows: Array<Record<string, unknown>> = [];

  function makeBuilder() {
    const filters: Array<{ col: string; val: unknown }> = [];

    const apply = () =>
      rows.filter((r) => filters.every((f) => r[f.col] === f.val));

    const builder: Record<string, unknown> = {};
    builder.select = () => ({
      then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }),
    });
    builder.eq = (col: string, val: unknown) => { filters.push({ col, val }); return builder; };
    builder.insert = (row: Record<string, unknown>) => {
      rows.push({ ...row });
      return Promise.resolve({ data: null, error: null });
    };
    builder.delete = () => ({
      eq: (col: string, val: unknown) => {
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i][col] === val) rows.splice(i, 1);
        }
        return { then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }) };
      },
    });
    return builder;
  }

  return {
    db: { from: vi.fn().mockImplementation(() => makeBuilder()) },
    rows,
  };
}

describe('getRuntimeConfig', () => {
  beforeEach(() => _resetRuntimeConfigCacheForTests());

  it('returns the fallback when cache is empty', () => {
    expect(getRuntimeConfig('missing.key', 42)).toBe(42);
    expect(getRuntimeConfig('other.key', 'default')).toBe('default');
  });

  it('returns the cached value when present', async () => {
    const env = buildDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await setRuntimeConfig(env.db as any, 'feature.flag', true);
    expect(getRuntimeConfig<boolean>('feature.flag', false)).toBe(true);
  });

  it('accepts complex values (objects, arrays)', async () => {
    const env = buildDb();
    const payload = { foo: [1, 2, 3], bar: { nested: 'value' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await setRuntimeConfig(env.db as any, 'feature.config', payload);
    expect(getRuntimeConfig<typeof payload>('feature.config', { foo: [], bar: { nested: '' } }))
      .toEqual(payload);
  });
});

describe('setRuntimeConfig', () => {
  beforeEach(() => _resetRuntimeConfigCacheForTests());

  it('inserts a row and updates the cache atomically', async () => {
    const env = buildDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await setRuntimeConfig(env.db as any, 'key.x', 'value1', {
      setBy: 'exp-1',
      findingId: 'finding-123',
    });
    expect(env.rows).toHaveLength(1);
    const row = env.rows[0];
    expect(row.key).toBe('key.x');
    expect(JSON.parse(row.value as string)).toBe('value1');
    expect(row.set_by).toBe('exp-1');
    expect(row.finding_id).toBe('finding-123');
    // Cache should have the value immediately.
    expect(getRuntimeConfig('key.x', 'default')).toBe('value1');
  });

  it('overwrites an existing key (delete + insert)', async () => {
    const env = buildDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = env.db as any;
    await setRuntimeConfig(db, 'key.x', 'first');
    await setRuntimeConfig(db, 'key.x', 'second');
    expect(env.rows).toHaveLength(1);
    expect(JSON.parse(env.rows[0].value as string)).toBe('second');
    expect(getRuntimeConfig('key.x', 'default')).toBe('second');
  });

  it('populates set_by and finding_id as null when meta is omitted', async () => {
    const env = buildDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await setRuntimeConfig(env.db as any, 'key.x', 1);
    expect(env.rows[0].set_by).toBeNull();
    expect(env.rows[0].finding_id).toBeNull();
  });
});

describe('deleteRuntimeConfig', () => {
  beforeEach(() => _resetRuntimeConfigCacheForTests());

  it('removes a key from both DB and cache', async () => {
    const env = buildDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = env.db as any;
    await setRuntimeConfig(db, 'key.x', 'value');
    expect(getRuntimeConfig('key.x', null)).toBe('value');
    await deleteRuntimeConfig(db, 'key.x');
    expect(env.rows).toHaveLength(0);
    expect(getRuntimeConfig('key.x', 'fallback')).toBe('fallback');
  });

  it('is a no-op on a missing key', async () => {
    const env = buildDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await deleteRuntimeConfig(env.db as any, 'does.not.exist');
    expect(env.rows).toHaveLength(0);
  });
});

describe('refreshRuntimeConfigCache', () => {
  beforeEach(() => _resetRuntimeConfigCacheForTests());

  it('populates the cache from the DB on boot', async () => {
    const env = buildDb();
    env.rows.push(
      { key: 'a', value: '"hello"', set_by: 'e1', finding_id: 'f1', set_at: '2026-04-14T10:00:00Z' },
      { key: 'b', value: '42', set_by: null, finding_id: null, set_at: '2026-04-14T10:01:00Z' },
      { key: 'c', value: JSON.stringify({ nested: true }), set_by: 'e2', finding_id: null, set_at: '2026-04-14T10:02:00Z' },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await refreshRuntimeConfigCache(env.db as any);
    expect(getRuntimeConfig('a', '')).toBe('hello');
    expect(getRuntimeConfig('b', 0)).toBe(42);
    expect(getRuntimeConfig<{ nested: boolean }>('c', { nested: false })).toEqual({ nested: true });
  });

  it('accepts rows where value is already a parsed object (adapter shape variance)', async () => {
    const env = buildDb();
    // Simulate a DB adapter that returns TEXT JSON pre-parsed.
    env.rows.push(
      { key: 'a', value: { already: 'parsed' }, set_by: null, finding_id: null, set_at: '2026-04-14T10:00:00Z' },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await refreshRuntimeConfigCache(env.db as any);
    expect(getRuntimeConfig('a', null)).toEqual({ already: 'parsed' });
  });

  it('atomic swap: a refresh with fewer rows clears removed entries', async () => {
    const env = buildDb();
    // First refresh with two rows
    env.rows.push(
      { key: 'a', value: '"one"', set_by: null, finding_id: null, set_at: '2026-04-14T10:00:00Z' },
      { key: 'b', value: '"two"', set_by: null, finding_id: null, set_at: '2026-04-14T10:01:00Z' },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await refreshRuntimeConfigCache(env.db as any);
    expect(getRuntimeConfig('a', null)).toBe('one');
    expect(getRuntimeConfig('b', null)).toBe('two');

    // Remove b from the DB and refresh — cache should lose b.
    env.rows.splice(1, 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await refreshRuntimeConfigCache(env.db as any);
    expect(getRuntimeConfig('a', null)).toBe('one');
    expect(getRuntimeConfig('b', 'fallback')).toBe('fallback');
  });

  it('falls back gracefully on corrupt JSON rows', async () => {
    const env = buildDb();
    env.rows.push(
      { key: 'bad', value: '{ not valid', set_by: null, finding_id: null, set_at: '2026-04-14T10:00:00Z' },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await refreshRuntimeConfigCache(env.db as any);
    // Falls back to raw string when parse fails — not the fallback
    // from getRuntimeConfig, because the cache DID have an entry.
    expect(getRuntimeConfig('bad', 'nope')).toBe('{ not valid');
  });
});

describe('getRuntimeConfigCacheSnapshot', () => {
  beforeEach(() => _resetRuntimeConfigCacheForTests());

  it('returns every cached entry with metadata', async () => {
    const env = buildDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = env.db as any;
    await setRuntimeConfig(db, 'a.b', 1, { setBy: 'exp-1', findingId: 'f1' });
    await setRuntimeConfig(db, 'c.d', 'two', { setBy: 'exp-2' });
    const snap = getRuntimeConfigCacheSnapshot();
    expect(snap).toHaveLength(2);
    const a = snap.find((s) => s.key === 'a.b');
    const c = snap.find((s) => s.key === 'c.d');
    expect(a?.value).toBe(1);
    expect(a?.setBy).toBe('exp-1');
    expect(a?.findingId).toBe('f1');
    expect(c?.value).toBe('two');
    expect(c?.setBy).toBe('exp-2');
    expect(c?.findingId).toBeNull();
  });
});
