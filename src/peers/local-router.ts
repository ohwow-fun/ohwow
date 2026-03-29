/**
 * Local Device Router
 * Selects the best peer for task delegation in the free-tier local mesh.
 * Uses the same scoring approach as the cloud device-router
 * but operates on workspace_peers data from local SQLite.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

interface PeerCandidate {
  id: string;
  name: string;
  baseUrl: string;
  status: string;
  totalMemoryGb: number | null;
  cpuCores: number | null;
  memoryTier: string | null;
  isAppleSilicon: boolean;
  hasNvidiaGpu: boolean;
  gpuName: string | null;
  localModels: string[];
  deviceRole: string;
  lastSeenAt: string | null;
  queueActive: number;
  queueWaiting: number;
}

interface RouteContext {
  requiredModel?: string;
  preferGpu?: boolean;
  needsBrowser?: boolean;
  needsLocalFiles?: boolean;
  estimatedVramGB?: number;
  difficulty?: string;
}

interface RouteResult {
  peerId: string;
  peerName: string;
  peerUrl: string;
  reason: string;
  score: number;
  breakdown: Record<string, number>;
}

const STALE_PEER_MS = 60_000;

function scorePeer(peer: PeerCandidate, context: RouteContext): { score: number; breakdown: Record<string, number> } {
  const breakdown: Record<string, number> = {};

  // Model availability (weight: 50)
  if (context.requiredModel) {
    if (peer.localModels.includes(context.requiredModel)) {
      breakdown.model = 50;
    }
  }

  // Hardware match (weight: 20)
  if (context.preferGpu) {
    if (peer.hasNvidiaGpu) breakdown.gpu = 15;
    if (peer.isAppleSilicon) breakdown.gpu = (breakdown.gpu || 0) + 10;
  }

  // Memory tier bonus
  const tierScores: Record<string, number> = { xlarge: 10, large: 6, medium: 3, small: 1, tiny: 0 };
  breakdown.memoryTier = tierScores[peer.memoryTier || 'medium'] ?? 3;

  // Worker role bonus
  if (peer.deviceRole === 'worker') breakdown.role = 5;

  // Queue depth penalty: -10 per active task
  const queuePenalty = -(peer.queueActive * 10 + peer.queueWaiting * 5);
  if (queuePenalty !== 0) breakdown.queue = queuePenalty;

  // Browser capability
  if (context.needsBrowser) {
    // Apple Silicon Macs have displays; NVIDIA GPU servers may not
    if (peer.isAppleSilicon) {
      breakdown.browser = 30;
    } else if (!peer.hasNvidiaGpu) {
      // Desktop machine, likely has display
      breakdown.browser = 10;
    } else {
      // GPU server, likely headless
      breakdown.browser = -100;
    }
  }

  // Filesystem affinity: if task needs local files, remote peer is not viable
  if (context.needsLocalFiles) {
    breakdown.filesystem = -Infinity;
  }

  // VRAM headroom
  if (context.estimatedVramGB && peer.totalMemoryGb) {
    const headroom = peer.totalMemoryGb - context.estimatedVramGB;
    if (headroom > 0) {
      breakdown.vram = Math.min(headroom * 2, 20);
    } else {
      breakdown.vram = headroom * 5; // negative: penalty for insufficient memory
    }
  }

  // Freshness penalty
  if (peer.lastSeenAt) {
    const age = Date.now() - new Date(peer.lastSeenAt).getTime();
    if (age > STALE_PEER_MS) {
      breakdown.freshness = -30;
    }
  } else {
    breakdown.freshness = -30;
  }

  const score = Object.values(breakdown).reduce((sum, v) => sum + v, 0);
  return { score, breakdown };
}

/**
 * Select the best peer for delegating a task.
 * Returns null if no peers are available or suitable.
 * Optionally includes the local device as a candidate for self-routing comparison.
 */
export async function selectBestPeer(
  db: DatabaseAdapter,
  context: RouteContext,
  selfDevice?: {
    totalMemoryGb: number;
    cpuCores: number;
    memoryTier: string;
    isAppleSilicon: boolean;
    hasNvidiaGpu: boolean;
    localModels: string[];
    queueActive: number;
    queueWaiting: number;
  },
): Promise<RouteResult | null> {
  const { data: peers } = await db
    .from('workspace_peers')
    .select('*')
    .eq('status', 'connected');

  const candidates: PeerCandidate[] = ((peers || []) as Record<string, unknown>[]).map((p) => ({
    id: p.id as string,
    name: p.name as string,
    baseUrl: p.base_url as string,
    status: p.status as string,
    totalMemoryGb: (p.total_memory_gb as number | null) ?? null,
    cpuCores: (p.cpu_cores as number | null) ?? null,
    memoryTier: (p.memory_tier as string | null) ?? null,
    isAppleSilicon: !!(p.is_apple_silicon),
    hasNvidiaGpu: !!(p.has_nvidia_gpu),
    gpuName: (p.gpu_name as string | null) ?? null,
    localModels: (() => {
      try {
        const raw = p.local_models as string | string[];
        if (typeof raw === 'string') return JSON.parse(raw) as string[];
        if (Array.isArray(raw)) return raw;
        return [];
      } catch {
        return [];
      }
    })(),
    deviceRole: (p.device_role as string) ?? 'hybrid',
    lastSeenAt: (p.last_seen_at as string | null) ?? null,
    queueActive: (p.queue_active as number) || 0,
    queueWaiting: (p.queue_waiting as number) || 0,
  }));

  if (selfDevice) {
    candidates.push({
      id: 'self',
      name: 'Local',
      baseUrl: '',
      status: 'connected',
      totalMemoryGb: selfDevice.totalMemoryGb,
      cpuCores: selfDevice.cpuCores,
      memoryTier: selfDevice.memoryTier,
      isAppleSilicon: selfDevice.isAppleSilicon,
      hasNvidiaGpu: selfDevice.hasNvidiaGpu,
      gpuName: null,
      localModels: selfDevice.localModels,
      deviceRole: 'hybrid',
      lastSeenAt: new Date().toISOString(),
      queueActive: selfDevice.queueActive,
      queueWaiting: selfDevice.queueWaiting,
    });
  }

  // Filter out coordinator-only peers
  const eligible = candidates.filter((p) => p.deviceRole !== 'coordinator');

  if (eligible.length === 0) {
    return null;
  }

  const scored = eligible
    .map((p) => ({ peer: p, ...scorePeer(p, context) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  logger.debug(
    { peerId: best.peer.id, peerName: best.peer.name, score: best.score, breakdown: best.breakdown },
    '[LocalRouter] Selected best peer'
  );

  const reasonParts = Object.entries(best.breakdown)
    .filter(([, v]) => v !== 0 && isFinite(v))
    .map(([k, v]) => `${k}: ${v > 0 ? '+' : ''}${v}`)
    .join(', ');

  return {
    peerId: best.peer.id,
    peerName: best.peer.name,
    peerUrl: best.peer.baseUrl,
    reason: `Score ${best.score} (${reasonParts})`,
    score: best.score,
    breakdown: best.breakdown,
  };
}
