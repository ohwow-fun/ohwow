/**
 * Unified Nervous System — Cross-Domain Integration (Spinoza's Parallelism)
 *
 * "Deus sive Natura" — God or Nature. Mind and body are two attributes
 * of the same substance, running in parallel.
 *
 * The unified nervous system integrates digital and physical nervous systems
 * into a single somatic awareness. Its novel capability is computing
 * CROSS-DOMAIN AFFORDANCES: actions that require both digital and physical
 * context to make sense.
 *
 * Example: "The room is hot (physical) AND the calendar is free (digital)"
 * → affordance: "cool the room" (neither domain could produce this alone)
 *
 * This is where Spinoza's parallelism becomes concrete: the digital and
 * physical are not separate worlds but two expressions of one agent's
 * embodied situation.
 */

import type {
  Affordance,
  NervousSignal,
  Proprioception,
} from './types.js';
import type { DigitalNervousSystem } from './digital-nervous-system.js';
import type { PhysicalNervousSystem } from './physical-nervous-system.js';
import type { DigitalBody } from './digital-body.js';
import type { PhysicalBody } from './physical-body.js';
import type { ExperienceStream } from '../brain/experience-stream.js';
import type { GlobalWorkspace } from '../brain/global-workspace.js';

// ============================================================================
// CROSS-DOMAIN AFFORDANCE RULES
// ============================================================================

interface CrossDomainRule {
  /** Human-readable name. */
  name: string;
  /** Physical affordance pattern (regex on action name). */
  physicalPattern: RegExp;
  /** Digital affordance pattern. */
  digitalPattern: RegExp;
  /** The cross-domain action that emerges. */
  resultAction: string;
  /** Risk level. */
  risk: Affordance['risk'];
}

/**
 * Rules for detecting cross-domain affordances.
 * Each rule says: "if the physical body can do X and the digital body can do Y,
 * then the agent can do Z."
 */
const CROSS_DOMAIN_RULES: CrossDomainRule[] = [
  {
    name: 'monitor_and_alert',
    physicalPattern: /^read_/,
    digitalPattern: /^send_.*_message$/,
    resultAction: 'monitor_and_alert',
    risk: 'low',
  },
  {
    name: 'smart_climate',
    physicalPattern: /temp|temperature|humidity/i,
    digitalPattern: /navigate|calendar/i,
    resultAction: 'smart_climate_control',
    risk: 'low',
  },
  {
    name: 'security_response',
    physicalPattern: /motion|proximity|door/i,
    digitalPattern: /send_.*_message|screenshot/i,
    resultAction: 'security_monitor_and_notify',
    risk: 'medium',
  },
  {
    name: 'data_collection',
    physicalPattern: /^read_/,
    digitalPattern: /write_file|navigate/i,
    resultAction: 'collect_and_log_sensor_data',
    risk: 'none',
  },
];

// ============================================================================
// UNIFIED NERVOUS SYSTEM
// ============================================================================

export interface NervousSystemOptions {
  digitalBody: DigitalBody;
  physicalBody?: PhysicalBody;
  digitalNS: DigitalNervousSystem;
  physicalNS?: PhysicalNervousSystem;
  experienceStream?: ExperienceStream;
  workspace?: GlobalWorkspace;
}

export class NervousSystem {
  readonly digital: DigitalNervousSystem;
  readonly physical: PhysicalNervousSystem | null;

  private digitalBody: DigitalBody;
  private physicalBody: PhysicalBody | null;
  private experienceStream: ExperienceStream | null;
  private workspace: GlobalWorkspace | null;
  private running = false;

  constructor(options: NervousSystemOptions) {
    this.digitalBody = options.digitalBody;
    this.physicalBody = options.physicalBody ?? null;
    this.digital = options.digitalNS;
    this.physical = options.physicalNS ?? null;
    this.experienceStream = options.experienceStream ?? null;
    this.workspace = options.workspace ?? null;
  }

  // --------------------------------------------------------------------------
  // LIFECYCLE
  // --------------------------------------------------------------------------

  /** Start both nervous systems and the cross-domain bridge. */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.digital.start();
    this.physical?.start();

    // Bridge salient signals to the Brain's GlobalWorkspace
    this.digital.onSignal((signal) => this.bridgeToBrain(signal));
    this.physical?.onSignal((signal) => this.bridgeToBrain(signal));
  }

  /** Stop everything. */
  stop(): void {
    this.running = false;
    this.digital.stop();
    this.physical?.stop();
  }

  // --------------------------------------------------------------------------
  // PROPRIOCEPTION — Unified body awareness (Merleau-Ponty)
  // --------------------------------------------------------------------------

  /**
   * Get a full proprioceptive snapshot merging digital and physical.
   * This is the body's answer to the Brain's question: "What am I?"
   */
  getProprioception(): Proprioception {
    const digitalProprio = this.digitalBody.getProprioception();
    const physicalOrgans = this.physicalBody?.getOrgans() ?? [];
    const physicalAffordances = this.physicalBody?.getAllAffordances() ?? [];
    const physicalUmwelt = this.physicalBody?.getUmwelt() ?? [];

    // Merge both domains
    return {
      organs: [
        ...digitalProprio.organs,
        ...physicalOrgans.map(o => ({ id: o.id, name: o.name, domain: o.domain, health: o.getHealth() })),
      ],
      affordances: [
        ...digitalProprio.affordances,
        ...physicalAffordances,
        ...this.getCrossDomainAffordances(),
      ],
      umwelt: [
        ...digitalProprio.umwelt,
        ...physicalUmwelt,
      ],
      resources: digitalProprio.resources,
      timestamp: Date.now(),
    };
  }

  // --------------------------------------------------------------------------
  // CROSS-DOMAIN AFFORDANCES — The novel capability (Spinoza)
  // --------------------------------------------------------------------------

  /**
   * Compute affordances that emerge from the intersection of digital
   * and physical capabilities. Neither domain alone could produce these.
   */
  getCrossDomainAffordances(): Affordance[] {
    if (!this.physicalBody) return [];

    const digitalAffordances = this.digitalBody.getAllAffordances();
    const physicalAffordances = this.physicalBody.getAllAffordances();

    if (digitalAffordances.length === 0 || physicalAffordances.length === 0) return [];

    const crossAffordances: Affordance[] = [];

    for (const rule of CROSS_DOMAIN_RULES) {
      const matchingPhysical = physicalAffordances.filter(a => rule.physicalPattern.test(a.action));
      const matchingDigital = digitalAffordances.filter(a => rule.digitalPattern.test(a.action));

      if (matchingPhysical.length > 0 && matchingDigital.length > 0) {
        // Take the best match from each domain
        const physical = matchingPhysical[0];
        const digital = matchingDigital[0];

        crossAffordances.push({
          action: rule.resultAction,
          organId: `${physical.organId}+${digital.organId}`,
          domain: 'digital', // cross-domain actions are orchestrated digitally
          readiness: Math.min(physical.readiness, digital.readiness),
          estimatedLatencyMs: physical.estimatedLatencyMs + digital.estimatedLatencyMs,
          risk: rule.risk,
          prerequisites: [...physical.prerequisites, ...digital.prerequisites],
          crossDomain: true,
        });
      }
    }

    return crossAffordances;
  }

  // --------------------------------------------------------------------------
  // BRAIN BRIDGE
  // --------------------------------------------------------------------------

  /**
   * Forward salient nervous signals to the Brain's GlobalWorkspace.
   * Only signals above the salience threshold get broadcast.
   */
  private bridgeToBrain(signal: NervousSignal): void {
    if (!this.workspace || signal.salience < 0.5) return;

    this.workspace.broadcast({
      source: `ns:${signal.domain}:${signal.organId}`,
      type: signal.type === 'pain' ? 'failure'
        : signal.type === 'reflex_triggered' ? 'warning'
        : 'discovery',
      content: formatSignalForWorkspace(signal),
      salience: signal.salience,
      timestamp: signal.timestamp,
    });
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

function formatSignalForWorkspace(signal: NervousSignal): string {
  const data = signal.data as Record<string, unknown> | undefined;
  const detail = data
    ? Object.entries(data).map(([k, v]) => `${k}=${String(v)}`).join(', ')
    : '';
  return `${signal.domain}/${signal.organId}: ${signal.type}${detail ? ` (${detail.slice(0, 100)})` : ''}`;
}
