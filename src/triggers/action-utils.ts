/**
 * Action Utilities
 *
 * Shared helper functions extracted from ActionExecutor for use
 * by individual action dispatchers.
 */

import type { ExecutionContext } from './automation-types.js';
import {
  getNestedValue,
  resolveFieldMapping,
  resolveContextTemplate,
  resolveContextFieldMapping,
} from './field-mapper.js';

/**
 * Resolve a dot-path value from context.
 * Supports "trigger.email", "step_1.contact_id" patterns.
 * Falls back to legacy plain path resolution against trigger data.
 */
export function resolveContextValue(path: string, context: ExecutionContext): unknown {
  const dotIndex = path.indexOf('.');
  if (dotIndex !== -1) {
    const stepId = path.slice(0, dotIndex);
    const fieldPath = path.slice(dotIndex + 1);

    if (context[stepId]) {
      return getNestedValue(context[stepId], fieldPath);
    }
  }

  // Legacy fallback: plain path resolves against trigger data
  return getNestedValue(context.trigger, path);
}

/**
 * Resolve a field mapping using context-aware paths.
 * If mapping values contain "trigger." or "step_N." prefixes, use context resolution.
 * Otherwise, falls back to legacy resolution against trigger data.
 */
export function resolveMapping(
  mapping: Record<string, string>,
  context: ExecutionContext,
): Record<string, unknown> {
  const hasContextPaths = Object.values(mapping).some(
    (v) => v.startsWith('trigger.') || v.startsWith('step_') || v.includes('{{')
  );

  if (hasContextPaths) {
    return resolveContextFieldMapping(context, mapping);
  }

  // Legacy: resolve against trigger data directly
  return resolveFieldMapping(context.trigger, mapping);
}

/**
 * Apply a transform to a value.
 */
export function applyTransform(value: unknown, transform: string): unknown {
  const strVal = String(value);
  switch (transform) {
    case 'uppercase': return strVal.toUpperCase();
    case 'lowercase': return strVal.toLowerCase();
    case 'trim': return strVal.trim();
    case 'to_number': return Number(strVal);
    case 'to_string': return strVal;
    case 'json_parse':
      try { return JSON.parse(strVal); }
      catch { return value; }
    default: return value;
  }
}

/**
 * Evaluate a condition against a field value.
 */
export function evaluateCondition(fieldValue: unknown, operator: string, conditionValue?: string): boolean {
  const strFieldValue = fieldValue !== undefined && fieldValue !== null ? String(fieldValue) : '';

  switch (operator) {
    case 'equals':
      return strFieldValue === (conditionValue ?? '');
    case 'not_equals':
      return strFieldValue !== (conditionValue ?? '');
    case 'contains':
      return strFieldValue.includes(conditionValue ?? '');
    case 'not_contains':
      return !strFieldValue.includes(conditionValue ?? '');
    case 'greater_than':
      return Number(strFieldValue) > Number(conditionValue ?? 0);
    case 'less_than':
      return Number(strFieldValue) < Number(conditionValue ?? 0);
    case 'exists':
      return fieldValue !== undefined && fieldValue !== null && fieldValue !== '';
    case 'not_exists':
      return fieldValue === undefined || fieldValue === null || fieldValue === '';
    default:
      return false;
  }
}
