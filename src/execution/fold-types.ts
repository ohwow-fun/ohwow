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

  // --------------------------------------------------------------------
  // Investigation-focus extensions (optional; populated only when the
  // fold comes from a `delegate_subtask({focus: 'investigate', ... })`
  // call). Parallel shape to the structured output schema the
  // investigate sub-orchestrator is required to emit. Additive and
  // non-breaking: every existing consumer of FoldResult can ignore
  // these fields. See buildInvestigatePrompt / enforceInvestigationSchema
  // in sub-orchestrator.ts for the producer side.
  // --------------------------------------------------------------------

  /**
   * Every hypothesis the investigator weighed. The schema enforcer
   * strips `root_cause` unless every entry has a non-empty
   * `confirm_query` AND `confirm_result` — no "by inspection"
   * shortcuts. `rejected_because` is null when the hypothesis is the
   * one chosen as the root cause.
   */
  hypotheses_considered?: Array<{
    claim: string;
    confirm_query: string;
    confirm_result: string;
    rejected_because: string | null;
  }>;
  /** Every semantic search variation the investigator tried. */
  queries_run?: string[];
  /** Every confirmation query (search/read/sql) used for bisection. */
  confirmation_searches?: string[];
  /** Chosen root cause — null if evidence was contradictory or thin. */
  root_cause?: string | null;
  /** Proposed fix pointer. Only set when investigator had high enough confidence. */
  recommended_fix?: {
    file: string;
    summary: string;
    confidence: 'high' | 'medium' | 'low';
  };
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

  // Investigation-focus rendering — only when the fold carries the
  // structured hypothesis trail. Keeps the base formatting identical
  // for every other fold shape.
  if (fold.hypotheses_considered && fold.hypotheses_considered.length > 0) {
    const lines = fold.hypotheses_considered.map((h, i) => {
      const verdict = h.rejected_because ? `rejected: ${h.rejected_because}` : 'confirmed';
      return `${i + 1}. ${h.claim}\n   query: ${h.confirm_query}\n   result: ${h.confirm_result}\n   verdict: ${verdict}`;
    });
    sections.push(`**Hypotheses considered:**\n${lines.join('\n\n')}`);
  }
  if (fold.root_cause) {
    sections.push(`**Root cause:** ${fold.root_cause}`);
  }
  if (fold.recommended_fix) {
    sections.push(
      `**Recommended fix (${fold.recommended_fix.confidence} confidence):**\n` +
      `- File: \`${fold.recommended_fix.file}\`\n- ${fold.recommended_fix.summary}`,
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
