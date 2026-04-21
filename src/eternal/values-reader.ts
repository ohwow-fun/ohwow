/**
 * Eternal Systems — values corpus reader.
 *
 * Returns the operator's values corpus text for use in orchestrator prompts.
 * Inline text takes precedence over a file path. Returns null when neither
 * is configured so callers can decide whether to skip corpus injection.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { EternalSpec } from './types.js';

/**
 * Read the values corpus from the spec.
 *
 * Priority:
 *   1. `spec.valuesCorpusInline` — returned verbatim if non-empty.
 *   2. `spec.valuesCorpusPath` — file read synchronously; missing file returns null.
 *   3. null — neither is configured.
 */
export function readValuesCorpus(spec: EternalSpec): string | null {
  if (spec.valuesCorpusInline && spec.valuesCorpusInline.trim().length > 0) {
    return spec.valuesCorpusInline;
  }

  if (spec.valuesCorpusPath) {
    try {
      if (!existsSync(spec.valuesCorpusPath)) return null;
      return readFileSync(spec.valuesCorpusPath, 'utf8');
    } catch {
      return null;
    }
  }

  return null;
}
