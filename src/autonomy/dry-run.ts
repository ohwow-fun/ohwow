/**
 * Dry-run ranker (Phase 6.7 Deliverable C).
 *
 * Reads the live pulse + ledger and returns what `rankNextPhase` would
 * emit RIGHT NOW, without opening an arc, writing to any table, or
 * calling the executor. The MCP/HTTP surfaces use this so a human can
 * answer "what would the conductor pick if I ticked it now" without
 * triggering a real run.
 *
 * Strict no-write contract: no `db.from(...).insert/update/delete` calls
 * are reachable from this path. The only DB calls are the pulse reader,
 * ledger reader, and the workspace-wide answered-inbox pre-fetch — all
 * read-only.
 */
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { listAnsweredUnresolvedFounderInbox } from './director-persistence.js';
import { readFullPulse } from './pulse.js';
import { rankNextPhase, readLedgerSnapshot, type RankedPhase } from './ranker.js';

export interface DryRunOptions {
  /** Cap the returned candidates. Default: 10. */
  limit?: number;
  /**
   * Pin "now" for cadence / novelty / regression windows. Mostly for
   * tests; production callers leave it undefined.
   */
  refTimeMs?: number;
}

export interface DryRunSnapshot {
  workspace_id: string;
  ts: string;
  /** Top N candidates (default 10) sorted descending by score. */
  candidates: RankedPhase[];
  /** Total candidates the ranker emitted before the limit was applied. */
  total_candidates: number;
  /** Workspace-wide answered+unresolved inbox rows the next tick would seed. */
  pre_seed_inbox_count: number;
}

export async function dryRunRanker(
  db: DatabaseAdapter,
  workspace_id: string,
  opts: DryRunOptions = {},
): Promise<DryRunSnapshot> {
  const limit = Math.max(1, Math.floor(opts.limit ?? 10));
  const ts = new Date().toISOString();

  const [pulse, ledger, seedAnswered] = await Promise.all([
    readFullPulse(db, workspace_id),
    readLedgerSnapshot(db, workspace_id),
    listAnsweredUnresolvedFounderInbox(db, workspace_id),
  ]);

  const ranked = rankNextPhase({
    pulse,
    ledger,
    newly_answered: seedAnswered,
    refTimeMs: opts.refTimeMs,
  });

  return {
    workspace_id,
    ts,
    candidates: ranked.slice(0, limit),
    total_candidates: ranked.length,
    pre_seed_inbox_count: seedAnswered.length,
  };
}
