/**
 * Daemon self-bench experiment registration
 *
 * Builds the ExperimentRunner, registers every hand-authored experiment,
 * fans out the auto-registry (experiments written by the autonomous
 * experiment-author loop, listed in src/self-bench/auto-registry.ts),
 * rehydrates the schedule from the ledger, and starts the runner. Also
 * primes the runtime_config_overrides cache and sets the self-commit
 * repo root from the daemon entry path.
 *
 * Called from src/daemon/scheduling.ts inside the primary-only block.
 * Never edit src/self-bench/auto-registry.ts from here — that file is
 * tier-1 and owned by the autonomous author loop; this module only
 * consumes its exported factory list.
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
import { DeliverableActionSentinelExperiment } from '../self-bench/experiments/deliverable-action-sentinel.js';
import { AgentStateHygieneSentinelExperiment } from '../self-bench/experiments/agent-state-hygiene-sentinel.js';
import { RevenuePipelineObserverExperiment } from '../self-bench/experiments/revenue-pipeline-observer.js';
import { AttributionObserverExperiment } from '../self-bench/experiments/attribution-observer.js';
import { OutreachThermostatExperiment } from '../self-bench/experiments/outreach-thermostat.js';
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
import { ContentCadenceScheduler } from '../scheduling/content-cadence-scheduler.js';
import { XDmPollerScheduler } from '../scheduling/x-dm-poller-scheduler.js';
import { XDmReplyDispatcher } from '../scheduling/x-dm-reply-dispatcher.js';
import { XDmSignalsRollupExperiment } from '../self-bench/experiments/x-dm-signals-rollup.js';
import { resolveActiveWorkspace, workspaceLayoutFor } from '../config.js';
import path from 'node:path';
import { dirname } from 'path';
import { logger } from '../lib/logger.js';
import type { DaemonContext } from './context.js';

export async function registerExperiments(ctx: Partial<DaemonContext>): Promise<void> {
  const { config: _config, db, engine, workspaceId } = ctx as DaemonContext;

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

  if (!engine) {
    logger.debug('[daemon] engine unavailable — experiment runner skipped');
    return;
  }

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
  // Deliverable action sentinel: scans recent deferred-action tasks
  // (post_tweet, send_email, etc.) for agent-narrated auth/permission
  // failures on rows marked status=completed. Closes the observability
  // gap the 2026-04-16 "unauthed chromium on X" loop exposed —
  // content-cadence was marking every dispatch completed even when the
  // agent plainly wrote "I cannot log in".
  experimentRunner.register(new DeliverableActionSentinelExperiment());
  // Agent state hygiene sentinel: scans agent_workforce_task_state for
  // fallback-decision markers (status=posting_manually, cannot_automate,
  // etc.) that become self-reinforcing — the agent reads the poison,
  // treats it as authoritative, and never re-attempts the action.
  // Companion to the deliverable-action sentinel; that one sees task
  // output, this one sees persistent state.
  experimentRunner.register(new AgentStateHygieneSentinelExperiment());
  // Piece 5: revenue pipeline observer (advisory).
  experimentRunner.register(new RevenuePipelineObserverExperiment());
  // Funnel Surgeon Phase 1: attribution rollup observer (advisory).
  // Reads the migration-128 view and surfaces bucket-level conversion
  // stats + the worst-performing bucket as strategy.attribution_findings.
  experimentRunner.register(new AttributionObserverExperiment());
  // Piece 4b: X per-shape engagement observer.
  experimentRunner.register(new XEngagementObserverExperiment());
  // Piece 4c: X autonomy ramp.
  experimentRunner.register(new XAutonomyRampExperiment());
  // Piece 6: daily surprise digest. 24h cadence, runOnBoot=false,
  // gates internally on "already ran today" so a daemon restart
  // doesn't spawn duplicates.
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
    // Thread the approvals-ledger path so the scheduler's approved-
    // draft bypass can read operator-approved text and post it
    // directly, skipping the LLM-author iteration (which has been
    // the source of the "## Tweet Ready for Manual Posting"
    // capitulation class).
    const approvalsJsonlPath = path.join(
      workspaceLayoutFor(workspaceSlug).dataDir,
      'x-approvals.jsonl',
    );
    const cadenceScheduler = new ContentCadenceScheduler(
      db,
      engine,
      workspaceId,
      { approvalsJsonlPath },
    );
    cadenceScheduler.start();
    logger.info({ approvalsJsonlPath }, '[daemon] content-cadence-scheduler started');

    // Phase 8-A.4: XDmPollerScheduler — read-only DM ingest. Polls the
    // X inbox via listDmsViaBrowser, upserts threads + observations
    // into x_dm_threads / x_dm_observations, mirrors deltas to a daily
    // JSONL ledger. No findings, no contact linking, no auto-replies
    // in this commit; layered on after a clean ingest is observed.
    const dmPoller = new XDmPollerScheduler(
      db,
      workspaceId,
      { dataDir: workspaceLayoutFor(workspaceSlug).dataDir },
    );
    dmPoller.start();
    logger.info('[daemon] x-dm-poller-scheduler started');

    // XDmReplyDispatcher — SEND side of the DM loop. Drains operator-
    // approved kind='x_dm_outbound' entries from the shared approvals
    // ledger, serializes on the workspace CDP lane with the poller +
    // content-cadence, and delivers via sendDmViaBrowser. No autonomous
    // producer today; this is the infrastructure that lets a human-
    // reviewed reply actually leave the daemon.
    const dmReplyDispatcher = new XDmReplyDispatcher(
      db,
      workspaceId,
      {
        approvalsJsonlPath,
        dataDir: workspaceLayoutFor(workspaceSlug).dataDir,
      },
    );
    dmReplyDispatcher.start();
    logger.info({ approvalsJsonlPath }, '[daemon] x-dm-reply-dispatcher started');

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

    // XDmSignalsRollupExperiment — bridges x_dm_signals to
    // self_findings so the autonomous loop (which reads findings, not
    // signals) can see trigger-phrase spikes. Per-phrase subjects give
    // the novelty scorer stable baselines.
    const dmRollup = new XDmSignalsRollupExperiment();
    experimentRunner.register(dmRollup);
    logger.info(
      { everyMs: dmRollup.cadence.everyMs },
      '[daemon] x-dm-signals-rollup registered',
    );

    // Phase 2 (sales loop): OutreachThermostatExperiment — first
    // autonomous proposer of cross-channel first-touches toward a
    // weekly goal. OFF BY DEFAULT. Operator opts in via the env flag
    // OHWOW_OUTREACH_THERMOSTAT_ENABLED=true (a config.ts plumbed
    // `outreachThermostatEnabled` knob is a follow-up). v1 always
    // writes to the approval queue with autoApproveAfter=Infinity —
    // nothing sends without operator review.
    if (process.env.OHWOW_OUTREACH_THERMOSTAT_ENABLED === 'true') {
      const thermostat = new OutreachThermostatExperiment({
        approvalsJsonlPath,
      });
      experimentRunner.register(thermostat);
      logger.info(
        { approvalsJsonlPath, everyMs: thermostat.cadence.everyMs },
        '[daemon] outreach-thermostat registered (proposal-only, human-in-loop)',
      );
    }
  }

  // Phase 8-A.1: LLM provider availability — watches failure rates
  // per provider in a rolling 1h window. Warns at >5%, fails at >20%.
  experimentRunner.register(new ProviderAvailabilityExperiment());

  // Phase 8-A.2: Agent lock contention — detects agents marked
  // 'working' whose active task hasn't updated in >30 minutes.
  experimentRunner.register(new AgentLockContentionExperiment());

  // Phase 8-A.3: List handler completeness digest — meta-experiment
  // that surfaces a weekly summary of list-handlers-fuzz findings
  // as a business-facing signal. 1h cadence.
  experimentRunner.register(new ListCompletenessSummaryExperiment());

  // Phase 8-B: AgentTaskCostWatcherExperiment — observer for the
  // rolling 7d avg cost per completed task.
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
}
