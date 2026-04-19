/**
 * Daemon init-related phases
 *
 * `initDaemon(ctx)` — the first step of the boot sequence after the
 * legacy-data-dir migration: config, instance-lock, SQLite, orphan cleanup,
 * business-context row.
 *
 * `createServices(ctx)` — scrapling + voicebox background services and
 * optional internet-deps installer. Runs after inference so
 * modelRouter-aware services can read ctx.modelRouter when needed.
 *
 * `createEngine(ctx)` — RuntimeEngine construction plus the diary hook.
 * Runs after the cloud phase because the engine's reportToCloud callback
 * captures ctx.controlPlane.
 */

import { randomUUID } from 'crypto';
import { dirname, basename, join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { signDaemonToken, verifyDaemonToken } from './token-codec.js';
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
import { ScraplingService } from '../execution/scrapling/index.js';
import { VoiceboxService } from '../voice/voicebox-service.js';
import { ensureInternetDeps } from '../lib/internet-installer.js';
import { findPythonCommand } from '../lib/platform-utils.js';
import { RuntimeEngine } from '../execution/engine.js';
import { installDiaryHook } from '../execution/diary-hook.js';
import { createBudgetMeter } from '../execution/budget-meter.js';
import { createEmittedTodayTracker } from '../execution/budget-middleware.js';
import { createEmailBudgetNotifier, createEventBusBudgetNotifier } from '../execution/budget-notifications.js';
import { createResendSender } from '../integrations/email/resend.js';
import type { BudgetPulseEvent } from '../execution/budget-middleware.js';
import type { DaemonContext } from './context.js';

export async function initDaemon(ctx: Partial<DaemonContext>): Promise<void> {
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

  // Reuse the existing session token if it is a valid JWT carrying this
  // workspace name. Mint and persist a new one if there's no token yet,
  // the file is missing, or the claim doesn't match (e.g. workspace rename).
  const tokenPath = join(dataDir, 'daemon.token');
  const workspaceName = basename(dataDir);
  let sessionToken: string | null = null;
  if (existsSync(tokenPath)) {
    try {
      const existing = readFileSync(tokenPath, 'utf8').trim();
      if (existing && config.jwtSecret) {
        const payload = await verifyDaemonToken(existing, config.jwtSecret);
        if (payload?.workspaceName === workspaceName) {
          sessionToken = existing;
        }
      } else if (existing) {
        // No jwtSecret yet — fall back to legacy UUID behaviour
        sessionToken = existing;
      }
    } catch { /* fall through to regenerate */ }
  }
  if (!sessionToken) {
    if (config.jwtSecret) {
      sessionToken = await signDaemonToken(workspaceName, config.jwtSecret);
    } else {
      // Fallback: no secret configured, use UUID (legacy / onboarding path)
      sessionToken = randomUUID();
    }
    try {
      writeFileSync(tokenPath, sessionToken, { mode: 0o600 });
    } catch { /* non-fatal; token still usable in-memory */ }
  }
  ctx.sessionToken = sessionToken;

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
  ctx.workspaceName = workspaceName;
}

export function createServices(ctx: Partial<DaemonContext>): void {
  const config = ctx.config!;

  const scraplingService = new ScraplingService({
    port: config.scraplingPort,
    autoStart: config.scraplingAutoStart,
    proxy: config.scraplingProxy || undefined,
    proxies: config.scraplingProxies.length > 0 ? config.scraplingProxies : undefined,
  });

  const voiceboxService = new VoiceboxService();

  // Auto-start Voicebox if Python is available (non-blocking)
  if (findPythonCommand()) {
    voiceboxService.start()
      .then(() => logger.info('[daemon] Voicebox auto-started'))
      .catch((err) => logger.debug(`[daemon] Voicebox auto-start skipped: ${(err as Error).message}`));
  }

  // Auto-install internet tool dependencies (non-blocking)
  ensureInternetDeps()
    .then(({ ytdlp, gh }) => logger.info(`[daemon] Internet deps: yt-dlp=${ytdlp ? 'ok' : 'unavailable'}, gh=${gh ? 'ok' : 'unavailable'}`))
    .catch((err) => logger.debug(`[daemon] Internet deps check skipped: ${(err as Error).message}`));

  ctx.scraplingService = scraplingService;
  ctx.voiceboxService = voiceboxService;
}

export async function createEngine(ctx: Partial<DaemonContext>): Promise<void> {
  const { config, db, rawDb, bus, sessionToken, dataDir, businessContext, modelRouter, scraplingService, controlPlane } = ctx as DaemonContext;

  const engine = new RuntimeEngine(db, {
    anthropicApiKey: config.anthropicApiKey,
    defaultModel: 'claude-sonnet-4-5',
    maxToolLoopIterations: 25,
    browserHeadless: config.browserHeadless,
    browserTarget: config.browserTarget,
    chromeCdpPort: config.chromeCdpPort,
    dataDir,
    mcpServers: config.mcpServers,
    claudeCodeCliPath: config.claudeCodeCliPath || undefined,
    claudeCodeCliModel: config.claudeCodeCliModel || undefined,
    claudeCodeCliMaxTurns: config.claudeCodeCliMaxTurns,
    claudeCodeCliPermissionMode: config.claudeCodeCliPermissionMode,
    claudeCodeCliAutodetect: config.claudeCodeCliAutodetect,
    modelSource: config.modelSource,
    daemonPort: config.port,
    daemonToken: sessionToken,
    desktopToolsEnabled: config.desktopToolsEnabled,
    workspaceName: ctx.workspaceName,
  }, {
    reportToCloud: controlPlane ? (report) => controlPlane.reportTask(report) : () => Promise.resolve(),
  }, businessContext, bus, modelRouter, scraplingService);

  // Diary hook: append a JSONL entry to <dataDir>/diary.jsonl on every
  // task completion. Cheap persistent memory for later reflection, and a
  // readable "what did my agents do today" log for the operator. Subscribe
  // on the bus the engine emits through.
  installDiaryHook(bus, rawDb, { dataDir });

  // Gap 13: wire the per-workspace autonomous LLM daily cap middleware.
  // The meter sums today's `llm_calls.cost_cents` rows (origin='autonomous').
  // The tracker keeps each of the four band transitions firing at most
  // once per workspace per UTC day. The bus notifier adapts pulse events
  // onto the runtime EventBus as `budget:llm-*` events so the TUI + web
  // dashboard render them as in-app toasts. Every agent-task LLM call
  // now flows through this path via `llm-executor.ts` reading
  // `ctx.budgetDeps`.
  //
  // Follow-up: pause/halt also email the operator (warn/degrade stay
  // dashboard-only). The email leg resolves three pieces via runtime
  // settings or env; missing any one of them skips email silently.
  const emailNotifier = await resolveEmailBudgetNotifier(ctx as DaemonContext);
  const busNotifier = createEventBusBudgetNotifier(bus);
  const emitPulse = emailNotifier
    ? (event: BudgetPulseEvent) => { busNotifier(event); emailNotifier(event); }
    : busNotifier;
  const budgetDeps = {
    meter: createBudgetMeter(db),
    emittedToday: createEmittedTodayTracker(),
    emitPulse,
  };
  engine.setBudgetDeps(budgetDeps, config.autonomousSpendLimitUsd);

  ctx.engine = engine;
}

/**
 * Resolve the optional email-budget-notifier from runtime settings + env.
 * Returns undefined when any of the three pieces is missing (API key,
 * operator inbox, from-address); skip is silent with an info log so the
 * operator sees why no email is going out without a noisy warn.
 *
 * Settings sources, each checked in order (env first, then the SQLite
 * runtime_settings row):
 *   - API key      : RESEND_API_KEY               | runtime_settings.resend_api_key
 *   - Operator inbox: OHWOW_OPERATOR_EMAIL       | runtime_settings.operator_email
 *   - From-address : OHWOW_OUTREACH_EMAIL_FROM   | runtime_settings.outreach_email_from
 *
 * The from-address is the same field EmailDispatcher uses for outreach —
 * intentional reuse so operators configure one verified Resend sender and
 * both flows benefit.
 */
async function resolveEmailBudgetNotifier(
  ctx: DaemonContext,
): Promise<((event: BudgetPulseEvent) => void) | undefined> {
  const { db } = ctx;
  const readSetting = async (key: string): Promise<string | undefined> => {
    try {
      const { data } = await db
        .from<{ value: string }>('runtime_settings')
        .select('value')
        .eq('key', key)
        .maybeSingle();
      return (data as { value: string } | null)?.value || undefined;
    } catch {
      return undefined;
    }
  };

  const apiKey = process.env.RESEND_API_KEY || (await readSetting('resend_api_key'));
  const toAddress = process.env.OHWOW_OPERATOR_EMAIL || (await readSetting('operator_email'));
  const fromAddress = process.env.OHWOW_OUTREACH_EMAIL_FROM || (await readSetting('outreach_email_from'));

  if (!apiKey || !toAddress || !fromAddress) {
    logger.info(
      {
        hasApiKey: Boolean(apiKey),
        hasToAddress: Boolean(toAddress),
        hasFromAddress: Boolean(fromAddress),
      },
      '[daemon] budget email notifier skipped; set RESEND_API_KEY + OHWOW_OPERATOR_EMAIL + OHWOW_OUTREACH_EMAIL_FROM (or the matching runtime_settings keys) to enable',
    );
    return undefined;
  }

  const emailSender = createResendSender({
    getApiKey: async () => apiKey,
    fromAddress,
  });
  logger.info(
    { to: toAddress, from: fromAddress },
    '[daemon] budget email notifier wired (pause/halt bands only)',
  );
  return createEmailBudgetNotifier({ emailSender, toAddress, fromAddress });
}
