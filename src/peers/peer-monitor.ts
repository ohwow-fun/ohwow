/**
 * Peer Monitor
 * Automatic periodic health checks for connected peers.
 * Detects offline peers, updates status, and emits events for TUI notification.
 */

import type { TypedEventBus } from '../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../tui/types.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { MeshCoordinator } from './mesh-coordinator.js';
import { healthCheck, parsePeerRow } from './peer-client.js';
import { logger } from '../lib/logger.js';

const DEFAULT_CHECK_INTERVAL_MS = 30_000;
const FAILOVER_THRESHOLD = 5;

export class PeerMonitor {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private meshCoordinator: MeshCoordinator | null;

  constructor(
    private db: DatabaseAdapter,
    private emitter?: TypedEventBus<RuntimeEvents>,
    meshCoordinator?: MeshCoordinator,
  ) {
    this.meshCoordinator = meshCoordinator ?? null;
  }

  /**
   * Start periodic health checks.
   */
  start(checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS): void {
    if (this.running) return;
    this.running = true;

    // Run first check after a short delay (let peers settle)
    setTimeout(() => {
      if (this.running) this.checkAll();
    }, 5000);

    this.interval = setInterval(() => {
      if (this.running) this.checkAll();
    }, checkIntervalMs);

    logger.info(`[PeerMonitor] Started (interval: ${checkIntervalMs / 1000}s)`);
  }

  /**
   * Stop periodic health checks.
   */
  stop(): void {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    logger.info('[PeerMonitor] Stopped');
  }

  /**
   * Run a health check on all connected peers.
   */
  private async checkAll(): Promise<void> {
    try {
      const { data: peers } = await this.db
        .from('workspace_peers')
        .select('*')
        .eq('status', 'connected');

      if (!peers || peers.length === 0) return;

      for (const peerRow of peers) {
        try {
          const peer = parsePeerRow(peerRow);
          const result = await healthCheck(peer, this.db);

          if (!result.healthy) {
            logger.warn(`[PeerMonitor] Peer unhealthy: ${peer.name} (${result.error || 'no response'})`);
            this.emitter?.emit('peer:unhealthy', {
              peerId: peer.id,
              name: peer.name,
              error: result.error,
            });

            // Check if peer has crossed the failover threshold
            const newFailures = peer.consecutive_failures + 1;
            if (newFailures >= FAILOVER_THRESHOLD && this.meshCoordinator) {
              const peerMachineId = (peerRow as Record<string, unknown>).machine_id as string | undefined;
              if (peerMachineId) {
                const connectionIds = this.meshCoordinator.getOwnedConnections(peerMachineId);
                if (connectionIds.length > 0) {
                  logger.info({ peerId: peer.id, peerMachineId, connectionIds }, '[PeerMonitor] Peer failover triggered');
                  this.emitter?.emit('peer:failover', {
                    peerId: peer.id,
                    machineId: peerMachineId,
                    connectionIds,
                  });
                }
              }
            }
          }

          // Fetch updated capabilities if healthy
          if (result.healthy && peer.base_url && peer.our_token) {
            await this.fetchCapabilities(peer.id, peer.base_url, peer.our_token);
          }
        } catch (err) {
          logger.debug(`[PeerMonitor] Check failed for peer ${peerRow.id}: ${err}`);
        }
      }
    } catch (err) {
      logger.error(`[PeerMonitor] Check cycle failed: ${err}`);
    }
  }

  /**
   * Fetch updated capabilities from a peer (model list, load).
   */
  private async fetchCapabilities(
    peerId: string,
    baseUrl: string,
    ourToken: string,
  ): Promise<void> {
    try {
      const response = await fetch(`${baseUrl}/api/runtime/status`, {
        headers: { 'X-Peer-Token': ourToken },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) return;

      const status = await response.json() as Record<string, unknown>;
      const models = status.localModels;

      if (Array.isArray(models)) {
        const modelNames = models.map((m: Record<string, unknown>) =>
          typeof m === 'string' ? m : (m.modelName as string) || ''
        ).filter(Boolean);

        await this.db
          .from('workspace_peers')
          .update({
            local_models: JSON.stringify(modelNames),
            updated_at: new Date().toISOString(),
          })
          .eq('id', peerId);
      }
    } catch {
      // Non-critical — capabilities update is best-effort
    }

    // Fetch queue status for routing decisions
    try {
      const queueRes = await fetch(`${baseUrl}/api/daemon/queue-status`, {
        headers: { 'X-Peer-Token': ourToken },
        signal: AbortSignal.timeout(5000),
      });
      if (queueRes.ok) {
        const queueData = await queueRes.json() as { active?: number; waiting?: number };
        await this.db
          .from('workspace_peers')
          .update({
            queue_active: queueData.active ?? 0,
            queue_waiting: queueData.waiting ?? 0,
            updated_at: new Date().toISOString(),
          })
          .eq('id', peerId);
      }
    } catch {
      // Non-critical
    }
  }
}
