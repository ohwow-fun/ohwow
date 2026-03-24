/**
 * Field Mapper Utilities
 *
 * Shared utilities for resolving field mappings and template variables
 * from webhook data. Used by the trigger evaluator's action dispatchers.
 */

/**
 * Get a nested value from an object using dot notation.
 * e.g. getNestedValue({ a: { b: 'c' } }, 'a.b') => 'c'
 */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current && typeof current === 'object') {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Resolve a field mapping against webhook data.
 * Takes a mapping of { targetField: 'source.path' } and returns { targetField: resolvedValue }.
 * Only includes fields where the source path resolved to a defined value.
 */
export function resolveFieldMapping(
  data: Record<string, unknown>,
  mapping: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [targetField, sourcePath] of Object.entries(mapping)) {
    const value = getNestedValue(data, sourcePath);
    if (value !== undefined) {
      result[targetField] = value;
    }
  }

  return result;
}

/**
 * Extract all leaf paths from a JSON object using dot notation.
 * For arrays, includes the array path + first element's nested paths.
 * e.g. { a: { b: 'c' }, d: [{ e: 1 }] } => ['a.b', 'd', 'd.0.e']
 */
export function extractLeafPaths(
  obj: unknown,
  prefix = '',
  maxDepth = 5,
): string[] {
  if (maxDepth <= 0 || obj === null || obj === undefined) return [];

  if (typeof obj !== 'object') return prefix ? [prefix] : [];

  if (Array.isArray(obj)) {
    const paths: string[] = prefix ? [prefix] : [];
    if (obj.length > 0) {
      const childPaths = extractLeafPaths(obj[0], prefix ? `${prefix}.0` : '0', maxDepth - 1);
      paths.push(...childPaths);
    }
    return paths;
  }

  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record);

  if (keys.length === 0) return prefix ? [prefix] : [];

  const paths: string[] = [];
  for (const key of keys) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const value = record[key];

    if (value === null || value === undefined || typeof value !== 'object') {
      paths.push(fullPath);
    } else {
      paths.push(...extractLeafPaths(value, fullPath, maxDepth - 1));
    }
  }

  return paths;
}

/**
 * Resolve template variables in a string.
 * Replaces {{data.path.to.value}} with the actual value from the data object.
 * Unknown paths are replaced with an empty string.
 */
export function resolveTemplate(
  template: string,
  data: Record<string, unknown>,
): string {
  return template.replace(/\{\{data\.([^}]+)\}\}/g, (_match, path: string) => {
    const value = getNestedValue(data, path);
    return value !== undefined ? String(value) : '';
  });
}

// ============================================================================
// CONTEXT-AWARE RESOLUTION (for multi-step action chains)
// ============================================================================

import type { ExecutionContext } from './automation-types.js';

/**
 * Resolve a context-aware template string.
 * Supports {{trigger.field}}, {{step_1.field}}, {{step_N.field}} patterns
 * against a multi-step ExecutionContext. Also supports legacy {{data.field}}.
 * Unknown paths are replaced with an empty string.
 */
export function resolveContextTemplate(
  template: string,
  context: ExecutionContext,
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, fullPath: string) => {
    // Legacy {{data.field}} → map to trigger context
    if (fullPath.startsWith('data.')) {
      const path = fullPath.slice(5);
      const value = context.trigger ? getNestedValue(context.trigger, path) : undefined;
      return value !== undefined ? String(value) : '';
    }

    // Context-aware: {{trigger.field}} or {{step_N.field}}
    const dotIndex = fullPath.indexOf('.');
    if (dotIndex === -1) return '';

    const stepId = fullPath.slice(0, dotIndex);
    const path = fullPath.slice(dotIndex + 1);
    const stepData = context[stepId];
    if (!stepData) return '';

    const value = getNestedValue(stepData, path);
    return value !== undefined ? String(value) : '';
  });
}

/**
 * Resolve a field mapping against a multi-step ExecutionContext.
 * Source paths can reference any step: "trigger.email", "step_1.contact_id".
 * Returns { targetField: resolvedValue } for all defined source paths.
 */
export function resolveContextFieldMapping(
  context: ExecutionContext,
  mapping: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [targetField, sourcePath] of Object.entries(mapping)) {
    // Check if it's a template string
    if (sourcePath.includes('{{')) {
      result[targetField] = resolveContextTemplate(sourcePath, context);
      continue;
    }

    const dotIndex = sourcePath.indexOf('.');
    if (dotIndex === -1) continue;

    const stepId = sourcePath.slice(0, dotIndex);
    const path = sourcePath.slice(dotIndex + 1);
    const stepData = context[stepId];
    if (!stepData) continue;

    const value = getNestedValue(stepData, path);
    if (value !== undefined) {
      result[targetField] = value;
    }
  }

  return result;
}
