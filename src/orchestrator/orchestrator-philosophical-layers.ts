/**
 * Lazy, non-blocking init for the Brain's eight philosophical layers.
 *
 * Each layer is an optional dependency the Brain runs without when the
 * dynamic import fails (e.g. dependency not installed in a slim build).
 * LocalOrchestrator fires this once in its constructor and discards the
 * returned promise; setters populate the supplied layer bag as modules
 * come online so the orchestrator can still read `this.immuneSystem`
 * etc. through the bag reference.
 *
 * Extracted from LocalOrchestrator so the constructor stays small and
 * the 8-way dynamic-import fan-out lives next to its Brain wiring.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { Brain } from '../brain/brain.js';
import type { AffectEngine } from '../affect/affect-engine.js';
import type { EndocrineSystem } from '../endocrine/endocrine-system.js';
import type { HomeostasisController } from '../homeostasis/homeostasis-controller.js';
import type { ImmuneSystem } from '../immune/immune-system.js';
import type { NarrativeEngine } from '../narrative/narrative-engine.js';
import type { EthicsEngine } from '../ethos/ethics-engine.js';
import type { HabitEngine } from '../hexis/habit-engine.js';
import type { SleepCycle } from '../oneiros/sleep-cycle.js';

export interface PhilosophicalLayers {
  affectEngine: AffectEngine | null;
  endocrineSystem: EndocrineSystem | null;
  homeostasisController: HomeostasisController | null;
  immuneSystem: ImmuneSystem | null;
  narrativeEngine: NarrativeEngine | null;
  ethicsEngine: EthicsEngine | null;
  habitEngine: HabitEngine | null;
  sleepCycle: SleepCycle | null;
}

export function createEmptyPhilosophicalLayers(): PhilosophicalLayers {
  return {
    affectEngine: null,
    endocrineSystem: null,
    homeostasisController: null,
    immuneSystem: null,
    narrativeEngine: null,
    ethicsEngine: null,
    habitEngine: null,
    sleepCycle: null,
  };
}

/**
 * Fire-and-forget init of the eight philosophical layers. Each layer's
 * dynamic import can fail independently without taking down the others;
 * the Brain works with any subset. Resolves once all eight attempts
 * settle, but callers can safely ignore the returned promise.
 *
 * Wires every successful layer into *both* brains — the orchestrator's
 * (`primaryBrain`) and the runtime engine's (`engineBrain`) — so agents
 * and the orchestrator chat share the same cognitive state.
 */
export function initPhilosophicalLayers(
  db: DatabaseAdapter,
  workspaceId: string,
  layers: PhilosophicalLayers,
  primaryBrain: Brain | null,
  engineBrain: Brain | null,
): void {
  import('../affect/affect-engine.js').then(({ AffectEngine }) => {
    layers.affectEngine = new AffectEngine(db, workspaceId);
    primaryBrain?.setAffectEngine(layers.affectEngine);
    engineBrain?.setAffectEngine(layers.affectEngine);
  }).catch(() => { /* non-fatal */ });

  import('../endocrine/endocrine-system.js').then(({ EndocrineSystem }) => {
    layers.endocrineSystem = new EndocrineSystem(db, workspaceId);
    primaryBrain?.setEndocrineSystem(layers.endocrineSystem);
    engineBrain?.setEndocrineSystem(layers.endocrineSystem);
  }).catch(() => { /* non-fatal */ });

  import('../homeostasis/homeostasis-controller.js').then(({ HomeostasisController }) => {
    layers.homeostasisController = new HomeostasisController(db, workspaceId);
    primaryBrain?.setHomeostasisController(layers.homeostasisController);
    engineBrain?.setHomeostasisController(layers.homeostasisController);
  }).catch(() => { /* non-fatal */ });

  import('../immune/immune-system.js').then(({ ImmuneSystem }) => {
    layers.immuneSystem = new ImmuneSystem(db, workspaceId);
    primaryBrain?.setImmuneSystem(layers.immuneSystem);
    engineBrain?.setImmuneSystem(layers.immuneSystem);
  }).catch(() => { /* non-fatal */ });

  import('../narrative/narrative-engine.js').then(({ NarrativeEngine }) => {
    layers.narrativeEngine = new NarrativeEngine(db, workspaceId);
    primaryBrain?.setNarrativeEngine(layers.narrativeEngine);
    engineBrain?.setNarrativeEngine(layers.narrativeEngine);
  }).catch(() => { /* non-fatal */ });

  import('../ethos/ethics-engine.js').then(({ EthicsEngine }) => {
    layers.ethicsEngine = new EthicsEngine(db, workspaceId);
    primaryBrain?.setEthicsEngine(layers.ethicsEngine);
    engineBrain?.setEthicsEngine(layers.ethicsEngine);
  }).catch(() => { /* non-fatal */ });

  import('../hexis/habit-engine.js').then(({ HabitEngine }) => {
    layers.habitEngine = new HabitEngine(db, workspaceId);
    primaryBrain?.setHabitEngine(layers.habitEngine);
    engineBrain?.setHabitEngine(layers.habitEngine);
  }).catch(() => { /* non-fatal */ });

  import('../oneiros/sleep-cycle.js').then(({ SleepCycle }) => {
    layers.sleepCycle = new SleepCycle();
    primaryBrain?.setSleepCycle(layers.sleepCycle);
    engineBrain?.setSleepCycle(layers.sleepCycle);
  }).catch(() => { /* non-fatal */ });
}
