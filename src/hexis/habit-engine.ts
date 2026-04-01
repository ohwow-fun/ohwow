/**
 * HabitEngine — main entry point for the Hexis habit formation system.
 * Manages the cue-routine-reward loop with automaticity gradient.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type {
  Habit,
  HabitCue,
  HabitMatch,
  BadHabitIndicator,
} from './types.js';
import { DEFAULT_DECAY_RATE } from './types.js';
import { detectCues } from './cue-detector.js';
import { computeStrength, computeAutomaticity } from './habit-strength.js';
import { detectBadHabits } from './bad-habit-detector.js';
import { logger } from '../lib/logger.js';

interface HabitRow {
  id: string;
  workspace_id: string;
  name: string;
  cue: string;
  routine: string;
  reward: string;
  strength: number;
  automaticity: string;
  success_rate: number;
  execution_count: number;
  last_executed: string | null;
  decay_rate: number;
  created_at: string;
}

export class HabitEngine {
  private habits: Habit[] = [];

  constructor(
    private db: DatabaseAdapter | null,
    private workspaceId: string,
  ) {}

  /**
   * Load all habits for this workspace from the database.
   */
  async loadHabits(): Promise<void> {
    if (!this.db) return;

    const { data, error } = await this.db
      .from<HabitRow>('habits')
      .select()
      .eq('workspace_id', this.workspaceId)
      .order('strength', { ascending: false });

    if (error) {
      logger.error({ error }, 'hexis: failed to load habits');
      return;
    }

    this.habits = (data ?? []).map((row) => this.rowToHabit(row));
    logger.debug({ count: this.habits.length }, 'hexis: loaded habits');
  }

  /**
   * Match current context against all known habits.
   */
  checkCues(intent: string, recentTools: string[]): HabitMatch[] {
    return detectCues(intent, recentTools, this.habits);
  }

  /**
   * Generate a human-readable shortcut suggestion for a habit match.
   */
  proposeShortcut(match: HabitMatch): string {
    const { habit, savingsEstimate } = match;
    const auto = habit.automaticity === 'automatic'
      ? ' (fully automatic)'
      : habit.automaticity === 'semi_automatic'
        ? ' (semi-automatic)'
        : '';

    return `Habit "${habit.name}"${auto}: ${habit.routine.description} — ${savingsEstimate}`;
  }

  /**
   * Record that a habit was executed and update its strength/automaticity.
   */
  async recordExecution(habitId: string, success: boolean): Promise<void> {
    const habit = this.habits.find((h) => h.id === habitId);
    if (!habit) {
      logger.warn({ habitId }, 'hexis: cannot record execution for unknown habit');
      return;
    }

    // Update running stats
    const totalSuccess = habit.successRate * habit.executionCount + (success ? 1 : 0);
    habit.executionCount += 1;
    habit.successRate = totalSuccess / habit.executionCount;
    habit.lastExecuted = new Date().toISOString();

    // Recompute strength and automaticity
    habit.strength = computeStrength(habit.executionCount, habit.successRate, 0, habit.decayRate);
    habit.automaticity = computeAutomaticity(habit.strength, habit.executionCount, habit.successRate);

    // Persist habit and execution record
    await this.persistHabit(habit);
    await this.persistExecution(habitId, success);

    logger.info(
      { habitId, strength: habit.strength, automaticity: habit.automaticity, success },
      'hexis: recorded execution',
    );
  }

  /**
   * Promote a discovered pattern into a new habit.
   */
  async promotePattern(
    name: string,
    toolSequence: string[],
    cue: HabitCue,
    expectedOutcome: string,
  ): Promise<Habit> {
    const id = this.generateId();
    const now = new Date().toISOString();

    const habit: Habit = {
      id,
      name,
      cue,
      routine: {
        toolSequence,
        description: `Execute ${toolSequence.join(' -> ')}`,
        estimatedDurationMs: toolSequence.length * 2000,
      },
      reward: {
        expectedOutcome,
        successMetric: 'task_completed',
        averageRewardValue: 0.5,
      },
      strength: 0.1,
      automaticity: 'deliberate',
      successRate: 0.5,
      executionCount: 0,
      lastExecuted: null,
      createdAt: now,
      decayRate: DEFAULT_DECAY_RATE,
    };

    this.habits.push(habit);
    await this.persistHabit(habit);

    logger.info({ habitId: id, name }, 'hexis: promoted pattern to habit');
    return habit;
  }

  /**
   * Check all habits for bad habit indicators.
   */
  checkBadHabits(): BadHabitIndicator[] {
    return detectBadHabits(this.habits);
  }

  /**
   * Build prompt context text for habit shortcut suggestions.
   * Returns null when there are no matches.
   */
  buildPromptContext(matches: HabitMatch[]): string | null {
    if (matches.length === 0) return null;

    const lines = matches.map((m) => `  - ${this.proposeShortcut(m)}`);
    return [
      '## Available Habit Shortcuts',
      '',
      'The following habits match the current context:',
      ...lines,
      '',
      'Consider using these established routines for faster execution.',
    ].join('\n');
  }

  /**
   * Persist a habit to the database.
   */
  async persistHabit(habit: Habit): Promise<void> {
    if (!this.db) return;

    const row = {
      id: habit.id,
      workspace_id: this.workspaceId,
      name: habit.name,
      cue: JSON.stringify(habit.cue),
      routine: JSON.stringify(habit.routine),
      reward: JSON.stringify(habit.reward),
      strength: habit.strength,
      automaticity: habit.automaticity,
      success_rate: habit.successRate,
      execution_count: habit.executionCount,
      last_executed: habit.lastExecuted,
      decay_rate: habit.decayRate,
      created_at: habit.createdAt,
    };

    // Upsert: delete then insert (SQLite adapter may not support upsert)
    await this.db.from('habits').delete().eq('id', habit.id);
    const { error } = await this.db.from('habits').insert(row);

    if (error) {
      logger.error({ error, habitId: habit.id }, 'hexis: failed to persist habit');
    }
  }

  /**
   * Get the current in-memory habits (useful for testing).
   */
  getHabits(): Habit[] {
    return this.habits;
  }

  // ── Private ──────────────────────────────────────────────────────────

  private async persistExecution(habitId: string, success: boolean): Promise<void> {
    if (!this.db) return;

    const { error } = await this.db.from('habit_executions').insert({
      id: this.generateId(),
      workspace_id: this.workspaceId,
      habit_id: habitId,
      success: success ? 1 : 0,
      created_at: new Date().toISOString(),
    });

    if (error) {
      logger.error({ error, habitId }, 'hexis: failed to persist execution');
    }
  }

  private rowToHabit(row: HabitRow): Habit {
    return {
      id: row.id,
      name: row.name,
      cue: JSON.parse(row.cue),
      routine: JSON.parse(row.routine),
      reward: JSON.parse(row.reward),
      strength: row.strength,
      automaticity: row.automaticity as Habit['automaticity'],
      successRate: row.success_rate,
      executionCount: row.execution_count,
      lastExecuted: row.last_executed,
      createdAt: row.created_at,
      decayRate: row.decay_rate,
    };
  }

  private generateId(): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
