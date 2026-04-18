/**
 * Mode-lens index. The Conductor (Phase 5) imports `LENSES` and
 * `getLens(mode)` to splice the mode preamble into every plan brief
 * the ranker emits.
 */
import type { Mode } from '../types.js';
import type { ModeLens } from './types.js';
import { revenueLens } from './revenue.js';
import { polishLens } from './polish.js';
import { plumbingLens } from './plumbing.js';
import { toolingLens } from './tooling.js';

export type { ModeLens } from './types.js';

export const LENSES: Record<Mode, ModeLens> = {
  revenue: revenueLens,
  polish: polishLens,
  plumbing: plumbingLens,
  tooling: toolingLens,
};

export function getLens(mode: Mode): ModeLens {
  return LENSES[mode];
}
