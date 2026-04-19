/**
 * SYNC_REGISTRY shape pin.
 *
 * Trio 2 of the 5-trio sync arc (2026-04-18) introduced the runtime →
 * cloud bulk-sync registry powering scripts/sync-runtime-to-cloud.ts.
 * Trios 3-4 will append more entries (autonomy retrofit + x-intel +
 * content engine). This test is a static safety pin that catches
 * accidental shape regressions or duplicate registrations BEFORE the
 * sync script blows up at runtime against a live database.
 *
 * Invariants enforced:
 *   - Registry is non-empty.
 *   - Every entry has non-empty `table` + `primaryKey` + `columns`.
 *   - The `primaryKey` of each entry is one of its `columns` (otherwise
 *     the upsert ON CONFLICT clause references a column the SELECT will
 *     never project).
 *   - `isWorkspaceScoped` is a boolean (TS catches this at compile time
 *     but a runtime check guards against `as any` future drift).
 *   - `getSpec(entry.table)` round-trips for every registered entry.
 *   - `getSpec('nonexistent_xyz')` returns `undefined`.
 *   - No two entries share the same `table` value (catches accidental
 *     duplication when Trios 3-4 append more sync targets — copy-paste
 *     a row, forget to rename it, this test fires).
 */

import { describe, expect, it } from 'vitest';
import { SYNC_REGISTRY, getSpec } from '../registry.js';

describe('SYNC_REGISTRY shape', () => {
  it('is non-empty', () => {
    expect(SYNC_REGISTRY.length).toBeGreaterThan(0);
  });

  it('every entry has a non-empty table name', () => {
    for (const entry of SYNC_REGISTRY) {
      expect(typeof entry.table).toBe('string');
      expect(entry.table.length).toBeGreaterThan(0);
    }
  });

  it('every entry has a non-empty primaryKey', () => {
    for (const entry of SYNC_REGISTRY) {
      expect(typeof entry.primaryKey).toBe('string');
      expect(entry.primaryKey.length).toBeGreaterThan(0);
    }
  });

  it('every entry has a non-empty columns array containing its primaryKey', () => {
    for (const entry of SYNC_REGISTRY) {
      expect(Array.isArray(entry.columns)).toBe(true);
      expect(entry.columns.length).toBeGreaterThan(0);
      expect(entry.columns).toContain(entry.primaryKey);
    }
  });

  it('every entry sets isWorkspaceScoped to a boolean', () => {
    for (const entry of SYNC_REGISTRY) {
      expect(typeof entry.isWorkspaceScoped).toBe('boolean');
    }
  });

  it('getSpec round-trips every registered entry', () => {
    for (const entry of SYNC_REGISTRY) {
      const found = getSpec(entry.table);
      expect(found).toBeDefined();
      expect(found?.table).toBe(entry.table);
      expect(found?.primaryKey).toBe(entry.primaryKey);
    }
  });

  it('getSpec returns undefined for an unregistered name', () => {
    expect(getSpec('nonexistent_xyz')).toBeUndefined();
  });

  it('no two entries share the same table value', () => {
    const tables = SYNC_REGISTRY.map((s) => s.table);
    const unique = new Set(tables);
    expect(unique.size).toBe(tables.length);
  });
});
