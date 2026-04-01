/**
 * Character — identity derivation from narrative patterns
 * Pure functions that build a character profile from completed episodes.
 */

import type { NarrativeEpisode, CharacterProfile, StoryType } from './types.js';

/** Map story type frequency to character traits */
const STORY_TRAIT_MAP: Record<StoryType, string> = {
  origin: 'self-aware',
  struggle: 'resilient',
  breakthrough: 'innovative',
  mastery: 'disciplined',
  collaboration: 'collaborative',
  failure_and_recovery: 'perseverant',
};

/**
 * Derive character traits from story type frequency.
 */
export function deriveTraits(storyTypeCounts: Record<StoryType, number>): string[] {
  const traits: string[] = [];

  const entries = Object.entries(storyTypeCounts) as [StoryType, number][];
  const sorted = entries
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

  for (const [type] of sorted) {
    const trait = STORY_TRAIT_MAP[type];
    if (trait && !traits.includes(trait)) {
      traits.push(trait);
    }
  }

  return traits;
}

/**
 * Compute a full character profile from completed episodes.
 */
export function computeCharacterDevelopment(
  episodes: NarrativeEpisode[],
  agentName: string,
): CharacterProfile {
  if (episodes.length === 0) {
    return {
      identity: `I am ${agentName}, an agent just beginning its story.`,
      coreTraits: [],
      definingMoments: [],
      currentArc: null,
      narrativeCoherence: 0.5,
    };
  }

  // Count story types
  const storyTypeCounts: Record<StoryType, number> = {
    origin: 0,
    struggle: 0,
    breakthrough: 0,
    mastery: 0,
    collaboration: 0,
    failure_and_recovery: 0,
  };
  for (const ep of episodes) {
    storyTypeCounts[ep.storyType]++;
  }

  const coreTraits = deriveTraits(storyTypeCounts);

  // Dominant activity pattern from most common story type
  const dominantType = (Object.entries(storyTypeCounts) as [StoryType, number][])
    .sort((a, b) => b[1] - a[1])[0][0];

  const activityDescriptions: Record<StoryType, string> = {
    origin: 'continually reinvents itself',
    struggle: 'perseveres through challenges',
    breakthrough: 'finds innovative solutions',
    mastery: 'hones its craft with discipline',
    collaboration: 'builds connections and works with others',
    failure_and_recovery: 'learns from setbacks and grows stronger',
  };

  const identity = `I am ${agentName}, an agent that ${activityDescriptions[dominantType]}.`;

  // Defining moments: top episodes by average event significance
  const scoredEpisodes = episodes
    .filter(ep => ep.events.length > 0)
    .map(ep => ({
      title: ep.title,
      avgSignificance: ep.events.reduce((s, e) => s + e.significance, 0) / ep.events.length,
    }))
    .sort((a, b) => b.avgSignificance - a.avgSignificance);

  const definingMoments = scoredEpisodes.slice(0, 5).map(e => e.title);

  // Current arc: from the most recent active (non-ended) episode
  const activeEpisode = episodes.find(ep => ep.endedAt === null);
  const currentArc = activeEpisode?.storyType ?? null;

  // Narrative coherence: ratio of episodes whose story type matches the dominant pattern
  const consistentCount = episodes.filter(ep => ep.storyType === dominantType).length;
  const narrativeCoherence = Math.min(1, consistentCount / Math.max(1, episodes.length) + 0.3);

  return {
    identity,
    coreTraits,
    definingMoments,
    currentArc,
    narrativeCoherence: Math.min(1, narrativeCoherence),
  };
}
