import { describe, it, expect } from 'vitest';
import { SavepointStore } from '../savepoint-store.js';
import type { SavepointData } from '../savepoint-store.js';

function makeData(iteration: number): SavepointData {
  return {
    messages: [],
    iteration,
    toolCallHashes: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };
}

describe('SavepointStore', () => {
  it('create() stores a savepoint retrievable via has() and list()', () => {
    const store = new SavepointStore();
    const data = makeData(1);
    store.create('checkpoint-1', 'first save', data);

    expect(store.has('checkpoint-1')).toBe(true);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('checkpoint-1');
    expect(list[0].reason).toBe('first save');
    expect(list[0].iteration).toBe(1);
  });

  it('rollbackTo() returns a deep copy of the saved data (mutations to result don\'t affect stored copy)', () => {
    const store = new SavepointStore();
    const originalData = makeData(2);
    originalData.messages = [{ role: 'user', content: 'hello' }];
    originalData.toolCallHashes = ['hash1', 'hash2'];
    originalData.totalInputTokens = 100;
    originalData.totalOutputTokens = 50;

    store.create('checkpoint-1', 'save with data', originalData);

    const retrieved = store.rollbackTo('checkpoint-1');
    expect(retrieved).not.toBeNull();
    if (retrieved) {
      // Mutate the retrieved data
      retrieved.messages.push({ role: 'assistant', content: 'hi' });
      retrieved.toolCallHashes.push('hash3');
      retrieved.totalInputTokens = 999;
      retrieved.totalOutputTokens = 999;

      // Retrieve again and verify original is unchanged
      const retrieved2 = store.rollbackTo('checkpoint-1');
      expect(retrieved2?.messages).toHaveLength(1);
      expect(retrieved2?.toolCallHashes).toHaveLength(2);
      expect(retrieved2?.totalInputTokens).toBe(100);
      expect(retrieved2?.totalOutputTokens).toBe(50);
    }
  });

  it('rollbackTo() returns null for an unknown savepoint name', () => {
    const store = new SavepointStore();
    const result = store.rollbackTo('non-existent');
    expect(result).toBeNull();
  });

  it('list() returns savepoints in insertion order', () => {
    const store = new SavepointStore();
    store.create('first', 'reason1', makeData(1));
    store.create('second', 'reason2', makeData(2));
    store.create('third', 'reason3', makeData(3));

    const list = store.list();
    expect(list).toHaveLength(3);
    expect(list[0].name).toBe('first');
    expect(list[1].name).toBe('second');
    expect(list[2].name).toBe('third');
  });

  it('ring buffer: when the store is at maxSavepoints and a new name is added, the oldest is evicted', () => {
    const store = new SavepointStore(3); // Small ring buffer for testing
    store.create('a', 'reason-a', makeData(1));
    store.create('b', 'reason-b', makeData(2));
    store.create('c', 'reason-c', makeData(3));

    expect(store.size).toBe(3);
    expect(store.has('a')).toBe(true);
    expect(store.has('b')).toBe(true);
    expect(store.has('c')).toBe(true);

    // Add a new savepoint when at max capacity
    store.create('d', 'reason-d', makeData(4));

    // The oldest ('a') should be evicted
    expect(store.size).toBe(3);
    expect(store.has('a')).toBe(false);
    expect(store.has('b')).toBe(true);
    expect(store.has('c')).toBe(true);
    expect(store.has('d')).toBe(true);

    const list = store.list();
    expect(list).toHaveLength(3);
    expect(list[0].name).toBe('b');
    expect(list[1].name).toBe('c');
    expect(list[2].name).toBe('d');
  });

  it('overwriting an existing name: size stays the same; list() puts it at the end (re-ordered to back of insertion order); rollbackTo returns the new data', () => {
    const store = new SavepointStore(5);
    store.create('a', 'reason-a', makeData(1));
    store.create('b', 'reason-b', makeData(2));
    store.create('c', 'reason-c', makeData(3));

    expect(store.size).toBe(3);
    let list = store.list();
    expect(list.map((x) => x.name)).toEqual(['a', 'b', 'c']);

    // Overwrite 'b' with new data
    const newData = makeData(22);
    newData.totalInputTokens = 999;
    store.create('b', 'reason-b-updated', newData);

    // Size should stay the same
    expect(store.size).toBe(3);

    // 'b' should be moved to the end of list
    list = store.list();
    expect(list.map((x) => x.name)).toEqual(['a', 'c', 'b']);
    expect(list[2].reason).toBe('reason-b-updated');

    // rollbackTo should return the new data
    const rolled = store.rollbackTo('b');
    expect(rolled?.iteration).toBe(22);
    expect(rolled?.totalInputTokens).toBe(999);
  });

  it('get size property reflects the current count', () => {
    const store = new SavepointStore();
    expect(store.size).toBe(0);

    store.create('one', 'r1', makeData(1));
    expect(store.size).toBe(1);

    store.create('two', 'r2', makeData(2));
    expect(store.size).toBe(2);

    store.create('three', 'r3', makeData(3));
    expect(store.size).toBe(3);

    // Overwrite should not change size
    store.create('one', 'r1-updated', makeData(1));
    expect(store.size).toBe(3);
  });

  it('an empty store has size === 0 and list() returns []', () => {
    const store = new SavepointStore();
    expect(store.size).toBe(0);
    expect(store.list()).toEqual([]);
  });
});
