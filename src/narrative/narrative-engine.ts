/**
 * NarrativeEngine — main class for the narrative identity system
 * Manages episodes, character development, and the story of self.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type {
  NarrativeEvent,
  NarrativeEpisode,
  NarrativeState,
  NarrativeCoherenceCheck,
  CharacterProfile,
  StoryType,
} from './types.js';
import { MAX_ACTIVE_EPISODES } from './types.js';
import { classifyEpisode, shouldCloseEpisode } from './emplotment.js';
import { computeCharacterDevelopment } from './character.js';
import { assessNarrativeCoherence } from './coherence.js';
import { logger } from '../lib/logger.js';

function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export class NarrativeEngine {
  private activeEpisodes: NarrativeEpisode[] = [];
  private completedEpisodes: NarrativeEpisode[] = [];
  private character: CharacterProfile = {
    identity: '',
    coreTraits: [],
    definingMoments: [],
    currentArc: null,
    narrativeCoherence: 0.5,
  };

  constructor(
    private db: DatabaseAdapter | null,
    private workspaceId: string,
    private agentName: string = 'agent',
  ) {
    this.character.identity = `I am ${agentName}, an agent just beginning its story.`;
  }

  /**
   * Record a narrative event. Adds to an active episode of the matching story type,
   * or starts a new episode if none is active.
   */
  async recordEvent(event: NarrativeEvent, storyType?: StoryType): Promise<NarrativeEpisode> {
    // Find matching active episode
    let episode = storyType
      ? this.activeEpisodes.find(ep => ep.storyType === storyType)
      : this.activeEpisodes[0];

    if (!episode) {
      const isFirst = this.completedEpisodes.length === 0 && this.activeEpisodes.length === 0;
      const resolvedType = storyType
        ?? classifyEpisode([event], [event.significance], isFirst);
      episode = await this.startEpisode(event.description.slice(0, 60), resolvedType);
    }

    episode.events.push(event);
    episode.emotionalArc.push(event.significance);

    if (episode.events.length > 1) {
      episode.phase = 'middle';
    }

    // Auto-close check
    if (shouldCloseEpisode(episode)) {
      await this.closeEpisode(episode.id, null);
    }

    this.refreshCharacter();
    await this.persistToDb();

    logger.debug(
      { episodeId: episode.id, eventDescription: event.description },
      'narrative: event recorded',
    );

    return episode;
  }

  /**
   * Start a new narrative episode.
   */
  async startEpisode(title: string, storyType: StoryType): Promise<NarrativeEpisode> {
    // If at max active episodes, close the oldest
    if (this.activeEpisodes.length >= MAX_ACTIVE_EPISODES) {
      const oldest = this.activeEpisodes[0];
      await this.closeEpisode(oldest.id, 'Concluded to make room for new narrative threads.');
    }

    const episode: NarrativeEpisode = {
      id: generateId(),
      storyType,
      title,
      phase: 'beginning',
      events: [],
      moral: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      emotionalArc: [],
    };

    this.activeEpisodes.push(episode);
    await this.persistToDb();

    logger.debug({ episodeId: episode.id, title, storyType }, 'narrative: episode started');
    return episode;
  }

  /**
   * Close an episode with an optional lesson learned.
   */
  async closeEpisode(episodeId: string, moral: string | null): Promise<void> {
    const idx = this.activeEpisodes.findIndex(ep => ep.id === episodeId);
    if (idx === -1) {
      logger.warn({ episodeId }, 'narrative: episode not found for closing');
      return;
    }

    const episode = this.activeEpisodes[idx];
    episode.phase = 'end';
    episode.moral = moral;
    episode.endedAt = new Date().toISOString();

    // Reclassify now that we have the full arc
    const isFirst = this.completedEpisodes.length === 0;
    episode.storyType = classifyEpisode(episode.events, episode.emotionalArc, isFirst);

    this.activeEpisodes.splice(idx, 1);
    this.completedEpisodes.push(episode);

    this.refreshCharacter();
    await this.persistToDb();

    logger.debug({ episodeId, moral, storyType: episode.storyType }, 'narrative: episode closed');
  }

  /**
   * Generate the natural language "story of self."
   */
  getStoryOfSelf(): string {
    const allEpisodes = [...this.completedEpisodes, ...this.activeEpisodes];
    if (allEpisodes.length === 0) {
      return `${this.agentName} has not yet begun its story.`;
    }

    const lines: string[] = [];
    lines.push(this.character.identity);

    if (this.completedEpisodes.length > 0) {
      const recent = this.completedEpisodes.slice(-3);
      for (const ep of recent) {
        const moralSuffix = ep.moral ? ` The lesson: ${ep.moral}` : '';
        lines.push(`In "${ep.title}" (${ep.storyType}), the story reached its conclusion.${moralSuffix}`);
      }
    }

    if (this.activeEpisodes.length > 0) {
      const activeNames = this.activeEpisodes.map(ep => `"${ep.title}"`).join(', ');
      lines.push(`Currently unfolding: ${activeNames}.`);
    }

    if (this.character.coreTraits.length > 0) {
      lines.push(`Core traits: ${this.character.coreTraits.join(', ')}.`);
    }

    return lines.join(' ');
  }

  /**
   * Check whether a proposed action is coherent with the agent's narrative identity.
   */
  checkCoherence(proposedAction: string): NarrativeCoherenceCheck {
    return assessNarrativeCoherence(proposedAction, this.character, this.activeEpisodes);
  }

  /**
   * Get the full narrative state.
   */
  getState(): NarrativeState {
    return {
      activeEpisodes: [...this.activeEpisodes],
      completedEpisodeCount: this.completedEpisodes.length,
      character: { ...this.character },
      storyOfSelf: this.getStoryOfSelf(),
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Get the current character profile.
   */
  getCharacter(): CharacterProfile {
    return { ...this.character };
  }

  /**
   * Build prompt context text for injection into the agent's system prompt.
   * Returns null if there's no story to tell yet.
   */
  buildPromptContext(): string | null {
    const allEpisodes = [...this.completedEpisodes, ...this.activeEpisodes];
    if (allEpisodes.length === 0) return null;

    const lines: string[] = ['[Narrative Identity]'];
    lines.push(this.character.identity);

    if (this.character.coreTraits.length > 0) {
      lines.push(`Traits: ${this.character.coreTraits.join(', ')}`);
    }

    if (this.activeEpisodes.length > 0) {
      const current = this.activeEpisodes[this.activeEpisodes.length - 1];
      lines.push(`Current arc: "${current.title}" (${current.storyType}, ${current.phase})`);
    }

    return lines.join('\n');
  }

  /**
   * Load narrative state from the database.
   */
  async loadFromDb(): Promise<void> {
    if (!this.db) return;

    try {
      // Load active episodes
      const { data: activeRows } = await this.db
        .from('narrative_episodes')
        .select()
        .eq('workspace_id', this.workspaceId)
        .eq('phase', 'beginning')
        .order('started_at', { ascending: true })
        .limit(MAX_ACTIVE_EPISODES);

      const { data: middleRows } = await this.db
        .from('narrative_episodes')
        .select()
        .eq('workspace_id', this.workspaceId)
        .eq('phase', 'middle')
        .order('started_at', { ascending: true })
        .limit(MAX_ACTIVE_EPISODES);

      const activeData = [...(activeRows ?? []), ...(middleRows ?? [])];
      this.activeEpisodes = activeData.map(rowToEpisode);

      // Load completed episodes
      const { data: completedRows } = await this.db
        .from('narrative_episodes')
        .select()
        .eq('workspace_id', this.workspaceId)
        .eq('phase', 'end')
        .order('ended_at', { ascending: false })
        .limit(50);

      this.completedEpisodes = (completedRows ?? []).map(rowToEpisode);

      // Load character profile
      const { data: charRow } = await this.db
        .from('character_profiles')
        .select()
        .eq('workspace_id', this.workspaceId)
        .limit(1)
        .maybeSingle();

      if (charRow) {
        this.character = {
          identity: (charRow as Record<string, unknown>).identity as string,
          coreTraits: JSON.parse(((charRow as Record<string, unknown>).core_traits as string) || '[]'),
          definingMoments: JSON.parse(((charRow as Record<string, unknown>).defining_moments as string) || '[]'),
          currentArc: this.activeEpisodes.length > 0
            ? this.activeEpisodes[this.activeEpisodes.length - 1].storyType
            : null,
          narrativeCoherence: (charRow as Record<string, unknown>).narrative_coherence as number,
        };
      }

      this.refreshCharacter();
      logger.debug(
        { active: this.activeEpisodes.length, completed: this.completedEpisodes.length },
        'narrative: loaded from db',
      );
    } catch (err) {
      logger.warn({ err }, 'narrative: failed to load from db');
    }
  }

  /**
   * Persist current narrative state to the database.
   */
  async persistToDb(): Promise<void> {
    if (!this.db) return;

    try {
      // Upsert all active episodes
      for (const ep of this.activeEpisodes) {
        await this.upsertEpisode(ep);
      }

      // Upsert character profile
      await this.db.from('character_profiles').delete().eq('workspace_id', this.workspaceId);
      await this.db.from('character_profiles').insert({
        workspace_id: this.workspaceId,
        identity: this.character.identity,
        core_traits: JSON.stringify(this.character.coreTraits),
        defining_moments: JSON.stringify(this.character.definingMoments),
        narrative_coherence: this.character.narrativeCoherence,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn({ err }, 'narrative: failed to persist to db');
    }
  }

  private async upsertEpisode(episode: NarrativeEpisode): Promise<void> {
    if (!this.db) return;

    // Delete then insert (upsert pattern for SQLite adapter)
    await this.db.from('narrative_episodes').delete().eq('id', episode.id);
    await this.db.from('narrative_episodes').insert({
      id: episode.id,
      workspace_id: this.workspaceId,
      story_type: episode.storyType,
      title: episode.title,
      phase: episode.phase,
      events: JSON.stringify(episode.events),
      moral: episode.moral,
      emotional_arc: JSON.stringify(episode.emotionalArc),
      started_at: episode.startedAt,
      ended_at: episode.endedAt,
    });
  }

  private refreshCharacter(): void {
    const allEpisodes = [...this.completedEpisodes, ...this.activeEpisodes];
    this.character = computeCharacterDevelopment(allEpisodes, this.agentName);
  }
}

function rowToEpisode(row: unknown): NarrativeEpisode {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as string,
    storyType: r.story_type as NarrativeEpisode['storyType'],
    title: r.title as string,
    phase: r.phase as NarrativeEpisode['phase'],
    events: JSON.parse((r.events as string) || '[]'),
    moral: (r.moral as string) ?? null,
    startedAt: r.started_at as string,
    endedAt: (r.ended_at as string) ?? null,
    emotionalArc: JSON.parse((r.emotional_arc as string) || '[]'),
  };
}
