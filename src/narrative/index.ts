export type {
  StoryType,
  EpisodePhase,
  NarrativeEvent,
  NarrativeEpisode,
  CharacterProfile,
  NarrativeCoherenceCheck,
  NarrativeState,
} from './types.js';

export {
  MAX_ACTIVE_EPISODES,
  MAX_EVENTS_PER_EPISODE,
  GROWTH_TO_STORY,
} from './types.js';

export { classifyEpisode, detectArcPattern, shouldCloseEpisode } from './emplotment.js';
export { computeCharacterDevelopment, deriveTraits } from './character.js';
export { assessNarrativeCoherence } from './coherence.js';
export { NarrativeEngine } from './narrative-engine.js';
