import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeStateTool, loadStateContext } from '../state/state-executor.js';
import { isStateTool } from '../state/state-tools.js';

// In-memory mock database
function createMockDb() {
  const store = new Map<string, Record<string, unknown>>();

  const makeQuery = (table: string) => {
    const state = {
      _table: table,
      _filters: [] as Array<{ field: string; op: string; value: unknown }>,
      _orderField: null as string | null,
      _orderAsc: true,
      _limitVal: null as number | null,
      _selectFields: '*',
      _insertData: null as Record<string, unknown> | null,
      _updateData: null as Record<string, unknown> | null,
      _isDelete: false,
      _isSingle: false,
      _isMaybeSingle: false,
    };

    function matchesFilters(row: Record<string, unknown>): boolean {
      return state._filters.every(f => {
        if (f.op === 'eq') return row[f.field] === f.value;
        if (f.op === 'is') return row[f.field] === f.value;
        if (f.op === 'gte') return String(row[f.field]) >= String(f.value);
        return true;
      });
    }

    function getRows(): Record<string, unknown>[] {
      return Array.from(store.values()).filter(r => r._table === table).filter(matchesFilters);
    }

    const builder = {
      select(fields?: string, _opts?: Record<string, unknown>) {
        state._selectFields = fields || '*';
        return builder;
      },
      insert(data: Record<string, unknown>) {
        state._insertData = data;
        const id = (data.id as string) || `id-${store.size}`;
        const row = { ...data, _table: table, id };
        store.set(id, row);
        return builder;
      },
      update(data: Record<string, unknown>) {
        state._updateData = data;
        return builder;
      },
      delete() {
        state._isDelete = true;
        return builder;
      },
      eq(field: string, value: unknown) {
        state._filters.push({ field, op: 'eq', value });
        // Execute update/delete immediately when chained
        if (state._updateData) {
          for (const row of getRows()) {
            Object.assign(row, state._updateData);
          }
        }
        if (state._isDelete) {
          for (const row of getRows()) {
            store.delete(row.id as string);
          }
        }
        return builder;
      },
      is(field: string, value: unknown) {
        state._filters.push({ field, op: 'is', value });
        return builder;
      },
      gte(field: string, value: unknown) {
        state._filters.push({ field, op: 'gte', value });
        return builder;
      },
      order(_field: string, _opts?: { ascending?: boolean }) {
        state._orderField = _field;
        state._orderAsc = _opts?.ascending ?? true;
        return builder;
      },
      limit(n: number) {
        state._limitVal = n;
        return builder;
      },
      single() {
        state._isSingle = true;
        return builder;
      },
      maybeSingle() {
        state._isMaybeSingle = true;
        return builder;
      },
      then(resolve: (val: { data: unknown; error: null }) => void, reject?: (err: unknown) => void) {
        try {
          let rows = getRows();
          if (state._limitVal) rows = rows.slice(0, state._limitVal);

          if (state._isSingle || state._isMaybeSingle) {
            resolve({ data: rows[0] || null, error: null });
          } else {
            resolve({ data: rows, error: null });
          }
        } catch (err) {
          if (reject) reject(err);
        }
      },
    };

    return builder;
  };

  return {
    from: (_table: string) => {
      const q = makeQuery(_table);
      return {
        select: q.select,
        insert: q.insert,
        update: q.update,
        delete: q.delete,
      };
    },
    rpc: vi.fn(),
    _store: store,
    // Cast through unknown to satisfy TypeScript — this is a test mock
  } as unknown as import('../../db/adapter-types.js').DatabaseAdapter & { _store: Map<string, Record<string, unknown>> };
}

describe('isStateTool', () => {
  it('identifies state tool names', () => {
    expect(isStateTool('get_state')).toBe(true);
    expect(isStateTool('set_state')).toBe(true);
    expect(isStateTool('list_state')).toBe(true);
    expect(isStateTool('delete_state')).toBe(true);
    expect(isStateTool('web_search')).toBe(false);
    expect(isStateTool('local_read_file')).toBe(false);
  });
});

describe('executeStateTool', () => {
  const ctx = {
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    defaultGoalId: 'goal-1',
    db: null as unknown as import('../../db/adapter-types.js').DatabaseAdapter,
  };

  beforeEach(() => {
    ctx.db = createMockDb();
  });

  it('set_state then get_state returns the stored value', async () => {
    const setResult = await executeStateTool('set_state', { key: 'counter', value: 42 }, ctx);
    expect(setResult.is_error).toBeFalsy();
    const parsed = JSON.parse(setResult.content);
    expect(parsed.saved).toBe(true);
    expect(parsed.value).toBe(42);

    const getResult = await executeStateTool('get_state', { key: 'counter' }, ctx);
    expect(getResult.is_error).toBeFalsy();
    const getParsed = JSON.parse(getResult.content);
    expect(getParsed.exists).toBe(true);
    expect(getParsed.value).toBe(42);
  });

  it('get_state returns null for missing key', async () => {
    const result = await executeStateTool('get_state', { key: 'nonexistent' }, ctx);
    const parsed = JSON.parse(result.content);
    expect(parsed.exists).toBe(false);
    expect(parsed.value).toBe(null);
  });

  it('set_state updates existing value', async () => {
    await executeStateTool('set_state', { key: 'counter', value: 1 }, ctx);
    await executeStateTool('set_state', { key: 'counter', value: 2 }, ctx);

    const result = await executeStateTool('get_state', { key: 'counter' }, ctx);
    const parsed = JSON.parse(result.content);
    expect(parsed.value).toBe(2);
  });

  it('stores string values correctly', async () => {
    await executeStateTool('set_state', { key: 'name', value: 'hello world' }, ctx);
    const result = await executeStateTool('get_state', { key: 'name' }, ctx);
    const parsed = JSON.parse(result.content);
    expect(parsed.value).toBe('hello world');
  });

  it('stores object values as JSON', async () => {
    const data = { prices: [10, 20, 30], date: '2024-01-01' };
    await executeStateTool('set_state', { key: 'data', value: data }, ctx);
    const result = await executeStateTool('get_state', { key: 'data' }, ctx);
    const parsed = JSON.parse(result.content);
    expect(parsed.value).toEqual(data);
  });

  it('list_state shows all entries', async () => {
    await executeStateTool('set_state', { key: 'a', value: 1 }, ctx);
    await executeStateTool('set_state', { key: 'b', value: 2 }, ctx);

    const result = await executeStateTool('list_state', {}, ctx);
    const parsed = JSON.parse(result.content);
    expect(parsed.count).toBe(2);
    expect(parsed.entries.map((e: { key: string }) => e.key).sort()).toEqual(['a', 'b']);
  });

  it('delete_state removes a key', async () => {
    await executeStateTool('set_state', { key: 'tmp', value: 'x' }, ctx);
    const delResult = await executeStateTool('delete_state', { key: 'tmp' }, ctx);
    const delParsed = JSON.parse(delResult.content);
    expect(delParsed.deleted).toBe(true);

    const getResult = await executeStateTool('get_state', { key: 'tmp' }, ctx);
    const getParsed = JSON.parse(getResult.content);
    expect(getParsed.exists).toBe(false);
  });

  it('returns error for missing required fields', async () => {
    const result = await executeStateTool('get_state', {}, ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('key is required');
  });

  it('returns error for unknown tool', async () => {
    const result = await executeStateTool('unknown_state', { key: 'x' }, ctx);
    expect(result.is_error).toBe(true);
  });

  it('rejects values exceeding 64KB', async () => {
    const largeValue = 'x'.repeat(70_000);
    const result = await executeStateTool('set_state', { key: 'big', value: largeValue }, ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('exceeds maximum size');
  });

  it('rejects keys longer than 128 characters', async () => {
    const longKey = 'k'.repeat(200);
    const result = await executeStateTool('set_state', { key: longKey, value: 'v' }, ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('exceeds maximum length');
  });

  it('rejects when agent has 500 keys', async () => {
    // Prepopulate 500 keys directly in the mock store
    const mockDb = ctx.db as unknown as { _store: Map<string, Record<string, unknown>> };
    for (let i = 0; i < 500; i++) {
      mockDb._store.set(`state-${i}`, {
        _table: 'agent_workforce_task_state',
        id: `state-${i}`,
        workspace_id: ctx.workspaceId,
        agent_id: ctx.agentId,
        key: `key_${i}`,
        value: `${i}`,
        value_type: 'number',
        scope: 'agent',
        scope_id: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });
    }

    const result = await executeStateTool('set_state', { key: 'one_too_many', value: 1 }, ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('maximum of 500');
  });
});

describe('loadStateContext', () => {
  it('returns null when no state exists', async () => {
    const db = createMockDb();
    const result = await loadStateContext(db, 'ws-1', 'agent-1');
    expect(result).toBeNull();
  });

  it('formats state entries as markdown', async () => {
    const db = createMockDb();

    // Manually insert state entries
    (db as unknown as { _store: Map<string, Record<string, unknown>> })._store.set('s1', {
      _table: 'agent_workforce_task_state',
      id: 's1',
      workspace_id: 'ws-1',
      agent_id: 'agent-1',
      key: 'posts_completed',
      value: '12',
      value_type: 'number',
      scope: 'agent',
      scope_id: null,
      updated_at: '2024-01-01T00:00:00Z',
    });

    const result = await loadStateContext(db, 'ws-1', 'agent-1');
    expect(result).toContain('Persistent State');
    expect(result).toContain('posts_completed');
    expect(result).toContain('12');
  });
});
