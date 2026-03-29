import { describe, it, expect } from 'vitest';
import { resolveContextValue, resolveMapping, applyTransform, evaluateCondition } from '../action-utils.js';
import type { ExecutionContext } from '../automation-types.js';

describe('resolveContextValue', () => {
  const context: ExecutionContext = {
    trigger: { email: 'john@test.com', name: 'John', nested: { city: 'NYC' } },
    step_1: { contact_id: 'abc123', status: 'created' },
  };

  it('resolves dotted path from trigger', () => {
    expect(resolveContextValue('trigger.email', context)).toBe('john@test.com');
  });

  it('resolves dotted path from step output', () => {
    expect(resolveContextValue('step_1.contact_id', context)).toBe('abc123');
  });

  it('resolves nested path', () => {
    expect(resolveContextValue('trigger.nested.city', context)).toBe('NYC');
  });

  it('falls back to trigger data for plain path', () => {
    expect(resolveContextValue('email', context)).toBe('john@test.com');
  });

  it('returns undefined for missing path', () => {
    expect(resolveContextValue('trigger.missing', context)).toBeUndefined();
  });
});

describe('resolveMapping', () => {
  const context: ExecutionContext = {
    trigger: { email: 'john@test.com', name: 'John' },
    step_1: { contact_id: 'abc123' },
  };

  it('resolves context-aware mappings', () => {
    const result = resolveMapping(
      { email: 'trigger.email', id: 'step_1.contact_id' },
      context,
    );
    expect(result).toEqual({ email: 'john@test.com', id: 'abc123' });
  });

  it('resolves legacy mappings against trigger data', () => {
    const result = resolveMapping({ email: 'email', name: 'name' }, context);
    expect(result).toEqual({ email: 'john@test.com', name: 'John' });
  });
});

describe('applyTransform', () => {
  it('uppercases a string', () => {
    expect(applyTransform('hello', 'uppercase')).toBe('HELLO');
  });

  it('lowercases a string', () => {
    expect(applyTransform('HELLO', 'lowercase')).toBe('hello');
  });

  it('trims whitespace', () => {
    expect(applyTransform('  hello  ', 'trim')).toBe('hello');
  });

  it('converts to number', () => {
    expect(applyTransform('42', 'to_number')).toBe(42);
  });

  it('converts to string', () => {
    expect(applyTransform(42, 'to_string')).toBe('42');
  });

  it('parses JSON', () => {
    expect(applyTransform('{"a":1}', 'json_parse')).toEqual({ a: 1 });
  });

  it('returns original on invalid JSON', () => {
    expect(applyTransform('not json', 'json_parse')).toBe('not json');
  });

  it('returns original for unknown transform', () => {
    expect(applyTransform('hello', 'unknown')).toBe('hello');
  });
});

describe('evaluateCondition', () => {
  it('equals', () => {
    expect(evaluateCondition('hello', 'equals', 'hello')).toBe(true);
    expect(evaluateCondition('hello', 'equals', 'world')).toBe(false);
  });

  it('not_equals', () => {
    expect(evaluateCondition('hello', 'not_equals', 'world')).toBe(true);
    expect(evaluateCondition('hello', 'not_equals', 'hello')).toBe(false);
  });

  it('contains', () => {
    expect(evaluateCondition('hello world', 'contains', 'world')).toBe(true);
    expect(evaluateCondition('hello', 'contains', 'world')).toBe(false);
  });

  it('not_contains', () => {
    expect(evaluateCondition('hello', 'not_contains', 'world')).toBe(true);
  });

  it('greater_than / less_than', () => {
    expect(evaluateCondition('10', 'greater_than', '5')).toBe(true);
    expect(evaluateCondition('3', 'less_than', '5')).toBe(true);
  });

  it('exists / not_exists', () => {
    expect(evaluateCondition('hello', 'exists')).toBe(true);
    expect(evaluateCondition(null, 'exists')).toBe(false);
    expect(evaluateCondition('', 'exists')).toBe(false);
    expect(evaluateCondition(undefined, 'not_exists')).toBe(true);
    expect(evaluateCondition('hello', 'not_exists')).toBe(false);
  });

  it('unknown operator returns false', () => {
    expect(evaluateCondition('hello', 'unknown_op')).toBe(false);
  });
});
