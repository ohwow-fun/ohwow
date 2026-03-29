/**
 * Mesh Body — Distributed Embodiment (Merleau-Ponty's Intercorporeality)
 *
 * "The body is our general medium for having a world."
 *
 * In a mesh, physical devices across peers form ONE distributed body.
 * Device A has a temperature sensor. Device B has a camera. Together
 * they constitute a single workspace body with thermal AND visual
 * perception. The MeshBody aggregates these into a unified Umwelt.
 */

import type {
  MeshBodySnapshot,
  MeshDistributedBody,
} from './types.js';
import type { Affordance, UmweltDimension } from '../body/types.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Snapshots older than this are marked stale. */
const STALE_THRESHOLD_MS = 90_000; // 90 seconds (3 missed 30s health checks)

// ============================================================================
// CROSS-DEVICE AFFORDANCE RULES
// ============================================================================

interface CrossDeviceRule {
  name: string;
  deviceAPattern: RegExp;
  deviceBPattern: RegExp;
  resultAction: string;
  risk: Affordance['risk'];
}

const CROSS_DEVICE_RULES: CrossDeviceRule[] = [
  {
    name: 'mesh_monitor_and_alert',
    deviceAPattern: /^read_/,
    deviceBPattern: /send.*message/,
    resultAction: 'mesh_monitor_and_alert',
    risk: 'low',
  },
  {
    name: 'mesh_visual_analysis',
    deviceAPattern: /camera|screenshot|capture/,
    deviceBPattern: /analyze|ocr|extract/,
    resultAction: 'mesh_visual_analysis',
    risk: 'none',
  },
  {
    name: 'mesh_feedback_control',
    deviceAPattern: /^read_/,
    deviceBPattern: /^command_|^actuate_/,
    resultAction: 'mesh_feedback_control',
    risk: 'medium',
  },
];

// ============================================================================
// MESH BODY
// ============================================================================

export class MeshBody {
  private localDeviceId: string;

  constructor(localDeviceId: string) {
    this.localDeviceId = localDeviceId;
  }

  /**
   * Aggregate body snapshots from all peers into a unified distributed body.
   */
  aggregate(localSnapshot: MeshBodySnapshot, peerSnapshots: MeshBodySnapshot[]): MeshDistributedBody {
    const allSnapshots = [localSnapshot, ...peerSnapshots];
    const now = Date.now();

    const organs: MeshDistributedBody['organs'] = [];
    const umwelt: MeshDistributedBody['umwelt'] = [];
    const affordances: MeshDistributedBody['affordances'] = [];
    const deviceResources: MeshDistributedBody['deviceResources'] = [];

    for (const snap of allSnapshots) {
      const stale = (now - snap.capturedAt) > STALE_THRESHOLD_MS;

      // Organs
      for (const organ of snap.organs) {
        organs.push({ ...organ, sourceDeviceId: snap.deviceId });
      }

      // Umwelt
      for (const dim of snap.umwelt) {
        umwelt.push({ ...dim, sourceDeviceId: snap.deviceId } as UmweltDimension & { sourceDeviceId: string });
      }

      // Affordances (with staleness adjustment)
      for (const aff of snap.affordances) {
        affordances.push({
          ...aff,
          readiness: stale ? 0 : aff.readiness,
          sourceDeviceId: snap.deviceId,
        } as Affordance & { sourceDeviceId: string });
      }

      // Resources
      deviceResources.push({
        deviceId: snap.deviceId,
        deviceName: snap.deviceName,
        resources: snap.resources,
        lastSeen: snap.capturedAt,
        stale,
      });
    }

    // Compute cross-device affordances
    const crossAffs = this.computeCrossDeviceAffordances(allSnapshots);
    for (const aff of crossAffs) {
      affordances.push(aff as Affordance & { sourceDeviceId: string });
    }

    // Count unique modalities
    const modalitySet = new Set(umwelt.map(d => d.modality));

    return {
      organs,
      umwelt,
      affordances,
      deviceResources,
      totalModalities: modalitySet.size,
      totalAffordances: affordances.length,
      aggregatedAt: now,
    };
  }

  /**
   * Compute affordances that emerge from combining capabilities across devices.
   */
  private computeCrossDeviceAffordances(snapshots: MeshBodySnapshot[]): Array<Affordance & { sourceDeviceId: string }> {
    if (snapshots.length < 2) return [];

    const crossAffs: Array<Affordance & { sourceDeviceId: string }> = [];

    for (const rule of CROSS_DEVICE_RULES) {
      // Find device A with matching affordance
      for (const snapA of snapshots) {
        const matchA = snapA.affordances.find(a => rule.deviceAPattern.test(a.action));
        if (!matchA) continue;

        // Find device B (different device) with matching affordance
        for (const snapB of snapshots) {
          if (snapB.deviceId === snapA.deviceId) continue;
          const matchB = snapB.affordances.find(a => rule.deviceBPattern.test(a.action));
          if (!matchB) continue;

          crossAffs.push({
            action: rule.resultAction,
            organId: `${matchA.organId}@${snapA.deviceId}+${matchB.organId}@${snapB.deviceId}`,
            domain: 'digital',
            readiness: Math.min(matchA.readiness, matchB.readiness),
            estimatedLatencyMs: matchA.estimatedLatencyMs + matchB.estimatedLatencyMs + 200, // +200ms for mesh overhead
            risk: rule.risk,
            prerequisites: [
              `device ${snapA.deviceName} connected`,
              `device ${snapB.deviceName} connected`,
            ],
            crossDomain: true,
            sourceDeviceId: `${snapA.deviceId}+${snapB.deviceId}`,
          });

          break; // one match per rule per device A
        }
      }
    }

    return crossAffs;
  }
}
