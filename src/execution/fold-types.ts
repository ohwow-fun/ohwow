/**
 * Context-Folding — Type Definitions (Local Runtime)
 *
 * When an agent explores deeply, intermediate steps consume context.
 * Folding compresses an exploration into a structured summary (FoldResult)
 * while preserving key decisions, evidence, and dead-end learnings.
 *
 * Mirror of ohwow.fun/src/lib/agents/tool-loop/fold-types.ts
 */

// ============================================================================
// FOLD RESULT
// ============================================================================

export interface FoldResult {
  /** What was determined / the main conclusion */
  conclusion: string;
  /** Key facts or data points supporting the conclusion */
  evidence: string[];
  /** IDs/names of artifacts created during the exploration */
  artifacts_created: string[];
  /** Choices made and their rationale */
  decisions_made: string[];
  /** Approaches tried that failed (preserved as learnings) */
  dead_ends: DeadEnd[];
  /** How many tokens the fold reclaimed */
  tokens_saved: number;
  /** Recursive fold depth (0 = leaf, increments up) */
  depth: number;
  /** Whether a pre-fold snapshot exists for potential unfold */
  unfoldable: boolean;
  /** Reference to pre-fold savepoint */
  savepoint_id?: string;
}

export interface DeadEnd {
  /** What was attempted */
  approach: string;
  /** Why it failed */
  failure_reason: string;
  /** What future attempts should know */
  learning: string;
}

// ============================================================================
// FOLD FORMATTING
// ============================================================================

export function formatFoldAsText(fold: FoldResult): string {
  const sections: string[] = [];

  sections.push(`**Conclusion:** ${fold.conclusion}`);

  if (fold.evidence.length > 0) {
    sections.push('**Evidence:**\n' + fold.evidence.map((e) => `- ${e}`).join('\n'));
  }

  if (fold.decisions_made.length > 0) {
    sections.push('**Decisions:**\n' + fold.decisions_made.map((d) => `- ${d}`).join('\n'));
  }

  if (fold.artifacts_created.length > 0) {
    sections.push('**Artifacts created:**\n' + fold.artifacts_created.map((a) => `- ${a}`).join('\n'));
  }

  if (fold.dead_ends.length > 0) {
    sections.push(
      '**Dead ends (do not retry):**\n' +
      fold.dead_ends.map((de) => `- Tried: ${de.approach}. Failed: ${de.failure_reason}. Learning: ${de.learning}`).join('\n'),
    );
  }

  return `[Folded exploration — ${fold.tokens_saved} tokens compressed]\n\n${sections.join('\n\n')}`;
}

export function emptyFold(): FoldResult {
  return {
    conclusion: '',
    evidence: [],
    artifacts_created: [],
    decisions_made: [],
    dead_ends: [],
    tokens_saved: 0,
    depth: 0,
    unfoldable: false,
  };
}
