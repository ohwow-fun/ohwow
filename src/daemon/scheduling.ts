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

import { LocalScheduler } from '../scheduling/local-scheduler.js';
import { HeartbeatCoordinator } from '../scheduling/heartbeat-coordinator.js';
import { ConnectorSyncScheduler } from '../scheduling/connector-sync-scheduler.js';
import { BusinessVitalsScheduler } from '../scheduling/business-vitals-scheduler.js';
import { LogTailWatcher } from '../scheduling/log-tail-watcher.js';
import { ImprovementScheduler } from '../scheduling/improvement-scheduler.js';
import { consolidateReflection } from '../oneiros/reflection-consolidator.js';
import { runLlmCall } from '../execution/llm-organ.js';
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
import { logger } from '../lib/logger.js';
import { registerExperiments } from './experiments.js';
import {
  seedXIntelAutomation,
  seedXForecastAutomation,
  seedXHumorAutomation,
} from './seed-x-automations.js';
import type { DaemonContext } from './context.js';

/** Convert `xIntelIntervalMinutes` config into a cron expression the
 * LocalScheduler can evaluate. Whole-hour divisors of 24 become comma-
 * lists ("0 0,3,6,9,12,15,18,21 * * *") so cron-parser advances
 * correctly at midnight boundaries; other hour values use `/<N>` form;
 * sub-hourly falls back to minute-step form. */
export function cronForIntervalMinutes(minutes: number): string {
  const n = Math.max(1, Math.round(minutes));
  if (n >= 60 && n % 60 === 0) {
    const hours = n / 60;
    if (24 % hours === 0) {
      const marks: number[] = [];
      for (let h = 0; h < 24; h += hours) marks.push(h);
      return `0 ${marks.join(',')} * * *`;
    }
    return `0 */${hours} * * *`;
  }
  return `*/${n} * * * *`;
}

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

  // X schedulers (intel + chain, forecast, humor): opt-in via
  // xIntelEnabled. All three now land as native ohwow automations
  // (trigger_type='schedule') so LocalScheduler.tickAutomationSchedules
  // drives them — last_fired_at persists in the DB across restarts, the
  // dashboard can toggle/edit them like any user-authored flow, and the
  // trigger watchdog picks up stuck runs via consecutive_failures. The
  // shell_script dispatcher preserves the original env contract + the
  // heartbeat files that external monitors watch.
  if (config.xIntelEnabled) {
    const repoRoot = process.env.OHWOW_REPO_ROOT || process.cwd();
    const workspaceSlug = resolveActiveWorkspace().name;

    await seedXIntelAutomation(db, workspaceId, {
      cron: cronForIntervalMinutes(config.xIntelIntervalMinutes),
      authorsToCrm: config.xAuthorsToCrmEnabled,
      compose: config.xComposeEnabled,
      reply: config.xReplyEnabled,
    }).catch((err) => {
      logger.warn({ err }, '[daemon] seed-x-intel-automation failed');
    });
    logger.info(
      { workspaceSlug, intervalMin: config.xIntelIntervalMinutes, repoRoot },
      '[daemon] x-intel automation seeded',
    );

    if (config.xForecastEnabled) {
      await seedXForecastAutomation(db, workspaceId, {
        cron: cronForIntervalMinutes(config.xForecastIntervalMinutes),
      }).catch((err) => {
        logger.warn({ err }, '[daemon] seed-x-forecast-automation failed');
      });
      logger.info(
        { workspaceSlug, intervalMin: config.xForecastIntervalMinutes },
        '[daemon] x-forecast automation seeded',
      );
    }

    if (config.xHumorEnabled) {
      await seedXHumorAutomation(db, workspaceId, {
        cron: cronForIntervalMinutes(config.xHumorIntervalMinutes),
      }).catch((err) => {
        logger.warn({ err }, '[daemon] seed-x-humor-automation failed');
      });
      logger.info(
        { workspaceSlug, intervalMin: config.xHumorIntervalMinutes },
        '[daemon] x-humor automation seeded',
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

  await registerExperiments(ctx);


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
