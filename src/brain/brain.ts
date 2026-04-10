/**
 * Brain — The Cognitive Coordinator
 *
 * "I think, therefore I am." — René Descartes
 * (But Heidegger corrected: "I am, therefore I think.")
 *
 * The Brain is the unified cognitive coordinator for the ohwow local runtime.
 * It does NOT replace LocalOrchestrator or RuntimeEngine. They remain as
 * I/O shells (streaming, DB persistence, session management, API calls).
 * The Brain owns cognition: what to perceive, how to reason, which tool
 * to try, when to escalate.
 *
 * The three-step cognitive cycle:
 *
 * 1. PERCEIVE (Husserl's Phenomenology)
 *    Raw stimulus → enriched perception with intent horizons,
 *    relevant memories, temporal context, and self-awareness.
 *
 * 2. DELIBERATE (Friston + Hegel)
 *    Perception → plan with predictions. For complex plans,
 *    generate a dialectic counter-argument.
 *
 * 3. ACT (Whitehead + Merleau-Ponty)
 *    Execute the plan, recording experiences to the stream,
 *    updating tool proficiency, and broadcasting discoveries
 *    to the global workspace.
 *
 * Architecture:
 * - ExperienceStream: unified event log (Whitehead)
 * - SelfModelBuilder: self-awareness (Kant)
 * - PredictiveEngine: prediction + free energy minimization (Friston)
 * - enrichIntent: phenomenological intent classification (Husserl)
 * - TemporalFrameBuilder: time consciousness (Heidegger)
 * - applyToolEmbodiment: tool mastery descriptions (Merleau-Ponty)
 * - dialecticCheck: counter-plan synthesis (Hegel)
 * - GlobalWorkspace: consciousness bus (Baars)
 */

import type {
  Stimulus,
  Perception,
  Plan,
  PlannedAction,
  SelfModel,
} from './types.js';
import { ExperienceStream } from './experience-stream.js';
import type { ExperiencePersistence } from './experience-stream.js';
import { SelfModelBuilder, type SelfModelDeps } from './self-model.js';
import { PredictiveEngine } from './predictive-engine.js';
import { enrichIntent } from './intentionality.js';
import { TemporalFrameBuilder, buildTemporalReflection } from './temporal-frame.js';
import { applyToolEmbodiment } from './tool-embodiment.js';
import { dialecticCheck, formatDialecticWarning } from './dialectic.js';
import { WisdomEngine, type WisdomContext, type WisdomResult, type WisdomTrigger } from './wisdom-engine.js';
import { GlobalWorkspace } from './global-workspace.js';
import type { ConsciousnessBridge } from './consciousness-bridge.js';
import type { ClassifiedIntent } from '../orchestrator/orchestrator-types.js';
import type { ModelRouter } from '../execution/model-router.js';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { NervousSystem } from '../body/nervous-system.js';

// ============================================================================
// BRAIN DEPENDENCIES
// ============================================================================

export interface BrainDependencies {
  /** Model router for LLM calls (dialectic, etc.). */
  modelRouter: ModelRouter | null;
  /** Optional persistence for cross-session learning. */
  persistence?: ExperiencePersistence;
  /** Experience stream capacity override. */
  experienceCapacity?: number;
  /** Optional nervous system for body integration. */
  nervousSystem?: NervousSystem;
}

// ============================================================================
// BRAIN
// ============================================================================

export class Brain {
  // Core modules
  readonly experienceStream: ExperienceStream;
  readonly selfModelBuilder: SelfModelBuilder;
  readonly predictiveEngine: PredictiveEngine;
  readonly temporalFrameBuilder: TemporalFrameBuilder;
  readonly workspace: GlobalWorkspace;

  private modelRouter: ModelRouter | null;
  private nervousSystem: NervousSystem | null;
  private consciousnessBridge: ConsciousnessBridge | null = null;
  private digitalBody: import('../body/digital-body.js').DigitalBody | null = null;
  private wisdomEngine: WisdomEngine;

  constructor(deps: BrainDependencies) {
    this.modelRouter = deps.modelRouter;
    this.nervousSystem = deps.nervousSystem ?? null;

    // Initialize modules in dependency order
    this.experienceStream = new ExperienceStream({
      capacity: deps.experienceCapacity,
      persistence: deps.persistence,
    });
    this.selfModelBuilder = new SelfModelBuilder(this.experienceStream);
    this.predictiveEngine = new PredictiveEngine(this.experienceStream);
    this.temporalFrameBuilder = new TemporalFrameBuilder(
      this.experienceStream,
      this.predictiveEngine,
    );
    this.workspace = new GlobalWorkspace();
    this.wisdomEngine = new WisdomEngine();
  }

  // --------------------------------------------------------------------------
  // BODY INTEGRATION — Wire embodiment layer post-construction
  // --------------------------------------------------------------------------

  /** Inject the digital body for proprioceptive awareness. */
  setDigitalBody(body: import('../body/digital-body.js').DigitalBody): void {
    this.digitalBody = body;
  }

  /** Get the current proprioceptive snapshot, if body is available. */
  getProprioception(): import('../body/types.js').Proprioception | undefined {
    return this.digitalBody?.getProprioception();
  }

  // --------------------------------------------------------------------------
  // CONSCIOUSNESS BRIDGE — Persist and sync Global Workspace items
  // --------------------------------------------------------------------------

  /** Wire the consciousness bridge for persistence and cloud sync. */
  setConsciousnessBridge(bridge: ConsciousnessBridge): void {
    this.consciousnessBridge = bridge;
  }

  /** Get the consciousness bridge (for external sync triggers). */
  getConsciousnessBridge(): ConsciousnessBridge | null {
    return this.consciousnessBridge;
  }

  // --------------------------------------------------------------------------
  // NEW PHILOSOPHICAL LAYERS — Post-construction wiring
  // --------------------------------------------------------------------------

  private affectEngine: import('../affect/affect-engine.js').AffectEngine | null = null;
  private endocrineSystem: import('../endocrine/endocrine-system.js').EndocrineSystem | null = null;
  private homeostasisController: import('../homeostasis/homeostasis-controller.js').HomeostasisController | null = null;
  private immuneSystem: import('../immune/immune-system.js').ImmuneSystem | null = null;
  private narrativeEngine: import('../narrative/narrative-engine.js').NarrativeEngine | null = null;
  private ethicsEngine: import('../ethos/ethics-engine.js').EthicsEngine | null = null;
  private habitEngine: import('../hexis/habit-engine.js').HabitEngine | null = null;
  private sleepCycle: import('../oneiros/sleep-cycle.js').SleepCycle | null = null;

  /** Wire the affect (emotion) engine (Damasio). */
  setAffectEngine(engine: import('../affect/affect-engine.js').AffectEngine): void {
    this.affectEngine = engine;
  }

  /** Wire the endocrine system (Spinoza). */
  setEndocrineSystem(system: import('../endocrine/endocrine-system.js').EndocrineSystem): void {
    this.endocrineSystem = system;
  }

  /** Wire the homeostasis controller (Cannon). */
  setHomeostasisController(controller: import('../homeostasis/homeostasis-controller.js').HomeostasisController): void {
    this.homeostasisController = controller;
  }

  /** Wire the immune system (Maturana & Varela). */
  setImmuneSystem(system: import('../immune/immune-system.js').ImmuneSystem): void {
    this.immuneSystem = system;
  }

  /** Wire the narrative engine (Ricoeur). */
  setNarrativeEngine(engine: import('../narrative/narrative-engine.js').NarrativeEngine): void {
    this.narrativeEngine = engine;
  }

  /** Wire the ethics engine (Aristotle + Kant). */
  setEthicsEngine(engine: import('../ethos/ethics-engine.js').EthicsEngine): void {
    this.ethicsEngine = engine;
  }

  /** Wire the habit engine (Aristotle's hexis). */
  setHabitEngine(engine: import('../hexis/habit-engine.js').HabitEngine): void {
    this.habitEngine = engine;
  }

  /** Wire the sleep cycle (Oneiros). */
  setSleepCycle(cycle: import('../oneiros/sleep-cycle.js').SleepCycle): void {
    this.sleepCycle = cycle;
  }

  /** Get the affect engine for external access. */
  getAffectEngine(): import('../affect/affect-engine.js').AffectEngine | null { return this.affectEngine; }
  /** Get the endocrine system for external access. */
  getEndocrineSystem(): import('../endocrine/endocrine-system.js').EndocrineSystem | null { return this.endocrineSystem; }
  /** Get the homeostasis controller for external access. */
  getHomeostasisController(): import('../homeostasis/homeostasis-controller.js').HomeostasisController | null { return this.homeostasisController; }
  /** Get the immune system for external access. */
  getImmuneSystem(): import('../immune/immune-system.js').ImmuneSystem | null { return this.immuneSystem; }
  /** Get the narrative engine for external access. */
  getNarrativeEngine(): import('../narrative/narrative-engine.js').NarrativeEngine | null { return this.narrativeEngine; }
  /** Get the ethics engine for external access. */
  getEthicsEngine(): import('../ethos/ethics-engine.js').EthicsEngine | null { return this.ethicsEngine; }
  /** Get the habit engine for external access. */
  getHabitEngine(): import('../hexis/habit-engine.js').HabitEngine | null { return this.habitEngine; }
  /** Get the sleep cycle for external access. */
  getSleepCycle(): import('../oneiros/sleep-cycle.js').SleepCycle | null { return this.sleepCycle; }

  // --------------------------------------------------------------------------
  // PERCEIVE — Transform raw stimulus into structured perception (Husserl)
  // --------------------------------------------------------------------------

  /**
   * The first step of the cognitive cycle.
   *
   * Takes a raw stimulus (user message, tool result, event) and enriches
   * it with intent horizons, temporal context, and self-awareness.
   */
  perceive(
    stimulus: Stimulus,
    classified: ClassifiedIntent,
    selfModelDeps: SelfModelDeps,
    conversationHistory?: Array<{ role: string; content: string }>,
  ): Perception {
    // Record the stimulus as an experience
    this.experienceStream.append('stimulus_received', stimulus, stimulus.source);

    // Enrich intent with phenomenological horizons
    const userMessage = typeof stimulus.content === 'string' ? stimulus.content : '';
    const enriched = enrichIntent(classified, userMessage, conversationHistory, this.experienceStream);

    // Build temporal frame
    const temporalFrame = this.temporalFrameBuilder.build(stimulus);

    // Build self-model snapshot
    const selfState = this.selfModelBuilder.build(selfModelDeps);

    return {
      stimulus,
      intent: enriched,
      relevantMemories: [], // populated by prompt-builder, not the brain
      temporalContext: temporalFrame,
      selfState,
      horizon: enriched.horizon,
    };
  }

  // --------------------------------------------------------------------------
  // DELIBERATE — Generate a plan from perception (Friston + Hegel)
  // --------------------------------------------------------------------------

  /**
   * The second step of the cognitive cycle.
   *
   * Given a perception, decide what to do. For complex tasks (planFirst),
   * generate a dialectic counter-argument to strengthen the plan.
   */
  async deliberate(
    perception: Perception,
    planDescription?: string,
    planStepCount?: number,
  ): Promise<Plan> {
    const actions: PlannedAction[] = [];
    let counterArgument: string | undefined;
    let confidence = perception.selfState.confidence;

    // Dialectic check for complex plans (Hegel)
    if (
      perception.intent.planFirst &&
      planDescription &&
      planStepCount &&
      planStepCount >= 3
    ) {
      const userMessage = typeof perception.stimulus.content === 'string'
        ? perception.stimulus.content : '';

      const dialectic = await dialecticCheck(
        planDescription,
        planStepCount,
        this.modelRouter,
        userMessage,
      );

      if (dialectic.applied && dialectic.counterArgument) {
        counterArgument = dialectic.counterArgument;
        // Lower confidence when dialectic finds issues
        confidence *= 0.8;

        // Record dialectic experience
        this.experienceStream.append('dialectic_applied', {
          counterArgument,
          planDescription: planDescription.slice(0, 200),
        }, 'orchestrator');

        // Broadcast to workspace
        this.workspace.broadcast({
          source: 'brain',
          type: 'warning',
          content: `Dialectic: ${counterArgument}`,
          salience: 0.7,
          timestamp: Date.now(),
        });
      }
    }

    // Overall plan prediction from predictive engine
    const prediction = {
      target: 'plan',
      expectedResult: confidence > 0.5 ? 'success' as const : 'partial' as const,
      confidence,
      basis: counterArgument
        ? `Plan has a dialectic concern: ${counterArgument}`
        : 'Plan appears solid',
    };

    return {
      actions,
      prediction,
      counterArgument,
      confidence,
    };
  }

  // --------------------------------------------------------------------------
  // WISDOM — Prefrontal Cortex consultation (Luria's Executive Function)
  // --------------------------------------------------------------------------

  /**
   * Seek wisdom from the strongest available model for strategic guidance.
   * Unlike dialecticCheck (quick gut reaction, cheapest model), wisdom
   * is a deep consultation using the strongest model (Grok 4.20, Claude Opus).
   */
  async seekWisdom(
    context: WisdomContext,
    reason: WisdomTrigger,
  ): Promise<WisdomResult> {
    if (!this.modelRouter) {
      return { consulted: false, guidance: null, reason, model: '', tokensUsed: 0 };
    }

    const result = await this.wisdomEngine.seek(context, reason, this.modelRouter);

    if (result.consulted && result.guidance) {
      // Record to experience stream
      this.experienceStream.append('wisdom_sought', {
        reason,
        model: result.model,
        guidance: result.guidance.slice(0, 200),
        tokensUsed: result.tokensUsed,
      }, 'orchestrator');

      // Broadcast to global workspace
      this.workspace.broadcast({
        source: 'brain',
        type: 'discovery',
        content: `Wisdom (${reason}): ${result.guidance.slice(0, 100)}`,
        salience: 0.8,
        timestamp: Date.now(),
      });
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // ACT HELPERS — Used during execution
  // --------------------------------------------------------------------------

  /**
   * Apply tool embodiment to compress descriptions for mastered tools.
   */
  applyEmbodiment(tools: Tool[]): Tool[] {
    return applyToolEmbodiment(tools, this.selfModelBuilder);
  }

  /**
   * Build a temporal reflection prompt for re-anchoring.
   */
  buildReflection(
    userMessage: string,
    recentToolNames: string[],
    iteration: number,
    maxIterations: number,
  ): string {
    const stimulus: Stimulus = {
      type: 'user_message',
      content: userMessage,
      source: 'orchestrator',
      timestamp: Date.now(),
    };
    const frame = this.temporalFrameBuilder.build(stimulus, recentToolNames);
    return buildTemporalReflection(frame, userMessage, iteration, maxIterations);
  }

  /**
   * Format a dialectic warning for injection into the LLM context.
   */
  formatDialecticWarning(counterArgument: string): string {
    return formatDialecticWarning(counterArgument);
  }

  /**
   * Record a tool execution and get the prediction result.
   */
  recordToolExecution(
    toolName: string,
    input: unknown,
    success: boolean,
    latencyMs: number = 0,
  ): void {
    const prediction = this.predictiveEngine.predict(toolName, input);
    this.predictiveEngine.update(prediction, toolName, input, { success, data: undefined });
    this.selfModelBuilder.recordToolUse(toolName, success, latencyMs);

    // Broadcast failures to workspace
    if (!success) {
      this.workspace.broadcastFailure('brain', toolName, 'tool execution failed');
    }
  }

  // --------------------------------------------------------------------------
  // ACCESSORS
  // --------------------------------------------------------------------------

  /**
   * Get the current self-model snapshot.
   */
  getSelfModel(deps: SelfModelDeps): SelfModel {
    return this.selfModelBuilder.build(deps);
  }

  /**
   * Get the global workspace.
   */
  getWorkspace(): GlobalWorkspace {
    return this.workspace;
  }

  /**
   * Check if the system is stagnating.
   */
  isStagnating(): boolean {
    return this.predictiveEngine.isStagnating();
  }

  /**
   * Build an enriched stagnation warning.
   */
  buildStagnationWarning(): string {
    return this.predictiveEngine.buildStagnationWarning();
  }

  /**
   * Reset session state for a new conversation turn.
   */
  resetSession(): void {
    this.predictiveEngine.resetSession();
    this.wisdomEngine.resetSession();
  }

  /**
   * Flush the experience stream and consciousness items to persistence.
   */
  async flush(): Promise<void> {
    await this.experienceStream.flush();
    await this.consciousnessBridge?.persist();
  }
}
