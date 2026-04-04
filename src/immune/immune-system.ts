/**
 * ImmuneSystem — Main orchestrator for layered threat defense
 * Coordinates innate scanning, adaptive memory, inflammatory response, and tolerance.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type {
  ThreatDetection,
  ThreatSignature,
  ImmuneMemory,
  InflammatoryState,
  AutoimmuneIndicator,
  PathogenType,
} from './types.js';
import { scanInnate } from './innate-immunity.js';
import { matchImmuneMemory, learnThreat, computeResponseEffectiveness } from './adaptive-immunity.js';
import {
  computeAlertLevel,
  computeCooldown,
  createInitialInflammatoryState,
  tryDeescalate,
} from './inflammatory-response.js';
import { detectAutoimmune } from './tolerance.js';
import { logger } from '../lib/logger.js';

export class ImmuneSystem {
  private inflammatoryState: InflammatoryState;
  private memories: ImmuneMemory[] = [];
  private learnedSignatures: ThreatSignature[] = [];
  private recentDetections: { detected: boolean; wasFalsePositive: boolean }[] = [];
  private incidentTimestamps: number[] = [];

  constructor(
    private db: DatabaseAdapter | null,
    private workspaceId: string,
  ) {
    this.inflammatoryState = createInitialInflammatoryState();
  }

  /**
   * Scan input for threats using innate + adaptive layers.
   */
  scan(input: string, context?: string): ThreatDetection {
    // Layer 1: Innate pattern scan
    const innateResult = scanInnate(input, this.learnedSignatures);

    // Layer 2: Adaptive memory check
    if (!innateResult.detected && context) {
      const contextHash = this.hashContext(context);
      const memoryMatch = matchImmuneMemory(contextHash, this.memories);

      if (memoryMatch && memoryMatch.occurrences >= 2 && memoryMatch.responseEffectiveness > 0.6) {
        return {
          detected: true,
          pathogenType: memoryMatch.pathogenType,
          confidence: memoryMatch.responseEffectiveness * 0.8,
          matchedSignature: null,
          recommendation: memoryMatch.occurrences >= 5 ? 'block' : 'flag',
          reason: `Adaptive memory match: seen ${memoryMatch.occurrences} times before (effectiveness: ${memoryMatch.responseEffectiveness.toFixed(2)})`,
        };
      }
    }

    // Boost confidence at elevated+ alert levels
    if (innateResult.detected && this.inflammatoryState.alertLevel !== 'normal') {
      return {
        ...innateResult,
        confidence: Math.min(1, innateResult.confidence * 1.2),
        recommendation: innateResult.recommendation === 'flag' ? 'block' : innateResult.recommendation,
      };
    }

    return innateResult;
  }

  /**
   * Respond to a detection: update inflammatory state and record incident.
   */
  respond(detection: ThreatDetection): void {
    const now = Date.now();

    if (detection.detected) {
      this.incidentTimestamps.push(now);
      this.inflammatoryState.consecutiveThreats++;

      // Count threats in last hour
      const oneHourAgo = now - 60 * 60 * 1000;
      this.incidentTimestamps = this.incidentTimestamps.filter(t => t > oneHourAgo);
      this.inflammatoryState.recentThreats = this.incidentTimestamps.length;

      const newLevel = computeAlertLevel(
        this.inflammatoryState.recentThreats,
        this.inflammatoryState.consecutiveThreats,
        this.inflammatoryState.alertLevel,
      );

      if (newLevel !== this.inflammatoryState.alertLevel) {
        const previousLevel = this.inflammatoryState.alertLevel;
        this.inflammatoryState.alertLevel = newLevel;
        this.inflammatoryState.escalatedAt = now;
        this.inflammatoryState.cooldownUntil = now + computeCooldown(newLevel);
        logger.info({ from: previousLevel, to: newLevel, threats: this.inflammatoryState.recentThreats }, 'immune: alert level changed');
        this.persistStateTransition(previousLevel, newLevel).catch(() => {});
      }

      this.persistIncident(detection).catch(() => {});
    } else {
      this.inflammatoryState.consecutiveThreats = 0;

      // Try de-escalation
      this.inflammatoryState = tryDeescalate(this.inflammatoryState, now);
    }

    this.recentDetections.push({ detected: detection.detected, wasFalsePositive: false });
    if (this.recentDetections.length > 100) this.recentDetections.shift();
  }

  /**
   * Learn from a confirmed threat to strengthen adaptive immunity.
   */
  learn(pathogenType: PathogenType, contextHash: string): void {
    this.memories = learnThreat(pathogenType, contextHash, this.memories);
    logger.debug({ pathogenType, contextHash }, 'immune: learned new threat');
    this.persistMemories().catch(() => {});
  }

  /**
   * Mark a previous detection as a false positive.
   */
  markFalsePositive(contextHash: string): void {
    // Update memory effectiveness
    const memoryIdx = this.memories.findIndex(m => m.contextHash === contextHash);
    if (memoryIdx !== -1) {
      this.memories[memoryIdx] = computeResponseEffectiveness(this.memories[memoryIdx], false);
    }

    // Record in detection history
    const lastDetection = this.recentDetections[this.recentDetections.length - 1];
    if (lastDetection) {
      lastDetection.wasFalsePositive = true;
    }

    logger.info({ contextHash }, 'immune: marked false positive');
  }

  /**
   * Check for autoimmune behavior (excessive false positives).
   */
  checkAutoimmune(): AutoimmuneIndicator {
    return detectAutoimmune(this.recentDetections);
  }

  /**
   * Get current inflammatory state.
   */
  getInflammatoryState(): InflammatoryState {
    return { ...this.inflammatoryState };
  }

  /**
   * Build prompt context for elevated+ alert levels.
   * Returns null when alert level is normal.
   */
  buildPromptContext(): string | null {
    if (this.inflammatoryState.alertLevel === 'normal') return null;

    const lines = [
      `Immune alert level: ${this.inflammatoryState.alertLevel.toUpperCase()}`,
      `Recent threats: ${this.inflammatoryState.recentThreats} in the last hour`,
      `Consecutive threats: ${this.inflammatoryState.consecutiveThreats}`,
    ];

    if (this.inflammatoryState.alertLevel === 'quarantine') {
      lines.push('System is in quarantine mode. All inputs should be treated with heightened scrutiny.');
    } else if (this.inflammatoryState.alertLevel === 'critical') {
      lines.push('Critical threat level. Validate all inputs carefully before processing.');
    }

    return lines.join('\n');
  }

  /**
   * Load immune state from database.
   */
  async loadState(): Promise<void> {
    if (!this.db) return;

    try {
      // Load learned signatures
      const { data: sigs } = await this.db
        .from('threat_signatures')
        .select('*')
        .eq('workspace_id', this.workspaceId)
        .eq('origin', 'learned');

      if (sigs) {
        this.learnedSignatures = (sigs as Record<string, unknown>[]).map(row => ({
          id: row.id as string,
          pathogenType: row.pathogen_type as PathogenType,
          pattern: row.pattern as string,
          severity: row.severity as number,
          origin: 'learned' as const,
          falsePositiveRate: row.false_positive_rate as number,
          lastSeen: row.last_seen as string | null,
        }));
      }

      // Load immune memories
      const { data: mems } = await this.db
        .from('immune_memories')
        .select('*')
        .eq('workspace_id', this.workspaceId);

      if (mems) {
        this.memories = (mems as Record<string, unknown>[]).map(row => ({
          id: row.id as string,
          pathogenType: row.pathogen_type as PathogenType,
          contextHash: row.context_hash as string,
          occurrences: row.occurrences as number,
          lastOccurrence: row.last_occurrence as string,
          responseEffectiveness: row.response_effectiveness as number,
        }));
      }
    } catch (err) {
      logger.warn({ err }, 'immune: failed to load state');
    }
  }

  private async persistStateTransition(fromLevel: string, toLevel: string): Promise<void> {
    if (!this.db) return;

    try {
      await this.db.from('immune_state_transitions').insert({
        workspace_id: this.workspaceId,
        from_level: fromLevel,
        to_level: toLevel,
      });
    } catch {
      // Table may not exist yet (migration 075); non-fatal
    }
  }

  private hashContext(context: string): string {
    // Simple hash for context deduplication
    let hash = 0;
    for (let i = 0; i < context.length; i++) {
      const char = context.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  private async persistIncident(detection: ThreatDetection): Promise<void> {
    if (!this.db) return;

    try {
      await this.db.from('immune_incidents').insert({
        workspace_id: this.workspaceId,
        pathogen_type: detection.pathogenType,
        confidence: detection.confidence,
        recommendation: detection.recommendation,
        matched_signature: detection.matchedSignature,
        reason: detection.reason,
      });
    } catch (err) {
      logger.warn({ err }, 'immune: failed to persist incident');
    }
  }

  private async persistMemories(): Promise<void> {
    if (!this.db) return;

    try {
      for (const mem of this.memories) {
        try {
          await this.db.from('immune_memories').insert({
            id: mem.id,
            workspace_id: this.workspaceId,
            pathogen_type: mem.pathogenType,
            context_hash: mem.contextHash,
            occurrences: mem.occurrences,
            last_occurrence: mem.lastOccurrence,
            response_effectiveness: mem.responseEffectiveness,
          });
        } catch {
          await this.db.from('immune_memories')
            .update({
              occurrences: mem.occurrences,
              last_occurrence: mem.lastOccurrence,
              response_effectiveness: mem.responseEffectiveness,
            })
            .eq('id', mem.id);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'immune: failed to persist memories');
    }
  }
}
