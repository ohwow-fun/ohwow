import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolCache } from '../tool-cache.js';

describe('ToolCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns undefined for mutation tools (never cached)', () => {
    const cache = new ToolCache();
    cache.set('run_agent', { agent_id: 'a1' }, { success: true, data: 'ok' });
    expect(cache.get('run_agent', { agent_id: 'a1' })).toBeUndefined();
  });

  it('returns cached result for read-only tool within TTL', () => {
    const cache = new ToolCache();
    const result = { success: true as const, data: [{ id: '1' }] };
    cache.set('list_agents', { workspace: 'ws-1' }, result);

    const cached = cache.get('list_agents', { workspace: 'ws-1' });
    expect(cached).toEqual(result);
  });

  it('returns undefined after TTL expires', () => {
    const cache = new ToolCache();
    cache.set('list_agents', {}, { success: true, data: [] });

    // Advance past the 5-minute TTL
    vi.advanceTimersByTime(6 * 60 * 1000);

    expect(cache.get('list_agents', {})).toBeUndefined();
  });

  it('stores result for read-only tool', () => {
    const cache = new ToolCache();
    cache.set('list_tasks', { status: 'active' }, { success: true, data: ['task1'] });
    expect(cache.get('list_tasks', { status: 'active' })).toBeDefined();
  });

  it('does not store error results', () => {
    const cache = new ToolCache();
    cache.set('list_agents', {}, { success: false, error: 'DB error' });
    expect(cache.get('list_agents', {})).toBeUndefined();
  });

  it('triggers LRU eviction when maxSize exceeded', () => {
    const cache = new ToolCache({ maxSize: 2 });
    cache.set('list_agents', { a: 1 }, { success: true, data: 'first' });
    vi.advanceTimersByTime(10);
    cache.set('list_agents', { a: 2 }, { success: true, data: 'second' });

    // Access first to make it more recent than second
    vi.advanceTimersByTime(10);
    cache.get('list_agents', { a: 1 });

    // Add third item, should evict the LRU (second, since first was just accessed)
    vi.advanceTimersByTime(10);
    cache.set('list_agents', { a: 3 }, { success: true, data: 'third' });

    expect(cache.get('list_agents', { a: 1 })).toBeDefined();
    expect(cache.get('list_agents', { a: 2 })).toBeUndefined();
    expect(cache.get('list_agents', { a: 3 })).toBeDefined();
  });

  it('invalidates related caches when mutation tool is set', () => {
    const cache = new ToolCache();
    cache.set('list_tasks', {}, { success: true, data: ['task1'] });
    cache.set('get_task_detail', { id: 't1' }, { success: true, data: { id: 't1' } });

    // approve_task should invalidate list_tasks and get_task_detail
    cache.set('approve_task', { task_id: 't1' }, { success: true, data: 'approved' });

    expect(cache.get('list_tasks', {})).toBeUndefined();
    expect(cache.get('get_task_detail', { id: 't1' })).toBeUndefined();
  });

  it('caches MCP tool with readOnlyHint annotation', () => {
    const annotations = new Map([['mcp__custom__read_data', { readOnlyHint: true }]]);
    const cache = new ToolCache({ mcpAnnotations: annotations });

    cache.set('mcp__custom__read_data', { q: 'test' }, { success: true, data: 'result' });
    expect(cache.get('mcp__custom__read_data', { q: 'test' })).toBeDefined();
  });

  it('builds stable keys regardless of property order', () => {
    const cache = new ToolCache();
    cache.set('list_agents', { b: 2, a: 1 }, { success: true, data: 'result' });

    const cached = cache.get('list_agents', { a: 1, b: 2 });
    expect(cached).toBeDefined();
    expect(cached!.data).toBe('result');
  });

  it('getStats returns correct hit/miss/size counts', () => {
    const cache = new ToolCache();
    cache.set('list_agents', {}, { success: true, data: [] });

    cache.get('list_agents', {}); // hit
    cache.get('list_tasks', {}); // miss
    cache.get('run_agent', {}); // miss (mutation)

    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(2);
    expect(stats.size).toBe(1);
  });

  it('clear resets everything', () => {
    const cache = new ToolCache();
    cache.set('list_agents', {}, { success: true, data: [] });
    cache.set('list_tasks', {}, { success: true, data: [] });

    cache.clear();

    expect(cache.get('list_agents', {})).toBeUndefined();
    expect(cache.getStats().size).toBe(0);
  });

  it('does not cache tools not in read-only set without MCP annotation', () => {
    const cache = new ToolCache();
    cache.set('some_random_tool', {}, { success: true, data: 'result' });
    expect(cache.get('some_random_tool', {})).toBeUndefined();
  });
});
