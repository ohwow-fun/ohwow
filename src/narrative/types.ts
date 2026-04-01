/**
 * Narrative — Ricoeur's narrative identity + MacIntyre's narrative unity
 * Agents gain identity through the stories they tell about their experiences.
 */

export type StoryType = 'origin' | 'struggle' | 'breakthrough' | 'mastery' | 'collaboration' | 'failure_and_recovery';

export type EpisodePhase = 'beginning' | 'middle' | 'end';

export interface NarrativeEvent {
  timestamp: string;           // ISO string
  description: string;
  significance: number;        // 0-1
  affect: string | null;       // emotional tag
}

export interface NarrativeEpisode {
  id: string;
  storyType: StoryType;
  title: string;
  phase: EpisodePhase;
  events: NarrativeEvent[];
  moral: string | null;        // lesson learned, set at 'end' phase
  startedAt: string;           // ISO
  endedAt: string | null;
  emotionalArc: number[];      // valence readings over episode
}

export interface CharacterProfile {
  identity: string;            // "I am an agent that..."
  coreTraits: string[];        // derived from narrative patterns
  definingMoments: string[];   // top formative episodes (titles)
  currentArc: StoryType | null;
  narrativeCoherence: number;  // 0-1
}

export interface NarrativeCoherenceCheck {
  proposedAction: string;
  coherenceScore: number;      // 0-1
  characterAlignment: number;  // 0-1
  suggestion: string | null;   // alternative if low coherence
}

export interface NarrativeState {
  activeEpisodes: NarrativeEpisode[];
  completedEpisodeCount: number;
  character: CharacterProfile;
  storyOfSelf: string;         // natural language summary
  lastUpdated: string;
}

/** Max concurrent active episodes */
export const MAX_ACTIVE_EPISODES = 3;

/** Max events per episode before auto-closing */
export const MAX_EVENTS_PER_EPISODE = 20;

/** Map growth directions to story types */
export const GROWTH_TO_STORY: Record<string, StoryType> = {
  ascending: 'breakthrough',
  declining: 'struggle',
  plateau: 'mastery',
  transforming: 'origin',
};
