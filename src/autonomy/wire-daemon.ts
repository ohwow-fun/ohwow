/**
 * Daemon hook for the Conductor (Phase 5).
 *
 * Wired in `src/daemon/start.ts` so the daemon spawns the Conductor loop
 * alongside ImprovementScheduler when (and only when)
 * `OHWOW_AUTONOMY_CONDUCTOR=1` is set. Default: off. Production behavior
 * does not change unless the flag flips (gated by Phase 6's evaluation
 * harness).
 *
 * ImprovementScheduler is NOT modified — the Conductor runs in parallel.
 */
import { logger } from '../lib/logger.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import {
  CONDUCTOR_ENV_FLAG,
  defaultMakeStubExecutor,
  isConductorEnabled,
  startConductorLoop,
  type ConductorLoopHandle,
} from './conductor.js';
import { defaultDirectorIO } from './director.js';
import type { RoundExecutor } from './types.js';

/** Default tick: 1h (matches the spec's IMPROVEMENT_INTERVAL_MS default). */
export const DEFAULT_CONDUCTOR_INTERVAL_MS = 60 * 60 * 1000;

export interface WireConductorOptions {
  db: DatabaseAdapter;
  workspace_id: string;
  /** Defaults to DEFAULT_CONDUCTOR_INTERVAL_MS. */
  intervalMs?: number;
  /** Path to the runtime repo for SHA capture. */
  repoRoot?: string;
  /** Path to the cloud repo for SHA capture. */
  cloudRepoRoot?: string;
  /** Optional executor factory; defaults to the Phase-5 stub. */
  makeExecutor?: () => RoundExecutor;
}

/**
 * Returns null when the env flag is off (no loop started). Otherwise
 * returns a handle whose `stop()` clears the interval.
 */
export function wireConductor(
  opts: WireConductorOptions,
): ConductorLoopHandle | null {
  if (!isConductorEnabled()) {
    logger.info(
      `[daemon] Autonomy Conductor disabled (set ${CONDUCTOR_ENV_FLAG}=1 to enable)`,
    );
    return null;
  }
  const io = defaultDirectorIO({
    db: opts.db,
    repoRoot: opts.repoRoot,
    cloudRepoRoot: opts.cloudRepoRoot,
  });
  const handle = startConductorLoop({
    db: opts.db,
    io,
    workspace_id: opts.workspace_id,
    makeExecutor: opts.makeExecutor ?? defaultMakeStubExecutor,
    intervalMs: opts.intervalMs ?? DEFAULT_CONDUCTOR_INTERVAL_MS,
  });
  logger.info(
    {
      workspace_id: opts.workspace_id,
      intervalMs: opts.intervalMs ?? DEFAULT_CONDUCTOR_INTERVAL_MS,
    },
    '[daemon] Autonomy Conductor started (dark-launch)',
  );
  return handle;
}
