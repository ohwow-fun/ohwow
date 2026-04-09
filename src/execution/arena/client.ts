/**
 * External Arena Client — Connect to remote training environments
 *
 * Allows ohwow agents to train in external arenas (including
 * Gym-Anything environments) via HTTP. Converts between the
 * external wire format and ohwow's internal types.
 *
 * Usage:
 *   const client = new ExternalArenaClient('http://localhost:8080/arena/blender');
 *   const obs = await client.reset();
 *   const result = await client.step({ toolName: 'click', input: { x: 100, y: 200 } });
 */

import type { Observation, ArenaAction, StepResult, StepInfo } from './types.js';
import type { ToolCallOutcome } from '../../orchestrator/tool-executor.js';
import { logger } from '../../lib/logger.js';

// ============================================================================
// CLIENT
// ============================================================================

export class ExternalArenaClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private timeoutMs: number;

  constructor(
    baseUrl: string,
    options?: {
      /** Authorization header value. */
      authToken?: string;
      /** Request timeout in ms (default 30s). */
      timeoutMs?: number;
    },
  ) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      ...(options?.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}),
    };
    this.timeoutMs = options?.timeoutMs ?? 30_000;
  }

  /**
   * Reset the environment and get the initial observation.
   */
  async reset(): Promise<Observation> {
    const data = await this.post('/reset', {});
    const obs = (data.observation ?? data) as Record<string, unknown>;
    return this.parseObservation(obs);
  }

  /**
   * Take a step in the environment.
   */
  async step(action: ArenaAction): Promise<StepResult> {
    const data = await this.post('/step', {
      tool_name: action.toolName,
      input: action.input,
    });

    return {
      observation: this.parseObservation((data.observation ?? data) as Record<string, unknown>),
      reward: typeof data.reward === 'number' ? data.reward : 0,
      done: Boolean(data.done),
      truncated: Boolean(data.truncated),
      info: this.parseInfo((data.info ?? data) as Record<string, unknown>),
    };
  }

  /**
   * Get current observation without stepping.
   */
  async observe(): Promise<Observation> {
    const data = await this.get('/observe');
    return this.parseObservation((data.observation ?? data) as Record<string, unknown>);
  }

  /**
   * Get available actions.
   */
  async getActionSpace(): Promise<string[]> {
    const data = await this.get('/actions');
    return Array.isArray(data.action_space) ? data.action_space : [];
  }

  /**
   * Get current episode summary.
   */
  async getEpisode(): Promise<Record<string, unknown> | null> {
    try {
      return await this.get('/episode');
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // HTTP HELPERS
  // --------------------------------------------------------------------------

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Arena POST ${path} failed: ${res.status} ${text}`);
      }

      return (await res.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async get(path: string): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: this.headers,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Arena GET ${path} failed: ${res.status} ${text}`);
      }

      return (await res.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timeout);
    }
  }

  // --------------------------------------------------------------------------
  // FORMAT CONVERSION
  // --------------------------------------------------------------------------

  /**
   * Convert external observation format to ohwow Observation.
   * Handles both ohwow wire format and Gym-Anything format.
   */
  private parseObservation(raw: Record<string, unknown>): Observation {
    return {
      screenshot: raw.screenshot as string | undefined ?? raw.screen as string | undefined,
      dom: raw.dom as string | undefined,
      text: raw.text as string | undefined ?? raw.content as string | undefined,
      structuredData: raw.structuredData ?? raw.structured_data ?? raw.data,
      affordances: Array.isArray(raw.affordances) ? raw.affordances : [],
      umwelt: Array.isArray(raw.umwelt) ? raw.umwelt : [],
      metadata: {
        url: raw.url as string | undefined
          ?? (raw.metadata as Record<string, unknown>)?.url as string | undefined,
        app: raw.app as string | undefined
          ?? (raw.metadata as Record<string, unknown>)?.app as string | undefined,
        timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : Date.now(),
        stepNumber: typeof raw.step_number === 'number' ? raw.step_number
          : typeof (raw.metadata as Record<string, unknown>)?.stepNumber === 'number'
            ? (raw.metadata as Record<string, unknown>).stepNumber as number
            : 0,
      },
    };
  }

  private parseInfo(raw: Record<string, unknown>): StepInfo {
    const outcome: ToolCallOutcome = {
      toolName: (raw.tool_name as string) ?? 'unknown',
      result: { success: Boolean(raw.tool_success ?? true) },
      resultContent: '',
      isError: !raw.tool_success,
    };

    return {
      toolOutcome: outcome,
      durationMs: typeof raw.duration_ms === 'number' ? raw.duration_ms : 0,
      cumulativeReward: typeof raw.cumulative_reward === 'number' ? raw.cumulative_reward : 0,
      stepsRemaining: typeof raw.steps_remaining === 'number' ? raw.steps_remaining : 0,
    };
  }
}
