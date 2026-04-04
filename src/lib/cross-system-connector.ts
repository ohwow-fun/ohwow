/**
 * Cross-System Connector — Wires the 8 philosophical layers together.
 *
 * The Endocrine system is the integration bus: emotions, immune threats,
 * and homeostatic deviations all feed into hormones, which modulate
 * every other layer.
 */

import type { GlobalWorkspace } from '../brain/global-workspace.js';
import type { WorkspaceItem } from '../brain/types.js';
import type { AffectEngine } from '../affect/affect-engine.js';
import type { EndocrineSystem } from '../endocrine/endocrine-system.js';
import type { HomeostasisController } from '../homeostasis/homeostasis-controller.js';
import type { ImmuneSystem } from '../immune/immune-system.js';
import type { NarrativeEngine } from '../narrative/narrative-engine.js';
import type { HabitEngine } from '../hexis/habit-engine.js';
import type { SleepCycle } from '../oneiros/sleep-cycle.js';
import { logger } from './logger.js';

export interface CrossSystemDeps {
  workspace: GlobalWorkspace;
  affect?: AffectEngine;
  endocrine?: EndocrineSystem;
  homeostasis?: HomeostasisController;
  immune?: ImmuneSystem;
  narrative?: NarrativeEngine;
  habits?: HabitEngine;
  sleep?: SleepCycle;
}

/**
 * Wire cross-system flows. Call once after all systems are initialized.
 * Returns an unsubscribe function to clean up all subscriptions.
 */
export function connectSystems(deps: CrossSystemDeps): () => void {
  const unsubscribers: (() => void)[] = [];

  // 1. Affect -> Endocrine: emotions trigger hormones
  if (deps.affect && deps.endocrine) {
    const endocrine = deps.endocrine;
    const unsub = deps.workspace.subscribe(
      { types: ['affect' as WorkspaceItem['type']], minSalience: 0.4 },
      (item) => {
        const meta = item.metadata as { affectType?: string; intensity?: number } | undefined;
        if (!meta?.affectType) return;

        const intensity = meta.intensity ?? 0.5;
        if (intensity < 0.5) return;

        switch (meta.affectType) {
          case 'frustration':
            if (intensity > 0.6) {
              endocrine.stimulate({ hormone: 'cortisol', delta: 0.15, source: 'affect', reason: 'frustration detected' });
            }
            break;
          case 'anxiety':
            if (intensity > 0.5) {
              endocrine.stimulate({ hormone: 'cortisol', delta: 0.2, source: 'affect', reason: 'anxiety detected' });
              endocrine.stimulate({ hormone: 'adrenaline', delta: 0.1, source: 'affect', reason: 'anxiety arousal' });
            }
            break;
          case 'satisfaction':
            if (intensity > 0.5) {
              endocrine.stimulate({ hormone: 'dopamine', delta: 0.1, source: 'affect', reason: 'satisfaction reward' });
            }
            break;
          case 'pride':
            if (intensity > 0.5) {
              endocrine.stimulate({ hormone: 'dopamine', delta: 0.15, source: 'affect', reason: 'pride achievement' });
              endocrine.stimulate({ hormone: 'serotonin', delta: 0.05, source: 'affect', reason: 'pride stability' });
            }
            break;
          case 'excitement':
            if (intensity > 0.6) {
              endocrine.stimulate({ hormone: 'adrenaline', delta: 0.15, source: 'affect', reason: 'excitement arousal' });
              endocrine.stimulate({ hormone: 'dopamine', delta: 0.1, source: 'affect', reason: 'excitement reward' });
            }
            break;
        }
      },
    );
    unsubscribers.push(unsub);
    logger.debug('cross-system: wired affect -> endocrine');
  }

  // 2. Immune -> Endocrine: threats trigger stress response
  if (deps.immune && deps.endocrine) {
    const endocrine = deps.endocrine;
    const unsub = deps.workspace.subscribe(
      { types: ['immune' as WorkspaceItem['type']], minSalience: 0.5 },
      (item) => {
        const meta = item.metadata as { alertLevel?: string } | undefined;

        if (meta?.alertLevel === 'quarantine' || meta?.alertLevel === 'critical') {
          endocrine.stimulate({ hormone: 'cortisol', delta: 0.3, source: 'immune', reason: `immune ${meta.alertLevel}` });
          endocrine.stimulate({ hormone: 'adrenaline', delta: 0.2, source: 'immune', reason: 'threat response' });
        } else {
          endocrine.stimulate({ hormone: 'cortisol', delta: 0.2, source: 'immune', reason: 'threat detected' });
          endocrine.stimulate({ hormone: 'adrenaline', delta: 0.15, source: 'immune', reason: 'threat arousal' });
        }
      },
    );
    unsubscribers.push(unsub);
    logger.debug('cross-system: wired immune -> endocrine');
  }

  // 3. Homeostasis deviations -> Endocrine: persistent deviation triggers cortisol
  if (deps.homeostasis && deps.endocrine) {
    const endocrine = deps.endocrine;
    const unsub = deps.workspace.subscribe(
      { types: ['warning'], minSalience: 0.4 },
      (item) => {
        if (!item.source.includes('homeostasis')) return;

        const meta = item.metadata as { deviation?: number } | undefined;
        const deviation = meta?.deviation ?? 0.5;

        if (deviation > 0.5) {
          endocrine.stimulate({ hormone: 'cortisol', delta: 0.1, source: 'homeostasis', reason: 'set point deviation' });
        } else if (deviation < 0.2) {
          endocrine.stimulate({ hormone: 'serotonin', delta: 0.1, source: 'homeostasis', reason: 'deviation resolved' });
        }
      },
    );
    unsubscribers.push(unsub);
    logger.debug('cross-system: wired homeostasis -> endocrine');
  }

  // 4. Endocrine -> Homeostasis: hormone-derived stress as metric
  // This is a tick-driven flow, handled externally by the orchestrator tick cycle.
  // The homeostasis controller reads endocrine state on each tick.

  // 5. Affect -> Narrative: strong emotions become story events
  if (deps.affect && deps.narrative) {
    const narrative = deps.narrative;
    const unsub = deps.workspace.subscribe(
      { types: ['affect' as WorkspaceItem['type']], minSalience: 0.6 },
      (item) => {
        const meta = item.metadata as { affectType?: string; intensity?: number } | undefined;
        if (!meta?.affectType || (meta.intensity ?? 0) < 0.7) return;

        narrative.recordEvent({
          timestamp: new Date().toISOString(),
          description: item.content,
          significance: meta.intensity ?? 0.7,
          affect: meta.affectType,
        });
      },
    );
    unsubscribers.push(unsub);
    logger.debug('cross-system: wired affect -> narrative');
  }

  // 6. Growth transitions -> Narrative
  if (deps.narrative) {
    const narrative = deps.narrative;
    const unsub = deps.workspace.subscribe(
      { types: ['pattern'], minSalience: 0.5 },
      (item) => {
        if (!item.content.toLowerCase().includes('growth') && !item.content.toLowerCase().includes('transition')) return;

        narrative.recordEvent({
          timestamp: new Date().toISOString(),
          description: `Growth transition: ${item.content}`,
          significance: 0.8,
          affect: null,
        });
      },
    );
    unsubscribers.push(unsub);
    logger.debug('cross-system: wired growth patterns -> narrative');
  }

  // 7. Collaborative discoveries -> Endocrine: oxytocin on positive collaboration
  if (deps.endocrine) {
    const endocrine = deps.endocrine;
    const unsub = deps.workspace.subscribe(
      { types: ['discovery', 'skill'], minSalience: 0.5 },
      (item) => {
        if (item.source.includes('peer') || item.source.includes('collaboration')) {
          endocrine.stimulate({ hormone: 'oxytocin', delta: 0.1, source: 'collaboration', reason: 'shared discovery' });
        }
      },
    );
    unsubscribers.push(unsub);
    logger.debug('cross-system: wired collaboration -> endocrine');
  }

  // 8. Sleep wake -> Workspace broadcast
  // The SleepCycle broadcasts its own wake signal via workspace.broadcastSignal
  // during its tick cycle. No subscription needed here.

  // 9. Synapse events -> Endocrine: collaboration biology
  if (deps.endocrine) {
    const endocrine = deps.endocrine;
    const unsub = deps.workspace.subscribe(
      { types: ['synapse'], minSalience: 0.2 },
      (item) => {
        const meta = item.metadata as {
          event?: string;
          type?: string;
          strength?: number;
          origin?: string;
        } | undefined;
        if (!meta?.event) return;

        switch (meta.event) {
          case 'strengthened':
            // Bonding from productive partnership
            endocrine.stimulate({ hormone: 'oxytocin', delta: 0.1, source: 'synapse', reason: `${meta.type} synapse strengthened` });
            if (meta.type === 'delegation') {
              endocrine.stimulate({ hormone: 'dopamine', delta: 0.05, source: 'synapse', reason: 'effective delegation' });
            }
            break;
          case 'created':
            // Discovery reward for new emergent connections
            if (meta.origin === 'emergent') {
              endocrine.stimulate({ hormone: 'dopamine', delta: 0.1, source: 'synapse', reason: 'emergent synapse discovered' });
            }
            endocrine.stimulate({ hormone: 'oxytocin', delta: 0.05, source: 'synapse', reason: 'new connection formed' });
            break;
          case 'dissolved':
            // Loss of established relationship
            endocrine.stimulate({ hormone: 'cortisol', delta: 0.08, source: 'synapse', reason: 'synapse dissolved from inactivity' });
            break;
        }
      },
    );
    unsubscribers.push(unsub);
    logger.debug('cross-system: wired synapse -> endocrine');
  }

  // 10. Tool failures -> Immune escalation (wired in Phase 6)
  if (deps.immune) {
    const immune = deps.immune;
    const unsub = deps.workspace.subscribe(
      { types: ['failure'], minSalience: 0.3 },
      (item) => {
        try {
          const detection = immune.scan(item.content, item.source);
          if (detection.detected) {
            immune.respond(detection);
          }
        } catch { /* non-fatal */ }
      },
    );
    unsubscribers.push(unsub);
    logger.debug('cross-system: wired tool failures -> immune');
  }

  // 11. Homeostasis corrective actions -> Workspace broadcast (for scheduler/rate-limiter)
  if (deps.homeostasis) {
    const homeostasis = deps.homeostasis;
    const unsub = deps.workspace.subscribe(
      { types: ['warning'], minSalience: 0.5 },
      (item) => {
        if (!item.source.includes('homeostasis')) return;
        const meta = item.metadata as { action?: string; urgency?: number } | undefined;
        if (meta?.action === 'throttle' && (meta?.urgency ?? 0) > 0.6) {
          deps.workspace.broadcast({
            type: 'signal',
            source: 'homeostasis',
            content: `Throttle active: ${item.content}`,
            salience: 0.6,
            timestamp: Date.now(),
            metadata: { signal: 'scheduler_defer', urgency: meta.urgency },
          });
        }
      },
    );
    unsubscribers.push(unsub);
    logger.debug('cross-system: wired homeostasis -> scheduler signals');
  }

  // 12. Collaboration success -> Narrative identity event
  if (deps.narrative && deps.endocrine) {
    const narrative = deps.narrative;
    const unsub = deps.workspace.subscribe(
      { types: ['synapse'], minSalience: 0.4 },
      (item) => {
        const meta = item.metadata as { event?: string; type?: string } | undefined;
        if (meta?.event === 'created' || meta?.event === 'strengthened') {
          narrative.recordEvent({
            timestamp: new Date().toISOString(),
            description: `Collaboration milestone: ${meta.type} connection ${meta.event}`,
            significance: 0.6,
            affect: 'satisfaction',
          });
        }
      },
    );
    unsubscribers.push(unsub);
    logger.debug('cross-system: wired synapse -> narrative');
  }

  logger.debug({ flows: unsubscribers.length }, 'cross-system: connected');

  return () => {
    for (const unsub of unsubscribers) {
      unsub();
    }
    logger.debug('cross-system: disconnected');
  };
}
