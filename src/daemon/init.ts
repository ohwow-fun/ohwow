/**
 * Daemon init phase
 *
 * First step of the boot sequence after the legacy-data-dir migration.
 * Loads config, acquires the single-instance lock, opens the SQLite DB,
 * clears orphaned rows from a prior crash, and reads the business
 * context row. Populates ctx.{config, dataDir, pidPath, rawDb, db, bus,
 * sessionToken, startTime, businessContext}. Throws if config is missing,
 * onboarding is incomplete, or another daemon holds the lock.
 */

import { randomUUID } from 'crypto';
import { dirname } from 'path';
import { TypedEventBus } from '../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../tui/types.js';
import { loadConfig, isFirstRun } from '../config.js';
import type { RuntimeConfig } from '../config.js';
import { initDatabase } from '../db/init.js';
import { createSqliteAdapter } from '../db/sqlite-adapter.js';
import { createRpcHandlers } from '../db/rpc-handlers.js';
import type { BusinessContext } from '../execution/types.js';
import { acquireLock } from '../lib/instance-lock.js';
import { getPidPath } from './lifecycle.js';
import { VERSION } from '../version.js';
import { logger } from '../lib/logger.js';
import type { DaemonContext } from './context.js';

export async function initDaemon(ctx: Partial<DaemonContext>): Promise<void> {
  ctx.sessionToken = randomUUID();

  // 1. Load config
  let config: RuntimeConfig;
  try {
    config = loadConfig();
  } catch {
    throw new Error('No config found. Run ohwow to complete onboarding first.');
  }

  if (isFirstRun()) {
    throw new Error('Onboarding not complete. Run ohwow to complete onboarding first.');
  }

  const dataDir = dirname(config.dbPath);
  const pidPath = getPidPath(dataDir);

  // 2. Pre-check: is another daemon running? (before binding port)
  if (!acquireLock(pidPath, config.port, VERSION)) {
    throw new Error(`Daemon already running. Check ${pidPath}`);
  }

  logger.info(`[daemon] ohwow v${VERSION} (role: ${config.deviceRole})`);
  logger.info(`[daemon] Tier: ${config.tier}`);
  logger.info(`[daemon] Port: ${config.port}`);
  logger.info(`[daemon] DB: ${config.dbPath}`);

  // 3. Initialize SQLite
  const rawDb = initDatabase(config.dbPath);
  const rpcHandlers = createRpcHandlers(rawDb);
  const db = createSqliteAdapter(rawDb, { rpcHandlers });

  const startTime = Date.now();
  const bus = new TypedEventBus<RuntimeEvents>();

  // 3b. Clean up orphaned tasks/agents/conversations from previous crash
  try {
    const now = new Date().toISOString();
    const stuckTasks = rawDb.prepare(
      "UPDATE agent_workforce_tasks SET status = 'failed', error_message = 'Daemon restarted while task was running', completed_at = ?, updated_at = ? WHERE status = 'in_progress'"
    ).run(now, now);
    const stuckAgents = rawDb.prepare(
      "UPDATE agent_workforce_agents SET status = 'idle', updated_at = ? WHERE status = 'working'"
    ).run(now);
    // Any 'running' conversation on startup is orphaned: orchestrator messages are
    // buffered in memory across a turn and lost if the daemon exits mid-turn.
    const stuckConvs = rawDb.prepare(
      "UPDATE orchestrator_conversations SET status = 'error', last_error = 'orphaned by daemon restart' WHERE status = 'running'"
    ).run();
    if (stuckTasks.changes > 0 || stuckAgents.changes > 0 || stuckConvs.changes > 0) {
      logger.info(`[daemon] Recovered ${stuckTasks.changes} orphaned task(s), ${stuckAgents.changes} stuck agent(s), ${stuckConvs.changes} orphaned conversation(s)`);
    }
  } catch (err) {
    logger.warn(`[daemon] Orphan cleanup failed: ${err instanceof Error ? err.message : err}`);
  }

  // 4. Read business context from DB.
  // The agent_workforce_workspaces table holds exactly one row per DB file
  // (seeded as 'local' by migration 018, later rewritten to the cloud
  // workspace UUID by the consolidation step below). LIMIT 1 reads the
  // current row regardless of which identity it carries — necessary now that
  // each on-disk workspace has its own DB file.
  let businessContext: BusinessContext = {
    businessName: 'My Business',
    businessType: 'saas_startup',
  };
  try {
    const row = rawDb.prepare(
      'SELECT business_name, business_type FROM agent_workforce_workspaces LIMIT 1'
    ).get() as { business_name: string; business_type: string } | undefined;
    if (row?.business_name) {
      businessContext = {
        businessName: row.business_name,
        businessType: row.business_type || 'saas_startup',
      };
    }
  } catch {
    // Table may not exist yet
  }

  ctx.config = config;
  ctx.dataDir = dataDir;
  ctx.pidPath = pidPath;
  ctx.rawDb = rawDb;
  ctx.db = db;
  ctx.bus = bus;
  ctx.startTime = startTime;
  ctx.businessContext = businessContext;
}
