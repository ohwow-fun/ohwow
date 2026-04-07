/**
 * Predecessor Context Builder (Local Runtime)
 *
 * Builds the context string injected into each Sequential step from
 * its predecessor steps' outputs. Uses "review and improve" framing
 * to prevent error amplification.
 */

import type { SequenceStepResult } from './types.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_CHAR_BUDGET = 16_000;
const CHARS_PER_TOKEN = 4;

// ============================================================================
// BUILD PREDECESSOR CONTEXT
// ============================================================================

export interface PredecessorContextOptions {
  predecessors: SequenceStepResult[];
  agentNames: Map<string, string>;
  charBudget?: number;
}

export function buildPredecessorContext(options: PredecessorContextOptions): string {
  const { predecessors, agentNames, charBudget = DEFAULT_CHAR_BUDGET } = options;

  const withOutput = predecessors.filter(
    (p) => p.status === 'completed' && p.output && p.output.trim().length > 0
  );

  if (withOutput.length === 0) return '';

  const sections = withOutput.map((p, index) => {
    const agentName = agentNames.get(p.agentId) ?? 'Agent';
    const role = p.chosenRole ? ` (${p.chosenRole})` : '';
    return {
      header: `### ${agentName}${role}`,
      body: p.output!,
      index,
    };
  });

  const headerOverhead = sections.reduce(
    (sum, s) => sum + s.header.length + 4,
    0
  );
  const framingOverhead = 300;
  const bodyBudget = charBudget - headerOverhead - framingOverhead;

  const totalBodyLength = sections.reduce((sum, s) => sum + s.body.length, 0);

  let truncatedSections: typeof sections;

  if (totalBodyLength <= bodyBudget) {
    truncatedSections = sections;
  } else {
    truncatedSections = [];
    const lastPredBudget = Math.floor(bodyBudget * 0.5);
    const otherBudget = bodyBudget - lastPredBudget;
    const otherCount = sections.length - 1;
    const perOtherBudget = otherCount > 0 ? Math.floor(otherBudget / otherCount) : 0;

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const isLast = i === sections.length - 1;
      const budget = isLast ? lastPredBudget : perOtherBudget;

      if (section.body.length <= budget) {
        truncatedSections.push(section);
      } else {
        truncatedSections.push({
          ...section,
          body: section.body.slice(0, budget) + '\n\n[... truncated for brevity]',
        });
      }
    }
  }

  const predecessorBlocks = truncatedSections
    .map((s) => `${s.header}\n${s.body}`)
    .join('\n\n---\n\n');

  return `## Prior Work from Your Team

The following contributions have been made by team members who worked on this task before you. Review their work critically. Your job is to add value where your expertise is strongest. You may:

- **Build upon** what's already been done if it's solid
- **Correct or improve** anything that's inaccurate or incomplete
- **Add a new perspective** that predecessors missed
- **Step aside** if the work is already complete and your expertise isn't needed

Do not repeat what's already been said. Focus on what only you can add.

${predecessorBlocks}

---

Now, given your expertise and the work above, make your contribution to the task.`;
}

export function estimatePredecessorTokens(context: string): number {
  return Math.ceil(context.length / CHARS_PER_TOKEN);
}
