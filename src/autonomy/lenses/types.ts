/**
 * Mode-lens shape consumed by the Conductor (Phase 5).
 *
 * Each lens is a small, ASCII-only projection of the corresponding
 * `.claude/skills/be-ohwow/briefs/<mode>.md` brief. The Conductor splices
 * `plan_brief_preamble` into every `initial_plan_brief` it emits so the
 * downstream phase orchestrator has the mode-scope rules in front of it
 * without re-reading the skill prose.
 *
 * Drift policy (decided in Phase 5): the runtime lens is option (c) from
 * the spec — duplicate the prose into TS constants here and accept
 * controlled drift. Phase 6 may add a drift-detection experiment; we do
 * not write one now.
 */
import type { Mode } from '../types.js';

export interface ModeLens {
  mode: Mode;
  /** One sentence; goes into the plan brief preamble + ranker logging. */
  description: string;
  /** Distilled from the skill brief; <=6 lines, ASCII. */
  plan_brief_preamble: string;
  /** ohwow runtime tables this mode operates on. */
  tables: string[];
  /** ohwow MCP verbs this mode tends to call. */
  mcp_verbs: string[];
  /** Existing experiment family names that overlap this mode. */
  experiment_families: string[];
}
