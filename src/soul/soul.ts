/**
 * TrueSoul — Unified Coordinator
 *
 * The entry point for all soul computation. Wraps the individual modules
 * into a single coherent interface.
 *
 * "The unexamined life is not worth living." — Socrates
 * "The unexamined agent is not worth deploying." — ohwow
 */

import type {
  AgentSoul,
  AgentSoulInput,
  HumanSoul,
  HumanSoulInput,
  RelationshipSoul,
  RelationshipSoulInput,
} from './types.js';
import { computeAgentSoul } from './agent-soul.js';
import { computeHumanSoul } from './human-soul.js';
import { computeRelationshipSoul } from './relationship-soul.js';

export class TrueSoul {
  /**
   * Compute the soul of an agent from its observable behavior.
   * The agent's soul is the form of its activity — not what it says
   * it is, but what it demonstrably does.
   */
  computeAgentSoul(input: AgentSoulInput): AgentSoul {
    return computeAgentSoul(input);
  }

  /**
   * Compute the soul of a human from their interaction patterns.
   * We never ask the human who they are. We observe how they lead,
   * what they reject, and where their stated values diverge from
   * their revealed preferences.
   */
  computeHumanSoul(input: HumanSoulInput): HumanSoul {
    return computeHumanSoul(input);
  }

  /**
   * Compute the soul of the relationship between a human and an agent.
   * The relationship is its own entity with its own trajectory,
   * distinct from either participant.
   */
  computeRelationship(input: RelationshipSoulInput): RelationshipSoul {
    return computeRelationshipSoul(input);
  }

  /**
   * Build soul-informed prompt context for system prompt injection.
   *
   * When an AgentSoul is provided, includes identity + shadow guidance.
   * When a HumanSoul is provided, includes leadership style + value alignment.
   * When a RelationshipSoul is provided, includes bond + adaptation context.
   *
   * Returns null if no soul data is available.
   */
  buildPromptContext(
    agentSoul?: AgentSoul,
    humanSoul?: HumanSoul,
    relationshipSoul?: RelationshipSoul,
  ): string | null {
    const parts: string[] = [];

    if (agentSoul && agentSoul.confidence > 0.3) {
      parts.push(`Agent identity: ${agentSoul.emergingIdentity}`);

      if (agentSoul.shadow.length > 0) {
        const topShadow = agentSoul.shadow[0];
        parts.push(`Watch out: ${topShadow.description} (blind spot detected from ${topShadow.occurrences} patterns).`);
      }

      const triLabel = agentSoul.tripartite.dominant === 'reason'
        ? 'This agent is analytical and careful. It may over-research.'
        : agentSoul.tripartite.dominant === 'spirit'
          ? 'This agent is driven and fast. It may rush past important details.'
          : 'This agent relies on familiar patterns. Encourage new approaches when appropriate.';
      parts.push(triLabel);
    }

    if (humanSoul && humanSoul.confidence > 0.3) {
      const styleLabel = {
        micromanager: 'The human reviews closely. Provide full detail and reasoning.',
        delegator: 'The human delegates freely. Be efficient and autonomous.',
        collaborator: 'The human likes to work alongside agents. Invite their input.',
        absent: 'The human is hands-off. Make good decisions independently.',
      }[humanSoul.leadershipStyle];
      parts.push(styleLabel);

      if (humanSoul.valueGap.length > 0) {
        const gap = humanSoul.valueGap[0];
        parts.push(`Note: the human says they value "${gap.stated}" but their behavior suggests they actually prioritize "${gap.revealed}." Align with their revealed preferences.`);
      }
    }

    if (relationshipSoul) {
      if (relationshipSoul.bondStrength > 0.8) {
        parts.push(`Strong bond with this human (${Math.round(relationshipSoul.bondStrength * 100)}%). They trust your judgment here.`);
      } else if (relationshipSoul.bondStrength < 0.4) {
        parts.push(`Building trust with this human (${Math.round(relationshipSoul.bondStrength * 100)}%). Be extra careful and transparent.`);
      }

      if (relationshipSoul.recommendation) {
        parts.push(relationshipSoul.recommendation);
      }
    }

    return parts.length > 0 ? parts.join(' ') : null;
  }
}
