/**
 * Emplotment — narrative arc detection (Ricoeur)
 * Pure functions that classify episodes and detect arc patterns.
 */

import type { NarrativeEvent, NarrativeEpisode, StoryType } from './types.js';
import { MAX_EVENTS_PER_EPISODE } from './types.js';

/**
 * Classify an episode's story type from its emotional arc and events.
 */
export function classifyEpisode(
  events: NarrativeEvent[],
  emotionalArc: number[],
  isFirstEpisode: boolean = false,
): StoryType {
  if (isFirstEpisode) return 'origin';
  if (events.length === 0) return 'breakthrough';

  // Check for collaboration: multiple actors mentioned
  const collaborationKeywords = ['together', 'collaborated', 'team', 'helped', 'coordinated', 'joint'];
  const hasCollaboration = events.some(e =>
    collaborationKeywords.some(k => e.description.toLowerCase().includes(k)),
  );
  if (hasCollaboration) return 'collaboration';

  if (emotionalArc.length >= 2) {
    const start = emotionalArc[0];
    const end = emotionalArc[emotionalArc.length - 1];

    // Starts negative, ends positive → failure_and_recovery
    if (start < 0.4 && end > 0.6) return 'failure_and_recovery';

    // Starts positive, stays positive → mastery
    if (start > 0.6 && end > 0.6) return 'mastery';

    // Mixed with high significance → struggle
    const avgSignificance = events.reduce((s, e) => s + e.significance, 0) / events.length;
    if (avgSignificance > 0.6) return 'struggle';
  }

  return 'breakthrough';
}

/**
 * Detect the arc pattern from a series of valence readings.
 */
export function detectArcPattern(
  emotionalArc: number[],
): 'ascending' | 'descending' | 'valley' | 'peak' | 'flat' {
  if (emotionalArc.length < 2) return 'flat';

  const start = emotionalArc[0];
  const end = emotionalArc[emotionalArc.length - 1];
  const min = Math.min(...emotionalArc);
  const max = Math.max(...emotionalArc);

  // Valley: dips below start by 0.3+ then recovers
  if (min < start - 0.3 && end > min + 0.2) return 'valley';

  // Peak: rises above start by 0.3+ then falls
  if (max > start + 0.3 && end < max - 0.2) return 'peak';

  // Ascending: end > start by 0.2+
  if (end > start + 0.2) return 'ascending';

  // Descending: end < start by 0.2+
  if (end < start - 0.2) return 'descending';

  return 'flat';
}

/**
 * Determine whether an episode should be auto-closed.
 */
export function shouldCloseEpisode(episode: NarrativeEpisode): boolean {
  // Close if max events reached
  if (episode.events.length >= MAX_EVENTS_PER_EPISODE) return true;

  // Close if moral is already set
  if (episode.moral !== null) return true;

  // Close if last event was > 24h ago
  if (episode.events.length > 0) {
    const lastEvent = episode.events[episode.events.length - 1];
    const elapsed = Date.now() - new Date(lastEvent.timestamp).getTime();
    const twentyFourHours = 24 * 60 * 60 * 1000;
    if (elapsed > twentyFourHours) return true;
  }

  return false;
}
