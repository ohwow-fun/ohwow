import { describe, it, expect } from 'vitest';
import {
  getNestedValue,
  resolveFieldMapping,
  extractLeafPaths,
  resolveTemplate,
  resolveContextTemplate,
  resolveContextFieldMapping,
} from '../field-mapper.js';

describe('getNestedValue', () => {
  it('returns top-level value', () => {
    expect(getNestedValue({ name: 'Alice' }, 'name')).toBe('Alice');
  });

  it('returns nested value via dot notation', () => {
    expect(getNestedValue({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('returns undefined for missing path', () => {
    expect(getNestedValue({ a: 1 }, 'b')).toBeUndefined();
  });

  it('returns undefined for path through non-object', () => {
    expect(getNestedValue({ a: 'string' }, 'a.b')).toBeUndefined();
  });

  it('returns undefined for path through null', () => {
    expect(getNestedValue({ a: null } as Record<string, unknown>, 'a.b')).toBeUndefined();
  });

  it('resolves array index paths like items.0.id', () => {
    const obj = { items: [{ id: 'first' }, { id: 'second' }] };
    expect(getNestedValue(obj, 'items.0.id')).toBe('first');
    expect(getNestedValue(obj, 'items.1.id')).toBe('second');
  });

  it('traverses __proto__ (JS behavior: objects have prototype chain)', () => {
    const obj = { safe: 'value' };
    // getNestedValue does plain property access, so __proto__ resolves
    // This documents the behavior — not a security issue since this is read-only
    expect(getNestedValue(obj, '__proto__')).toBeDefined();
  });
});

describe('resolveFieldMapping', () => {
  it('maps source paths to target fields', () => {
    const data = { user: { name: 'Bob', email: 'bob@test.com' } };
    const mapping = { contactName: 'user.name', contactEmail: 'user.email' };
    expect(resolveFieldMapping(data, mapping)).toEqual({
      contactName: 'Bob',
      contactEmail: 'bob@test.com',
    });
  });

  it('omits undefined source paths', () => {
    const data = { user: { name: 'Bob' } };
    const mapping = { contactName: 'user.name', missing: 'user.phone' };
    expect(resolveFieldMapping(data, mapping)).toEqual({ contactName: 'Bob' });
  });

  it('returns empty object for empty mapping', () => {
    expect(resolveFieldMapping({ a: 1 }, {})).toEqual({});
  });
});

describe('extractLeafPaths', () => {
  it('returns leaf keys for flat object', () => {
    expect(extractLeafPaths({ a: 1, b: 'two' })).toEqual(['a', 'b']);
  });

  it('returns dot-notation paths for nested objects', () => {
    expect(extractLeafPaths({ a: { b: 'c' } })).toEqual(['a.b']);
  });

  it('includes array path and first element paths', () => {
    const paths = extractLeafPaths({ items: [{ id: 1 }] });
    expect(paths).toContain('items');
    expect(paths).toContain('items.0.id');
  });

  it('returns empty array for null', () => {
    expect(extractLeafPaths(null)).toEqual([]);
  });

  it('returns empty array for undefined', () => {
    expect(extractLeafPaths(undefined)).toEqual([]);
  });

  it('respects maxDepth', () => {
    const paths = extractLeafPaths({ a: { b: { c: { d: 'deep' } } } }, '', 2);
    // At depth 2, should not descend all the way to d
    expect(paths).not.toContain('a.b.c.d');
  });

  it('handles empty object', () => {
    expect(extractLeafPaths({})).toEqual([]);
  });

  it('verifies maxDepth stops descending at the limit', () => {
    // maxDepth=2: can enter 2 levels. { a: { b: { c: 'deep' } } }
    // Level 1: enter obj, iterate 'a' → object, recurse with maxDepth=1
    // Level 2: enter 'a', iterate 'b' → object, recurse with maxDepth=0 → returns []
    // So 'a.b.c' should NOT be included
    const paths2 = extractLeafPaths({ a: { b: { c: 'deep' } } }, '', 2);
    expect(paths2).not.toContain('a.b.c');

    // With maxDepth=3, it should reach 'a.b.c'
    const paths3 = extractLeafPaths({ a: { b: { c: 'deep' } } }, '', 3);
    expect(paths3).toContain('a.b.c');
  });
});

describe('resolveTemplate', () => {
  it('replaces {{data.path}} with values', () => {
    const result = resolveTemplate('Hello {{data.name}}!', { name: 'World' });
    expect(result).toBe('Hello World!');
  });

  it('replaces nested paths', () => {
    const result = resolveTemplate('{{data.user.email}}', { user: { email: 'a@b.com' } });
    expect(result).toBe('a@b.com');
  });

  it('replaces unknown paths with empty string', () => {
    const result = resolveTemplate('Hi {{data.missing}}!', {});
    expect(result).toBe('Hi !');
  });

  it('handles multiple placeholders', () => {
    const result = resolveTemplate('{{data.first}} {{data.last}}', { first: 'John', last: 'Doe' });
    expect(result).toBe('John Doe');
  });

  it('passes through strings without templates', () => {
    expect(resolveTemplate('no templates here', { a: 1 })).toBe('no templates here');
  });
});

describe('resolveContextTemplate', () => {
  it('resolves {{trigger.field}} from context', () => {
    const context = { trigger: { email: 'test@test.com' } };
    expect(resolveContextTemplate('{{trigger.email}}', context)).toBe('test@test.com');
  });

  it('resolves {{step_1.field}} from context', () => {
    const context = { step_1: { result: 'done' } };
    expect(resolveContextTemplate('Got: {{step_1.result}}', context)).toBe('Got: done');
  });

  it('resolves legacy {{data.field}} via trigger context', () => {
    const context = { trigger: { name: 'Alice' } };
    expect(resolveContextTemplate('{{data.name}}', context)).toBe('Alice');
  });

  it('returns empty string for missing step', () => {
    expect(resolveContextTemplate('{{step_99.field}}', {})).toBe('');
  });

  it('returns empty string for path without dot', () => {
    expect(resolveContextTemplate('{{nodot}}', { nodot: { x: 1 } })).toBe('');
  });
});

describe('resolveContextFieldMapping', () => {
  it('resolves dot-path mappings from context', () => {
    const context = { trigger: { email: 'a@b.com', name: 'Alice' } };
    const mapping = { contactEmail: 'trigger.email', contactName: 'trigger.name' };
    expect(resolveContextFieldMapping(context, mapping)).toEqual({
      contactEmail: 'a@b.com',
      contactName: 'Alice',
    });
  });

  it('resolves template strings in values', () => {
    const context = { trigger: { first: 'John', last: 'Doe' } };
    const mapping = { fullName: '{{trigger.first}} {{trigger.last}}' };
    expect(resolveContextFieldMapping(context, mapping)).toEqual({
      fullName: 'John Doe',
    });
  });

  it('skips paths without dots', () => {
    const result = resolveContextFieldMapping({}, { key: 'nodot' });
    expect(result).toEqual({});
  });

  it('skips paths to missing steps', () => {
    const result = resolveContextFieldMapping({}, { key: 'step_1.field' });
    expect(result).toEqual({});
  });

  it('skips paths where value is undefined', () => {
    const context = { trigger: { a: 1 } };
    const result = resolveContextFieldMapping(context, { key: 'trigger.missing' });
    expect(result).toEqual({});
  });

  it('resolves mixed template and direct path in same mapping', () => {
    const context = { trigger: { first: 'John', email: 'john@example.com' } };
    const mapping = {
      greeting: '{{trigger.first}} welcome!',
      contactEmail: 'trigger.email',
    };
    const result = resolveContextFieldMapping(context, mapping);
    expect(result).toEqual({
      greeting: 'John welcome!',
      contactEmail: 'john@example.com',
    });
  });
});
