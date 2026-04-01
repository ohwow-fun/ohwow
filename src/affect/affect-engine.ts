import type { DatabaseAdapter } from '../db/adapter-types.js';
import type {
  AffectType,
  AffectReading,
  AffectState,
  SomaticMarker,
  SomaticMarkerInput,
  SomaticMatch,
} from './types.js';
import { AFFECT_CIRCUMPLEX, DEFAULT_DECAY_RATES } from './types.js';
import { computeAffectState } from './affect-decay.js';
import { matchSomaticMarkers, createContextHash, summarizeSomaticWarnings } from './somatic-markers.js';
import { logger } from '../lib/logger.js';

const MAX_ACTIVE_READINGS = 20;
const SOMATIC_MARKER_CACHE_SIZE = 100;

export class AffectEngine {
  private readings: AffectReading[] = [];
  private markerCache: SomaticMarker[] = [];
  private cacheLoaded = false;

  constructor(
    private db: DatabaseAdapter | null,
    private workspaceId: string,
  ) {}

  /**
   * Register a new affect (emotion).
   * Called when events occur: tool success/failure, novel patterns, stagnation, etc.
   */
  feel(type: AffectType, trigger: string, intensity: number = 0.5): AffectReading {
    const circumplex = AFFECT_CIRCUMPLEX[type];
    const reading: AffectReading = {
      type,
      intensity: Math.max(0, Math.min(1, intensity)),
      valence: circumplex.valence,
      arousal: circumplex.arousal,
      trigger,
      decayRate: DEFAULT_DECAY_RATES[type],
      timestamp: Date.now(),
    };

    this.readings.push(reading);

    // Cap active readings
    if (this.readings.length > MAX_ACTIVE_READINGS) {
      this.readings = this.readings.slice(-MAX_ACTIVE_READINGS);
    }

    logger.debug({ type, intensity, trigger }, 'affect: felt');
    return reading;
  }

  /** Get current aggregate affect state */
  getState(): AffectState {
    return computeAffectState(this.readings, Date.now());
  }

  /**
   * Check somatic markers for a given context.
   * Returns matching markers that may bias decision-making.
   */
  async checkSomaticMarkers(toolName: string, intent: string): Promise<SomaticMatch[]> {
    await this.ensureMarkerCache();
    const hash = createContextHash(toolName, intent);
    return matchSomaticMarkers(hash, toolName, this.markerCache);
  }

  /** Get somatic warning text for prompt injection, or null if none relevant */
  async getSomaticWarnings(toolName: string, intent: string): Promise<string | null> {
    const matches = await this.checkSomaticMarkers(toolName, intent);
    return summarizeSomaticWarnings(matches);
  }

  /**
   * Record a somatic marker from a tool execution outcome.
   * Creates emotional memory of this context + outcome for future reference.
   */
  async recordSomaticMarker(input: SomaticMarkerInput): Promise<void> {
    if (!this.db) return;

    try {
      await this.db.from('somatic_markers').insert({
        workspace_id: this.workspaceId,
        context_hash: input.contextHash,
        affect: input.affect,
        valence: input.valence,
        intensity: input.intensity,
        outcome: input.outcome,
        tool_name: input.toolName,
      });

      // Update cache
      this.markerCache.push({
        id: '',
        contextHash: input.contextHash,
        affect: input.affect as AffectType,
        valence: input.valence,
        intensity: input.intensity,
        outcome: input.outcome,
        toolName: input.toolName,
        createdAt: new Date().toISOString(),
      });

      if (this.markerCache.length > SOMATIC_MARKER_CACHE_SIZE) {
        this.markerCache = this.markerCache.slice(-SOMATIC_MARKER_CACHE_SIZE);
      }

      logger.debug({ affect: input.affect, outcome: input.outcome }, 'affect: somatic marker recorded');
    } catch (err) {
      logger.warn({ err }, 'affect: failed to record somatic marker');
    }
  }

  /**
   * Process a tool execution result and generate appropriate affects + somatic markers.
   * This is the main integration point called after each tool execution.
   */
  async processToolResult(
    toolName: string,
    intent: string,
    success: boolean,
    isNovel: boolean = false,
  ): Promise<void> {
    const hash = createContextHash(toolName, intent);

    if (success) {
      this.feel('satisfaction', `${toolName} succeeded`, 0.4);
      if (isNovel) {
        this.feel('curiosity', `novel result from ${toolName}`, 0.6);
      }
      await this.recordSomaticMarker({
        contextHash: hash,
        affect: 'satisfaction',
        valence: 0.8,
        intensity: 0.4,
        outcome: 'positive',
        toolName,
      });
    } else {
      this.feel('frustration', `${toolName} failed`, 0.6);

      // Check for repeated failures -> anxiety
      const recentFrustrations = this.readings.filter(
        r => r.type === 'frustration' && (Date.now() - r.timestamp) < 120_000
      );
      if (recentFrustrations.length >= 3) {
        this.feel('anxiety', `repeated failures (${recentFrustrations.length})`, 0.7);
      }

      await this.recordSomaticMarker({
        contextHash: hash,
        affect: 'frustration',
        valence: -0.7,
        intensity: 0.6,
        outcome: 'negative',
        toolName,
      });
    }
  }

  /**
   * Build prompt injection text for the system prompt.
   * Returns null if emotional state is neutral/unremarkable.
   */
  buildPromptContext(): string | null {
    const state = this.getState();

    // Don't inject if affects are weak
    if (state.affects.length === 0) return null;

    const dominantReading = state.affects.find(a => a.type === state.dominant);
    if (!dominantReading || dominantReading.intensity < 0.3) return null;

    const lines: string[] = [];
    lines.push(`Current affect: ${state.dominant} (valence: ${state.valence.toFixed(2)}, arousal: ${state.arousal.toFixed(2)})`);

    // Add guidance based on dominant affect
    const guidance = AFFECT_GUIDANCE[state.dominant];
    if (guidance) {
      lines.push(`Guidance: ${guidance}`);
    }

    return lines.join('\n');
  }

  /** Load somatic marker cache from database */
  private async ensureMarkerCache(): Promise<void> {
    if (this.cacheLoaded || !this.db) return;
    this.cacheLoaded = true;

    try {
      const { data } = await this.db
        .from('somatic_markers')
        .select('*')
        .eq('workspace_id', this.workspaceId)
        .order('created_at', { ascending: false })
        .limit(SOMATIC_MARKER_CACHE_SIZE);

      if (data) {
        this.markerCache = (data as Record<string, unknown>[]).map((row) => ({
          id: row.id as string,
          contextHash: row.context_hash as string,
          affect: row.affect as AffectType,
          valence: row.valence as number,
          intensity: row.intensity as number,
          outcome: row.outcome as 'positive' | 'negative' | 'neutral',
          toolName: (row.tool_name as string) ?? null,
          createdAt: row.created_at as string,
        }));
      }
    } catch (err) {
      logger.warn({ err }, 'affect: failed to load somatic markers');
    }
  }
}

/** Affect-specific guidance for prompt injection */
const AFFECT_GUIDANCE: Record<AffectType, string> = {
  curiosity: 'Explore further. This is a productive state for discovery.',
  satisfaction: 'Current approach is working well. Stay the course.',
  frustration: 'Consider changing strategy. The current approach may be blocked.',
  anxiety: 'Multiple failures detected. Break the task down or ask for human input.',
  excitement: 'High energy state. Channel into productive action but watch for hasty decisions.',
  boredom: 'Task may be too routine. Look for opportunities to automate or delegate.',
  pride: 'Recent success. Build on this momentum.',
  confusion: 'Unclear situation. Gather more information before acting.',
};
