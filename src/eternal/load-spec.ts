/**
 * Eternal Systems — operator config loader.
 *
 * Reads eternal.config.json from the workspace data directory (written by
 * `ohwow eternal init`) and merges it over DEFAULT_ETERNAL_SPEC. Falls back
 * to DEFAULT_ETERNAL_SPEC silently when the file is absent, and logs a
 * warning + falls back when the file is unreadable or malformed.
 *
 * Only the fields present in the file override the defaults — missing fields
 * keep their default values so partial configs are always safe.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../lib/logger.js';
import { DEFAULT_ETERNAL_SPEC } from './defaults.js';
import type { EternalSpec } from './types.js';

export function loadEternalSpec(dataDir: string): EternalSpec {
  const configPath = join(dataDir, 'eternal.config.json');
  if (!existsSync(configPath)) return DEFAULT_ETERNAL_SPEC;

  let raw: Partial<EternalSpec>;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<EternalSpec>;
  } catch (err) {
    logger.warn({ err, configPath }, 'eternal.load_spec.parse_failed');
    return DEFAULT_ETERNAL_SPEC;
  }

  return {
    ...DEFAULT_ETERNAL_SPEC,
    ...(raw.valuesCorpusPath ? { valuesCorpusPath: raw.valuesCorpusPath } : {}),
    ...(raw.valuesCorpusInline ? { valuesCorpusInline: raw.valuesCorpusInline } : {}),
    inactivityProtocol: {
      ...DEFAULT_ETERNAL_SPEC.inactivityProtocol,
      ...(raw.inactivityProtocol ?? {}),
    },
    escalationMap: raw.escalationMap ?? DEFAULT_ETERNAL_SPEC.escalationMap,
  };
}
