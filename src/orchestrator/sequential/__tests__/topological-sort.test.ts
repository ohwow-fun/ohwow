import { describe, it, expect } from 'vitest';
import { topologicalSort, type Sortable } from '../topological-sort.js';

describe('topologicalSort', () => {
  it('returns empty array for empty input', () => {
    expect(topologicalSort([])).toEqual([]);
  });

  it('puts single item in one wave', () => {
    const items: Sortable[] = [{ id: 'a', dependsOn: [] }];
    const waves = topologicalSort(items);
    expect(waves).toEqual([[{ id: 'a', dependsOn: [] }]]);
  });

  it('sorts a linear chain into separate waves', () => {
    const items: Sortable[] = [
      { id: 'c', dependsOn: ['b'] },
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
    ];
    const waves = topologicalSort(items);
    expect(waves.length).toBe(3);
    expect(waves[0].map((i) => i.id)).toEqual(['a']);
    expect(waves[1].map((i) => i.id)).toEqual(['b']);
    expect(waves[2].map((i) => i.id)).toEqual(['c']);
  });

  it('groups independent items into the same wave', () => {
    const items: Sortable[] = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: [] },
      { id: 'c', dependsOn: ['a', 'b'] },
    ];
    const waves = topologicalSort(items);
    expect(waves.length).toBe(2);
    expect(waves[0].map((i) => i.id).sort()).toEqual(['a', 'b']);
    expect(waves[1].map((i) => i.id)).toEqual(['c']);
  });

  it('handles diamond dependencies', () => {
    // a -> b, a -> c, b -> d, c -> d
    const items: Sortable[] = [
      { id: 'd', dependsOn: ['b', 'c'] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
      { id: 'a', dependsOn: [] },
    ];
    const waves = topologicalSort(items);
    expect(waves.length).toBe(3);
    expect(waves[0].map((i) => i.id)).toEqual(['a']);
    expect(waves[1].map((i) => i.id).sort()).toEqual(['b', 'c']);
    expect(waves[2].map((i) => i.id)).toEqual(['d']);
  });

  it('breaks circular dependencies by putting remaining in final wave', () => {
    const items: Sortable[] = [
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['a'] },
    ];
    const waves = topologicalSort(items);
    // Should have exactly one wave with both items (cycle broken)
    expect(waves.length).toBe(1);
    expect(waves[0].map((i) => i.id).sort()).toEqual(['a', 'b']);
  });

  it('handles mixed independent and dependent items', () => {
    const items: Sortable[] = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: [] },
      { id: 'c', dependsOn: ['a'] },
      { id: 'd', dependsOn: ['b'] },
      { id: 'e', dependsOn: ['c', 'd'] },
    ];
    const waves = topologicalSort(items);
    expect(waves.length).toBe(3);
    expect(waves[0].map((i) => i.id).sort()).toEqual(['a', 'b']);
    expect(waves[1].map((i) => i.id).sort()).toEqual(['c', 'd']);
    expect(waves[2].map((i) => i.id)).toEqual(['e']);
  });
});
