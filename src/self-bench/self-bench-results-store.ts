/**
 * self-bench-results-store — persistence for A/B experiment outcomes.
 *
 * Inserts experiment results into self_bench_results so they survive
 * daemon restarts and inform future experiment selection.
 */

import { randomUUID } from 'crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

export interface SelfBenchResult {
  experimentId: string;
  configA: string;
  configB: string;
  winner?: string;
  scoreA?: number;
  scoreB?: number;
  verdict?: string;
  rawJson?: string;
}

export interface SelfBenchResultRow {
  id: string;
  workspace_id: string;
  experiment_id: string;
  config_a: string;
  config_b: string;
  winner: string | null;
  score_a: number | null;
  score_b: number | null;
  verdict: string | null;
  raw_json: string | null;
  created_at: string;
}

export class SelfBenchResultsStore {
  constructor(
    private db: DatabaseAdapter,
    private workspaceId: string,
  ) {}

  /** Persist a completed experiment result. */
  async save(result: SelfBenchResult): Promise<string> {
    const id = randomUUID();
    await this.db
      .from('self_bench_results')
      .insert({
        id,
        workspace_id: this.workspaceId,
        experiment_id: result.experimentId,
        config_a: result.configA,
        config_b: result.configB,
        winner: result.winner ?? null,
        score_a: result.scoreA ?? null,
        score_b: result.scoreB ?? null,
        verdict: result.verdict ?? null,
        raw_json: result.rawJson ?? null,
      });
    logger.debug(`[SelfBenchResultsStore] saved result ${id} for experiment ${result.experimentId}`);
    return id;
  }

  /** Retrieve the last N results for this workspace. */
  async getSelfBenchHistory(limit = 20): Promise<SelfBenchResultRow[]> {
    const { data, error } = await this.db
      .from<SelfBenchResultRow>('self_bench_results')
      .select('*')
      .eq('workspace_id', this.workspaceId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      logger.warn(`[SelfBenchResultsStore] getSelfBenchHistory error: ${error}`);
      return [];
    }
    const rows = (data ?? []) as SelfBenchResultRow[];
    return rows;
  }

  /** Check whether a specific A/B pair was already tested recently (24h). */
  async wasRecentlyTested(configA: string, configB: string, windowHours = 24): Promise<boolean> {
    const cutoff = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
    const { count } = await this.db
      .from('self_bench_results')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', this.workspaceId)
      .eq('config_a', configA)
      .eq('config_b', configB)
      .gte('created_at', cutoff);
    return (count ?? 0) > 0;
  }
}
