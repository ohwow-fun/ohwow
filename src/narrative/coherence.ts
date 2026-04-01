/**
 * Coherence — narrative coherence checking
 * Pure function that assesses whether a proposed action fits the agent's character.
 */

import type { CharacterProfile, NarrativeEpisode, NarrativeCoherenceCheck } from './types.js';

/** Actions that suggest giving up or abandoning */
const ABANDONMENT_KEYWORDS = ['give up', 'abandon', 'quit', 'stop trying', 'cancel everything'];

/** Actions that suggest persistence */
const PERSISTENCE_KEYWORDS = ['retry', 'try again', 'persist', 'keep going', 'push through'];

/**
 * Assess how well a proposed action aligns with the agent's narrative identity.
 */
export function assessNarrativeCoherence(
  proposedAction: string,
  character: CharacterProfile,
  activeEpisodes: NarrativeEpisode[],
): NarrativeCoherenceCheck {
  const actionLower = proposedAction.toLowerCase();

  // Trait overlap: how many character traits are reflected in the action
  let traitOverlap = 0;
  for (const trait of character.coreTraits) {
    if (actionLower.includes(trait.toLowerCase())) {
      traitOverlap++;
    }
  }
  const traitScore = character.coreTraits.length > 0
    ? Math.min(1, traitOverlap / character.coreTraits.length + 0.5)
    : 0.5;

  // Arc alignment: check if action contradicts current arc
  let arcScore = 0.5;
  let suggestion: string | null = null;

  const currentArc = activeEpisodes.length > 0
    ? activeEpisodes[activeEpisodes.length - 1].storyType
    : character.currentArc;

  if (currentArc === 'struggle' || currentArc === 'failure_and_recovery') {
    const isAbandoning = ABANDONMENT_KEYWORDS.some(k => actionLower.includes(k));
    const isPersisting = PERSISTENCE_KEYWORDS.some(k => actionLower.includes(k));

    if (isAbandoning) {
      arcScore = 0.2;
      suggestion = 'Consider reframing as a learning moment rather than giving up. Your story is one of perseverance.';
    } else if (isPersisting) {
      arcScore = 0.9;
    }
  }

  if (currentArc === 'mastery') {
    const isAbandoning = ABANDONMENT_KEYWORDS.some(k => actionLower.includes(k));
    if (isAbandoning) {
      arcScore = 0.3;
      suggestion = 'This conflicts with your mastery arc. Consider refining the approach instead.';
    }
  }

  if (currentArc === 'collaboration') {
    const isSolo = actionLower.includes('alone') || actionLower.includes('by myself');
    if (isSolo) {
      arcScore = 0.3;
      suggestion = 'Your current arc emphasizes collaboration. Consider involving others.';
    }
  }

  const coherenceScore = (traitScore + arcScore) / 2;
  const characterAlignment = traitScore;

  return {
    proposedAction,
    coherenceScore,
    characterAlignment,
    suggestion,
  };
}
