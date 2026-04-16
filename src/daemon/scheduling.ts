/**
 * Daemon scheduling + self-bench phase
 *
 * The primary-only block that boots every scheduler, engine, loop, and
 * self-bench experiment. Workers skip this phase entirely (task execution
 * only). Lives behind one extraction for now; a follow-up commit splits
 * the experimentRunner registrations out into experiments.ts.
 *
 * Populates ctx.scheduler, ctx.proactiveEngine, ctx.connectorSyncScheduler
 * so shutdown and the HTTP onScheduleChange callback can find them.
 */

import { ExperimentRunner } from '../self-bench/experiment-runner.js';
import { ModelHealthExperiment } from '../self-bench/experiments/model-health.js';
import { TriggerStabilityExperiment } from '../self-bench/experiments/trigger-stability.js';
import { CanaryExperiment } from '../self-bench/experiments/canary-experiment.js';
import { LedgerHealthExperiment } from '../self-bench/experiments/ledger-health.js';
import { BurnRateExperiment } from '../self-bench/experiments/burn-rate.js';
import { ThroughputDailyExperiment } from '../self-bench/experiments/throughput-daily.js';
import { InterventionAuditExperiment } from '../self-bench/experiments/intervention-audit.js';
import { StaleTaskCleanupExperiment } from '../self-bench/experiments/stale-task-cleanup.js';
import { StrategistExperiment } from '../self-bench/experiments/strategist.js';
import { StaleTaskThresholdTunerExperiment } from '../self-bench/experiments/stale-threshold-tuner.js';
import { ContentCadenceTunerExperiment } from '../self-bench/experiments/content-cadence-tuner.js';
import { ContentCadenceLoopHealthExperiment } from '../self-bench/experiments/content-cadence-loop-health.js';
import { AdaptiveSchedulerExperiment } from '../self-bench/experiments/adaptive-scheduler.js';
import { AgentCoverageGapExperiment } from '../self-bench/experiments/agent-coverage-gap.js';
import { ExperimentProposalGenerator } from '../self-bench/experiments/experiment-proposal-generator.js';
import { ExperimentAuthorExperiment } from '../self-bench/experiments/experiment-author.js';
import { ListHandlersFuzzExperiment } from '../self-bench/experiments/list-handlers-fuzz.js';
import { HandlerSchemaDriftExperiment } from '../self-bench/experiments/handler-schema-drift.js';
import { ProseInvariantDriftExperiment } from '../self-bench/experiments/prose-invariant-drift.js';
import { AgentOutcomesExperiment } from '../self-bench/experiments/agent-outcomes.js';
import { AutonomousAuthorQualityExperiment } from '../self-bench/experiments/autonomous-author-quality.js';
import { AutonomousPatchRollbackExperiment } from '../self-bench/experiments/autonomous-patch-rollback.js';
import { PatchAuthorExperiment } from '../self-bench/experiments/patch-author.js';
import { FormatDurationFuzzExperiment } from '../self-bench/experiments/format-duration-fuzz.js';
import { TokenSimilarityFuzzExperiment } from '../self-bench/experiments/token-similarity-fuzz.js';
import { StagnationFuzzExperiment } from '../self-bench/experiments/stagnation-fuzz.js';
import { ErrorClassificationFuzzExperiment } from '../self-bench/experiments/error-classification-fuzz.js';
import { SitemapDriftExperiment } from '../self-bench/experiments/sitemap-drift.js';
import { DashboardSmokeExperiment } from '../self-bench/experiments/dashboard-smoke.js';
import { DashboardCopyExperiment } from '../self-bench/experiments/dashboard-copy.js';
import { SourceCopyLintExperiment } from '../self-bench/experiments/source-copy-lint.js';
import { AgentTaskCostWatcherExperiment } from '../self-bench/experiments/agent-cost-watcher.js';
import { ProviderAvailabilityExperiment } from '../self-bench/experiments/provider-availability.js';
import { PatchLoopHealthExperiment } from '../self-bench/experiments/patch-loop-health.js';
import { RoadmapUpdaterExperiment } from '../self-bench/experiments/roadmap-updater.js';
import { RoadmapObserverExperiment } from '../self-bench/experiments/roadmap-observer.js';
import { GitVelocityExperiment } from '../self-bench/experiments/git-velocity.js';
import { XOpsObserverExperiment } from '../self-bench/experiments/x-ops-observer.js';
import { XShapeTunerExperiment } from '../self-bench/experiments/x-shape-tuner.js';
import { MigrationDriftSentinelExperiment } from '../self-bench/experiments/migration-drift-sentinel.js';
import { BrowserProfileGuardianExperiment } from '../self-bench/experiments/browser-profile-guardian.js';
import { RevenuePipelineObserverExperiment } from '../self-bench/experiments/revenue-pipeline-observer.js';
import { XEngagementObserverExperiment } from '../self-bench/experiments/x-engagement-observer.js';
import { XAutonomyRampExperiment } from '../self-bench/experiments/x-autonomy-ramp.js';
import { DailySurpriseDigestExperiment } from '../self-bench/experiments/daily-surprise-digest.js';
import { RoadmapShapeProbeExperiment } from '../self-bench/experiments/roadmap-shape-probe.js';
import { VitestHealthProbeExperiment } from '../self-bench/experiments/vitest-health-probe.js';
import { LoopCadenceProbeExperiment } from '../self-bench/experiments/loop-cadence-probe.js';
import { TestCoverageProbeExperiment } from '../self-bench/experiments/test-coverage-probe.js';
import { AgentLockContentionExperiment } from '../self-bench/experiments/agent-lock-contention.js';
import { ListCompletenessSummaryExperiment } from '../self-bench/experiments/list-completeness-summary.js';
import {
  refreshRuntimeConfigCache,
  RUNTIME_CONFIG_REFRESH_INTERVAL_MS,
} from '../self-bench/runtime-config.js';
import { setSelfCommitRepoRoot } from '../self-bench/self-commit.js';
import { LocalScheduler } from '../scheduling/local-scheduler.js';
import { HeartbeatCoordinator } from '../scheduling/heartbeat-coordinator.js';
import { ConnectorSyncScheduler } from '../scheduling/connector-sync-scheduler.js';
import { BusinessVitalsScheduler } from '../scheduling/business-vitals-scheduler.js';
import { LogTailWatcher } from '../scheduling/log-tail-watcher.js';
import { ImprovementScheduler } from '../scheduling/improvement-scheduler.js';
import { consolidateReflection } from '../oneiros/reflection-consolidator.js';
import { runLlmCall } from '../execution/llm-organ.js';
import { ContentCadenceScheduler } from '../scheduling/content-cadence-scheduler.js';
import { XIntelScheduler } from '../scheduling/x-intel-scheduler.js';
import { SynthesisFailureDetector } from '../scheduling/synthesis-failure-detector.js';
import { SynthesisAutoLearner, isAutoLearningEnabled } from '../scheduling/synthesis-auto-learner.js';
import { RuntimeSkillLoader } from '../orchestrator/runtime-skill-loader.js';
import { InnerThoughtsLoop } from '../presence/inner-thoughts.js';
import { PresenceEngine } from '../presence/presence-engine.js';
import { ProactiveEngine } from '../planning/proactive-engine.js';
import { LocalTransitionEngine } from '../hexis/transition-engine.js';
import { LocalWorkRouter } from '../hexis/work-router.js';
import { HumanGrowthEngine } from '../hexis/human-growth.js';
import { ObservationEngine } from '../hexis/observation-engine.js';
import { runPersonModelRefinement } from '../lib/person-model-refinement.js';
import { resolveActiveWorkspace } from '../config.js';
import { dirname } from 'path';
import { logger } from '../lib/logger.js';
import type { DaemonContext } from './context.js';

export async function initializeScheduling(ctx: Partial<DaemonContext>): Promise<void> {
  const { config, db, rawDb, bus, engine, orchestrator, workspaceId, modelRouter, triggerEvaluator, connectorRegistry, channelRegistry, controlPlane, digitalBody, dataDir } = ctx as DaemonContext;
  const isWorker = config.deviceRole === 'worker';
  if (isWorker) return;

  const activeWsName = resolveActiveWorkspace().name;

  // Scheduler
  const scheduler = new LocalScheduler(db, engine, workspaceId);
  ctx.scheduler = scheduler;
  scheduler.setTriggerEvaluator(triggerEvaluator);
  scheduler.start().catch(err => {
    logger.warn(`[daemon] Scheduler failed: ${err instanceof Error ? err.message : err}`);
  });

  // X intelligence scheduler: opt-in per workspace via xIntelEnabled.
  // Shells out to scripts/x-experiments/x-intel.mjs on a cadence — the
  // script itself handles browser attach, classification, synthesis, and
  // knowledge upload through the approval queue. Decoupled child process
  // so a pipeline bug cannot crash the daemon.
  if (config.xIntelEnabled) {
    // The daemon doesn't know where the ohwow source tree lives for
    // arbitrary installs (the child needs to find scripts/x-experiments/
    // x-intel.mjs). Prefer an env override; otherwise fall back to
    // process.cwd() which is correct when launched from the repo root.
    const repoRoot = process.env.OHWOW_REPO_ROOT || process.cwd();
    const workspaceSlug = resolveActiveWorkspace().name;
    // Chain steps fire sequentially after a successful x-intel tick,
    // each with its own heartbeat and child process. All three
    // scripts depend on x-intel's fresh sidecars, so piggybacking on
    // the same trigger avoids re-scraping. DRY is default inside
    // each script; the live write paths are separate work.
    const chainSteps = [];
    if (config.xAuthorsToCrmEnabled) {
      chainSteps.push({
        enabled: true,
        scriptRelPath: 'scripts/x-experiments/x-authors-to-crm.mjs',
        heartbeatName: 'x-authors-to-crm-last-run.json',
        logTag: '[XAuthorsToCrmScheduler]',
      });
    }
    if (config.xComposeEnabled) {
      chainSteps.push({
        enabled: true,
        scriptRelPath: 'scripts/x-experiments/x-compose.mjs',
        heartbeatName: 'x-compose-last-run.json',
        logTag: '[XComposeScheduler]',
        // DRY=0 so proposals hit the approval queue. Whether they
        // auto-apply (and post live via Chrome) depends on trust
        // thresholds inside propose() and the outbound gate; the
        // scheduler doesn't short-circuit those.
        env: { DRY: '0' },
      });
    }
    if (config.xReplyEnabled) {
      chainSteps.push({
        enabled: true,
        scriptRelPath: 'scripts/x-experiments/x-reply.mjs',
        heartbeatName: 'x-reply-last-run.json',
        logTag: '[XReplyScheduler]',
        env: { DRY: '0' },
      });
    }
    const xIntel = new XIntelScheduler({
      workspaceSlug,
      dataDir,
      repoRoot,
      runOnBoot: false,
      chainOnZeroExit: chainSteps.length ? chainSteps : undefined,
    });
    xIntel.start(config.xIntelIntervalMinutes * 60 * 1000);
    logger.info(
      { workspaceSlug, intervalMin: config.xIntelIntervalMinutes, repoRoot },
      '[daemon] x-intel-scheduler started',
    );

    // Forecast scorer — reuses XIntelScheduler mechanics (child-process
    // isolation, wall-clock kill, heartbeat, executing-guard) but spawns
    // the scorer script on its own slower cadence. Enabled by default
    // because it's read-only: judges predictions emitted by x-intel and
    // writes x-predictions-scores.jsonl. No knowledge uploads, no DMs.
    if (config.xForecastEnabled) {
      const xForecast = new XIntelScheduler({
        workspaceSlug,
        dataDir,
        repoRoot,
        runOnBoot: false,
        scriptRelPath: 'scripts/x-experiments/x-forecast-scorer.mjs',
        heartbeatName: 'x-forecast-last-run.json',
        logTag: '[XForecastScheduler]',
      });
      xForecast.start(config.xForecastIntervalMinutes * 60 * 1000);
      logger.info(
        { workspaceSlug, intervalMin: config.xForecastIntervalMinutes },
        '[daemon] x-forecast-scheduler started',
      );
    }

    // Humor scheduler — runs x-compose with SHAPES=humor on its own
    // hourly cadence. Independent of x-intel because humor draws
    // from x-intel-history (persists across ticks) rather than the
    // day's fresh sidecars. Default cadence 60min; workspace can
    // override via xHumorIntervalMinutes.
    if (config.xHumorEnabled) {
      const xHumor = new XIntelScheduler({
        workspaceSlug,
        dataDir,
        repoRoot,
        runOnBoot: false,
        scriptRelPath: 'scripts/x-experiments/x-compose.mjs',
        heartbeatName: 'x-humor-last-run.json',
        logTag: '[XHumorScheduler]',
        // SHAPES=humor scopes this instance's spawns to the humor
        // shape only. The x-intel chain step (which also runs
        // x-compose) keeps the default mixed shapes.
        env: { SHAPES: 'humor', MAX_DRAFTS: '1', DRY: '0' },
      });
      xHumor.start(config.xHumorIntervalMinutes * 60 * 1000);
      logger.info(
        { workspaceSlug, intervalMin: config.xHumorIntervalMinutes },
        '[daemon] x-humor-scheduler started',
      );
    }
  }

  // Wire schedule change notifications to orchestrator
  if (orchestrator) {
    orchestrator.setScheduleChangeCallback(() => scheduler?.notify());

    // Wire BPP modules into scheduler (deferred: philosophical layers load async)
    setTimeout(async () => {
      const bpp = orchestrator!.getBppModules();
      if (bpp.homeostasis && scheduler) {
        scheduler.setHomeostasis(bpp.homeostasis);
        logger.debug('[daemon] Wired homeostasis -> scheduler');
      }

      // Wire burn-throttle: revenue_vs_burn pressure clamps model
      // routing to local-only when business cost exceeds margin.
      // See src/homeostasis/homeostasis-controller.ts getBurnThrottleLevel.
      if (bpp.homeostasis) {
        const controller = bpp.homeostasis;
        modelRouter.setBurnThrottleProvider(() => controller.getBurnThrottleLevel());
        logger.debug('[daemon] Wired burn-throttle -> model router');
      }

      // Wire bios boundary check: defer schedules during off-hours.
      // Boundary is refreshed every 30 min from agent_workforce_activity
      // so a work-pattern shift (e.g. evening-heavy cycles after a daytime
      // boot) gets picked up without a daemon restart. The previous boot-
      // only snapshot left one instance frozen with strict 9-17 hours while
      // the human actually worked evenings, deferring every schedule for
      // 4.5 h straight.
      try {
        const { inferBoundary, isBoundaryActive } = await import('../bios/boundary-guardian.js');
        const readActivity = async (): Promise<number[]> => {
          // Real table is agent_workforce_activity — the legacy agent_activity
          // name was never migrated here, so the query silently returned empty
          // and every workspace fell back to the hardcoded 9-17 default.
          const { data: activity } = await db.from('agent_workforce_activity')
            .select('created_at')
            .eq('workspace_id', workspaceId)
            .order('created_at', { ascending: false })
            .limit(200);
          return (activity ?? []).map((r: Record<string, unknown>) => new Date(r.created_at as string).getTime());
        };
        let boundary = inferBoundary(await readActivity());
        if (scheduler) {
          scheduler.setBiosDeferCheck(() => isBoundaryActive(boundary));
          logger.debug('[daemon] Wired bios boundary -> scheduler');
        }
        setInterval(async () => {
          try {
            boundary = inferBoundary(await readActivity());
          } catch { /* refresh is non-fatal */ }
        }, 30 * 60 * 1000).unref();
      } catch { /* bios wiring is non-fatal */ }

      // Wire BPP modules into control plane for cloud sync
      if (controlPlane) {
        controlPlane.setBppModules(bpp);
        logger.debug('[daemon] Wired BPP modules -> control plane');
      }
    }, 2000);
  }

  // Proactive engine
  const proactiveEngine = new ProactiveEngine(db, workspaceId, bus);
  ctx.proactiveEngine = proactiveEngine;
  proactiveEngine.start().catch(err => {
    logger.warn(`[daemon] Proactive engine failed: ${err instanceof Error ? err.message : err}`);
  });

  // Transition engine: listens for task completions and evaluates stage progression
  {
    const transitionEngine = new LocalTransitionEngine(db, workspaceId);
    bus.on('task:completed', async (data) => {
      if (data.status !== 'completed') return;
      try {
        const { data: task } = await db
          .from('agent_workforce_tasks')
          .select('title, duration_seconds, output')
          .eq('id', data.taskId)
          .single();
        if (!task) return;
        const durationSeconds = (task.duration_seconds as number) || 0;
        // Extract tool names from output JSON if available
        let toolsUsed: string[] = [];
        if (task.output) {
          try {
            const output = typeof task.output === 'string' ? JSON.parse(task.output as string) : task.output;
            if (Array.isArray(output?.toolsUsed)) toolsUsed = output.toolsUsed;
            else if (Array.isArray(output?.tools)) toolsUsed = output.tools;
          } catch { /* empty */ }
        }
        await transitionEngine.onTaskCompleted({
          taskId: data.taskId,
          taskTitle: (task.title as string) || '',
          agentId: data.agentId,
          toolsUsed,
          status: data.status,
          truthScore: null,
          durationSeconds,
        });
      } catch (err) {
        logger.debug({ err, taskId: data.taskId }, '[daemon] Transition engine hook error');
      }
    });
    logger.debug('[daemon] Transition engine listener registered');
  }

  // Work Router: records routing outcomes when routed tasks complete
  {
    const workRouter = new LocalWorkRouter(db, workspaceId);
    bus.on('task:completed', async (data) => {
      try {
        // Check if this task has a routing decision
        const { data: decision } = await db
          .from('work_routing_decisions')
          .select('id, outcome')
          .eq('task_id', data.taskId)
          .single();

        if (decision && !decision.outcome) {
          const { data: task } = await db
            .from('agent_workforce_tasks')
            .select('duration_seconds')
            .eq('id', data.taskId)
            .single();

          const actualMinutes = task?.duration_seconds
            ? Math.round((task.duration_seconds as number) / 60)
            : undefined;

          await workRouter.recordOutcome(
            decision.id as string,
            data.status === 'completed' ? 'completed' : 'rejected',
            undefined,
            actualMinutes,
          );
        }
      } catch (err) {
        logger.debug({ err, taskId: data.taskId }, '[daemon] Work Router outcome hook error');
      }
    });
    logger.debug('[daemon] Work Router outcome listener registered');
  }

  // Person Model refinement: processes unprocessed observations every hour
  {
    const REFINEMENT_INTERVAL = 60 * 60_000; // 1 hour
    setInterval(() => {
      runPersonModelRefinement(db, workspaceId).catch(err => {
        logger.debug({ err }, '[daemon] Person model refinement error');
      });
    }, REFINEMENT_INTERVAL);
    logger.debug('[daemon] Person model refinement scheduled (1h interval)');
  }

  // Self-bench experiment runner: the substrate for continuous
  // self-testing. Every registered Experiment fires on its cadence,
  // lands a row in self_findings, and (if it implements intervene)
  // changes config when its judge says so.
  {
    // Phase 5-B: runtime config overrides cache. Experiments read
    // runtime-mutable settings via getRuntimeConfig() which
    // synchronously reads this cache. Prime on boot + refresh every
    // 60 seconds so writes from other processes (or other
    // experiment runs) become visible within a minute.
    void refreshRuntimeConfigCache(db);
    setInterval(() => {
      void refreshRuntimeConfigCache(db);
    }, RUNTIME_CONFIG_REFRESH_INTERVAL_MS);

    // Phase 7-A: configure the self-commit repo root from the
    // daemon binary path. Derives /path/to/repo from
    // /path/to/repo/dist/index.js. Self-commit stays disabled
    // by default regardless — the kill-switch file at
    // ~/.ohwow/self-commit-enabled is the operator's opt-in.
    try {
      const entryPath = process.argv[1];
      if (entryPath) {
        const derived = dirname(dirname(entryPath));
        setSelfCommitRepoRoot(derived);
        logger.debug({ repoRoot: derived }, '[daemon] self-commit repo root configured');
      }
    } catch (err) {
      logger.debug({ err }, '[daemon] could not configure self-commit repo root');
    }

    if (engine) {
      // workspaceId is the consolidated row id (cloud UUID or 'local');
      // workspaceSlug is the human-readable name ('default', 'avenued', ...)
      // that business experiments match against.
      const workspaceSlug = resolveActiveWorkspace().name;
      const experimentRunner = new ExperimentRunner(db, engine, workspaceId, workspaceSlug);
      experimentRunner.register(new ModelHealthExperiment());
      experimentRunner.register(new TriggerStabilityExperiment());
      experimentRunner.register(new CanaryExperiment());
      experimentRunner.register(new LedgerHealthExperiment());
      experimentRunner.register(new BurnRateExperiment());
      experimentRunner.register(new ThroughputDailyExperiment());
      experimentRunner.register(new InterventionAuditExperiment());
      experimentRunner.register(new StaleTaskCleanupExperiment());
      experimentRunner.register(new StrategistExperiment());
      experimentRunner.register(new AdaptiveSchedulerExperiment());
      experimentRunner.register(new StaleTaskThresholdTunerExperiment());
      experimentRunner.register(new AgentCoverageGapExperiment());
      experimentRunner.register(new ExperimentProposalGenerator());
      experimentRunner.register(new ExperimentAuthorExperiment());
      experimentRunner.register(new ListHandlersFuzzExperiment());
      experimentRunner.register(new HandlerSchemaDriftExperiment());
      experimentRunner.register(new ProseInvariantDriftExperiment());
      experimentRunner.register(new AgentOutcomesExperiment());
      experimentRunner.register(new AutonomousAuthorQualityExperiment());
      experimentRunner.register(new AutonomousPatchRollbackExperiment());
      experimentRunner.register(new PatchLoopHealthExperiment());
      experimentRunner.register(new PatchAuthorExperiment());
      experimentRunner.register(new RoadmapUpdaterExperiment());
      experimentRunner.register(new RoadmapObserverExperiment());
      experimentRunner.register(new GitVelocityExperiment());
      experimentRunner.register(new XOpsObserverExperiment());
      experimentRunner.register(new XShapeTunerExperiment());
      experimentRunner.register(new MigrationDriftSentinelExperiment());
      experimentRunner.register(new BrowserProfileGuardianExperiment());
      // Piece 5: revenue pipeline observer (advisory). Reads goals,
      // contacts, contact_events, revenue_entries, x-authors-ledger;
      // writes strategy.revenue_gap_focus + priorities when below pace.
      experimentRunner.register(new RevenuePipelineObserverExperiment());
      // Piece 4b: X per-shape engagement observer. Piece 4a's
      // x-own-engagement.mjs populates x-own-posts.jsonl; this
      // aggregates and emits per-shape findings with
      // __tracked_field='median_engagement' for Piece 1's distiller.
      experimentRunner.register(new XEngagementObserverExperiment());
      // Piece 4c: X autonomy ramp. Reads the x_posts_per_week goal +
      // per-shape engagement baselines, writes
      // x-autonomy-allowlist.json + runtime_config
      // x_compose.autonomy_allowlist so x-compose.mjs can drop DRY
      // for shape-graduated drafts up to the goal-paced daily budget.
      experimentRunner.register(new XAutonomyRampExperiment());
      // Piece 6: daily surprise digest. 24h cadence, runOnBoot=false,
      // gates internally on "already ran today" so a daemon restart
      // doesn't spawn duplicates. Narrative finding with subject
      // digest:YYYY-MM-DD in category 'other' for easy filtering.
      experimentRunner.register(new DailySurpriseDigestExperiment());
      experimentRunner.register(new RoadmapShapeProbeExperiment());
      experimentRunner.register(new VitestHealthProbeExperiment());
      experimentRunner.register(new LoopCadenceProbeExperiment());
      experimentRunner.register(new TestCoverageProbeExperiment());
      experimentRunner.register(new FormatDurationFuzzExperiment());
      experimentRunner.register(new TokenSimilarityFuzzExperiment());
      experimentRunner.register(new StagnationFuzzExperiment());
      experimentRunner.register(new ErrorClassificationFuzzExperiment());
      experimentRunner.register(new SitemapDriftExperiment());
      experimentRunner.register(new DashboardSmokeExperiment());
      experimentRunner.register(new DashboardCopyExperiment());
      experimentRunner.register(new SourceCopyLintExperiment());
      // Phase 8-A (live): ContentCadenceTunerExperiment is the first
      // BusinessExperiment in the live runner. Gated behind workspaceSlug
      // === 'default' because its probe anchors to a business goal that
      // only makes sense on the GTM dogfood workspace.
      if (workspaceSlug === 'default') {
        const cadenceTuner = new ContentCadenceTunerExperiment({ dryRun: false });
        const fast = process.env.OHWOW_CONTENT_CADENCE_TUNER_FAST;
        if (fast === '1' || fast === 'true') {
          cadenceTuner.cadence = {
            everyMs: 5 * 60 * 1000,
            runOnBoot: true,
            validationDelayMs: 5 * 60 * 1000,
          };
        }
        experimentRunner.register(cadenceTuner);
        logger.info(
          {
            experimentId: cadenceTuner.id,
            dryRun: cadenceTuner.dryRun,
            fastCadence: fast === '1' || fast === 'true',
            everyMs: cadenceTuner.cadence.everyMs,
            validationDelayMs: cadenceTuner.cadence.validationDelayMs,
          },
          '[daemon] content-cadence-tuner registered in live mode',
        );

        // Phase 8-A: ContentCadenceScheduler — downstream consumer that
        // reads content_cadence.posts_per_day every hour, seeds the
        // x_posts_per_week goal row on first run, dispatches X post tasks
        // when under the daily budget, and updates goal.current_value with
        // the trailing-7d count so validate() has real signal.
        const cadenceScheduler = new ContentCadenceScheduler(db, engine, workspaceId);
        cadenceScheduler.start();
        logger.info('[daemon] content-cadence-scheduler started');

        // Phase 8-A.3: ContentCadenceLoopHealthExperiment — meta-watcher
        // that detects silent failures across the closed loop's stages.
        const loopHealth = new ContentCadenceLoopHealthExperiment();
        const loopHealthFast = process.env.OHWOW_CONTENT_CADENCE_LOOP_HEALTH_FAST;
        if (loopHealthFast === '1' || loopHealthFast === 'true') {
          loopHealth.cadence = {
            everyMs: 5 * 60 * 1000,
            runOnBoot: true,
          };
        }
        experimentRunner.register(loopHealth);
        logger.info(
          {
            fastCadence: loopHealthFast === '1' || loopHealthFast === 'true',
            everyMs: loopHealth.cadence.everyMs,
          },
          '[daemon] content-cadence-loop-health registered',
        );
      }

      // Phase 8-A.1: LLM provider availability — watches failure rates
      // per provider in a rolling 1h window. Warns at >5%, fails at >20%.
      // No intervene; routing adaptation is Phase 8-B.
      experimentRunner.register(new ProviderAvailabilityExperiment());

      // Phase 8-A.2: Agent lock contention — detects agents marked
      // 'working' whose active task hasn't updated in >30 minutes.
      // Warns at 10% stalled agents, fails at 30%.
      experimentRunner.register(new AgentLockContentionExperiment());

      // Phase 8-A.3: List handler completeness digest — meta-experiment
      // that surfaces a weekly summary of list-handlers-fuzz findings
      // as a business-facing signal. 1h cadence.
      experimentRunner.register(new ListCompletenessSummaryExperiment());

      // Phase 8-B: AgentTaskCostWatcherExperiment — observer for the
      // rolling 7d avg cost per completed task. Anchors to the
      // agent_avg_task_cost_cents goal (operator creates via UI with a
      // target value in cents). Warns when avg exceeds target; no
      // intervention until Phase 8-B.2 adds a routing knob.
      experimentRunner.register(new AgentTaskCostWatcherExperiment());

      // Auto-registry: every experiment autonomously authored by
      // ExperimentAuthorExperiment is listed in auto-registry.ts.
      // Dynamic import here so daemon restart is the only coupling —
      // the author commits the registry update, the daemon picks it
      // up on the next boot without any code change to this file.
      try {
        const { autoRegisteredExperiments } = await import('../self-bench/auto-registry.js');
        for (const factory of autoRegisteredExperiments) {
          experimentRunner.register(factory());
        }
        logger.info(
          { count: autoRegisteredExperiments.length },
          '[daemon] auto-registry experiments registered',
        );
      } catch (err) {
        // Non-fatal: auto-registry may not exist yet (fresh install).
        logger.debug({ err }, '[daemon] auto-registry not found or failed to load');
      }

      await experimentRunner.rehydrateSchedule().catch((err) => {
        logger.warn({ err }, '[daemon] rehydrateSchedule failed; continuing with fresh schedule');
      });
      experimentRunner.start();
      logger.debug(
        { experiments: experimentRunner.registeredIds() },
        '[daemon] self-bench experiment runner started',
      );
    } else {
      logger.debug('[daemon] engine unavailable — experiment runner skipped');
    }
  }

  // Human Growth Engine: compute growth snapshots alongside refinement
  {
    const GROWTH_INTERVAL = 60 * 60_000; // 1 hour (same as refinement)
    setInterval(async () => {
      try {
        const growthEngine = new HumanGrowthEngine(db, workspaceId);
        const { data: people } = await db
          .from('agent_workforce_person_models')
          .select('id')
          .eq('workspace_id', workspaceId)
          .in('ingestion_status', ['initial_complete', 'mature']);

        for (const person of (people || [])) {
          await growthEngine.computeAndStoreSnapshot(person.id as string).catch(err => {
            logger.debug({ err, personId: person.id }, '[daemon] Growth snapshot error');
          });
        }
      } catch (err) {
        logger.debug({ err }, '[daemon] Human growth engine error');
      }
    }, GROWTH_INTERVAL);
    logger.debug('[daemon] Human growth engine scheduled (1h interval)');
  }

  // Observation Engine: compute work pattern maps alongside growth
  {
    const OBS_INTERVAL = 60 * 60_000; // 1 hour
    setInterval(async () => {
      try {
        const obsEngine = new ObservationEngine(db, workspaceId);
        const { data: people } = await db
          .from('agent_workforce_person_models')
          .select('id')
          .eq('workspace_id', workspaceId)
          .in('ingestion_status', ['initial_complete', 'mature']);

        for (const person of (people || [])) {
          await obsEngine.computeWorkPatternMap(person.id as string).catch(err => {
            logger.debug({ err, personId: person.id }, '[daemon] Observation engine error');
          });
        }
      } catch (err) {
        logger.debug({ err }, '[daemon] Observation engine error');
      }
    }, OBS_INTERVAL);
    logger.debug('[daemon] Observation engine scheduled (1h interval)');
  }

  // Heartbeat coordinator: wakes agents on a configurable cadence
  const heartbeatCoordinator = new HeartbeatCoordinator(db, engine, workspaceId);
  heartbeatCoordinator.start().catch(err => {
    logger.warn(`[daemon] Heartbeat coordinator failed: ${err instanceof Error ? err.message : err}`);
  });

  // Self-improvement scheduler: runs daily, gates LLM phases on task volume.
  const improvementScheduler = new ImprovementScheduler(db, modelRouter, workspaceId);
  improvementScheduler.setSynthesisBus(bus);
  // Hippocampus: wire the reflection consolidator so it fires once
  // per deep_sleep phase. Adapter builds the LLM closure here so the
  // consolidator module has no runtime dep on the model router.
  improvementScheduler.setReflectionConsolidator(async () => {
    await consolidateReflection({
      db,
      workspaceId,
      dataDir,
      bus,
      llm: async (prompt: string) => {
        const result = await runLlmCall(
          { modelRouter, db, workspaceId },
          { purpose: 'reasoning', prompt, max_tokens: 2048, temperature: 0 },
        );
        if (!result.ok) throw new Error(result.error);
        return result.data.text;
      },
    });
  });
  improvementScheduler.start().catch(err => {
    logger.warn(`[daemon] Improvement scheduler failed: ${err instanceof Error ? err.message : err}`);
  });

  // Runtime skill loader: hot-loads synthesized code skills from
  // <dataDir>/skills/*.ts into the runtime tool registry so the
  // orchestrator sees them on the next chat turn without a daemon
  // restart. Opt-in: default ON for "default", off for any other
  // workspace unless OHWOW_ENABLE_SYNTHESIS=1 is set, so a parallel
  // session (avenued) doesn't accidentally hot-load tools from its
  // own skills dir.
  const synthEnv = process.env.OHWOW_ENABLE_SYNTHESIS;
  const synthesisEnabled =
    synthEnv === '1' || (synthEnv !== '0' && activeWsName === 'default');
  if (synthesisEnabled) {
    const layout = resolveActiveWorkspace();
    const runtimeSkillLoader = new RuntimeSkillLoader({
      skillsDir: layout.skillsDir,
      compiledDir: layout.compiledSkillsDir,
      db,
      workspaceId,
    });
    runtimeSkillLoader.start().catch(err => {
      logger.warn(`[daemon] Runtime skill loader failed: ${err instanceof Error ? err.message : err}`);
    });
    bus.once('shutdown', () => runtimeSkillLoader.stop());
    logger.info(`[daemon] Runtime skill loader started (skillsDir=${layout.skillsDir})`);

    // Failure detector: scans for high-token zero-output tasks and
    // emits synthesis:candidate events on the bus.
    const failureDetector = new SynthesisFailureDetector({
      db,
      workspaceId,
      bus,
    });
    failureDetector.start().catch(err => {
      logger.warn(`[daemon] Synthesis failure detector failed: ${err instanceof Error ? err.message : err}`);
    });
    bus.once('shutdown', () => failureDetector.stop());

    // Autolearner: subscribes to the detector's events and drives
    // the probe → generate → test pipeline automatically. Gated
    // behind OHWOW_ENABLE_AUTO_LEARNING=1 on top of the synthesis
    // flag so it stays opt-in for launch eve.
    if (isAutoLearningEnabled() && modelRouter && orchestrator) {
      const autoLearnerCtx: import('../orchestrator/local-tool-types.js').LocalToolContext = {
        db,
        workspaceId,
        engine,
        channels: channelRegistry,
        controlPlane,
        modelRouter,
      };
      const autoLearner = new SynthesisAutoLearner({
        bus,
        db,
        workspaceId,
        modelRouter,
        toolCtx: autoLearnerCtx,
      });
      autoLearner.start();
      bus.once('shutdown', () => autoLearner.stop());
    } else {
      logger.info('[daemon] Synthesis autolearner disabled (OHWOW_ENABLE_AUTO_LEARNING=1 to enable)');
    }
  } else {
    logger.info(`[daemon] Runtime skill loader disabled for workspace "${activeWsName}"`);
  }

  // Inner thoughts loop + presence engine: ambient awareness for proactive greetings
  const orchWorkspace = orchestrator?.getBrain()?.workspace;
  if (orchWorkspace) {
    const innerThoughts = new InnerThoughtsLoop(db, orchWorkspace, modelRouter, workspaceId);
    innerThoughts.start();

    const presenceEngine = new PresenceEngine({
      innerThoughts,
      workspace: orchWorkspace,
      modelRouter,
      db,
      workspaceId,
    });

    // Wire presence events from control plane (cloud → local dispatch)
    if (controlPlane) {
      controlPlane.setPresenceHandler((event) => {
        presenceEngine.handlePresenceEvent(event);
      });
    }

    // Wire presence events from local API route (direct, no cloud)
    bus.on('presence:event', (event) => {
      presenceEngine.handlePresenceEvent(event);
    });

    // Register as a body organ (the agent's "eye")
    digitalBody.setOrgan('eye', {
      id: 'eye',
      name: 'Eye (Presence)',
      domain: 'digital' as const,
      isActive: () => presenceEngine.isActive(),
      getHealth: () => presenceEngine.isActive() ? 'healthy' as const : 'dormant' as const,
      getAffordances: () => [],
      getUmwelt: () => [{
        modality: 'user_presence',
        organId: 'eye',
        currentValue: presenceEngine.getState(),
        lastUpdated: presenceEngine.getLastDetection() || Date.now(),
        updateFrequencyMs: 3000,
      }],
    });
  }

  // Connector sync scheduler: periodically syncs data source connectors
  const connectorSyncScheduler = new ConnectorSyncScheduler(db, workspaceId, connectorRegistry, bus);
  ctx.connectorSyncScheduler = connectorSyncScheduler;
  connectorSyncScheduler.start();

  // Heart: every 15 min, aggregate task costs + (optionally) Stripe
  // MRR into business_vitals. Homeostasis reads the latest row to
  // set revenue_vs_burn pressure. No Stripe key = cost-only rows.
  const businessVitalsScheduler = new BusinessVitalsScheduler(db, workspaceId);
  businessVitalsScheduler.start();

  // Eyes reflex: every 5 min, tail provider logs named in
  // OHWOW_LOG_TAIL_WATCH (supabase,vercel,fly,modal) and write a
  // self_findings warning row when error_density exceeds threshold.
  // Unset env = watcher runs but every tick is a no-op.
  const logTailWatcher = new LogTailWatcher(db);
  logTailWatcher.start();
}
