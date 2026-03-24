/**
 * Task Distributor
 * Wraps the execution semaphore with peer-aware overflow logic.
 * When local queue is full and idle peers exist, delegates tasks automatically.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { TypedEventBus } from '../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../tui/types.js';
import { selectBestPeer } from './local-router.js';
import { extractRequirements } from './task-requirements.js';
import { parsePeerRow, delegateTask } from './peer-client.js';
import { logger } from '../lib/logger.js';

export interface DelegationResult {
  type: 'delegated';
  peerId: string;
  peerName: string;
  remoteTaskId: string;
}

export class TaskDistributor {
  constructor(
    private db: DatabaseAdapter,
    private emitter: TypedEventBus<RuntimeEvents> | null,
  ) {}

  /**
   * Try to delegate a task to a peer if local capacity is exhausted.
   * Returns a DelegationResult if delegated, or null if should execute locally.
   */
  async tryDelegate(
    agentConfig: Record<string, unknown>,
    agentId: string,
    taskDescription: string | null,
    input: string,
    localQueueActive: number,
    localQueueConcurrency: number,
  ): Promise<DelegationResult | null> {
    // Only consider delegation if local queue is at capacity
    if (localQueueActive < localQueueConcurrency) {
      return null;
    }

    // Check if there are any connected peers before doing expensive work
    const { data: peerCount } = await this.db
      .from('workspace_peers')
      .select('id')
      .eq('status', 'connected');

    if (!peerCount || (peerCount as unknown[]).length === 0) {
      return null;
    }

    const requirements = extractRequirements(agentConfig, taskDescription);

    // Don't delegate tasks that need local filesystem access
    if (requirements.needsLocalFiles) {
      return null;
    }

    const bestPeer = await selectBestPeer(this.db, {
      requiredModel: requirements.preferredModel || undefined,
      preferGpu: requirements.difficulty === 'complex',
      needsBrowser: requirements.needsBrowser,
      needsLocalFiles: requirements.needsLocalFiles,
      estimatedVramGB: requirements.estimatedVramGB,
      difficulty: requirements.difficulty,
    });

    // No suitable peer found, or self is best
    if (!bestPeer || bestPeer.peerId === 'self') {
      return null;
    }

    // Load the full peer record to delegate
    const { data: peerRow } = await this.db
      .from('workspace_peers')
      .select('*')
      .eq('id', bestPeer.peerId)
      .single();

    if (!peerRow) {
      return null;
    }

    const peer = parsePeerRow(peerRow as Record<string, unknown>);

    try {
      const result = await delegateTask(peer, agentId, input);

      logger.info(
        `[TaskDistributor] Delegated task to ${bestPeer.peerName} (${bestPeer.reason})`
      );

      this.emitter?.emit('task:delegated', {
        agentId,
        peerId: bestPeer.peerId,
        peerName: bestPeer.peerName,
        remoteTaskId: result.taskId,
      });

      return {
        type: 'delegated',
        peerId: bestPeer.peerId,
        peerName: bestPeer.peerName,
        remoteTaskId: result.taskId,
      };
    } catch (err) {
      logger.warn(
        `[TaskDistributor] Delegation to ${bestPeer.peerName} failed, will execute locally: ${err instanceof Error ? err.message : err}`
      );
      return null;
    }
  }

  /**
   * Poll a delegated task until completion. Returns the output.
   */
  async pollDelegatedTask(
    peerId: string,
    remoteTaskId: string,
    localTaskId: string,
    pollIntervalMs = 5000,
    maxFailedPolls = 3,
  ): Promise<{ output: string | null; status: string }> {
    const { data: peerRow } = await this.db
      .from('workspace_peers')
      .select('*')
      .eq('id', peerId)
      .single();

    if (!peerRow) {
      return { output: null, status: 'failed' };
    }

    const peer = parsePeerRow(peerRow as Record<string, unknown>);
    let failedPolls = 0;

    while (true) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

      try {
        const url = peer.base_url;
        const res = await fetch(`${url}/api/tasks/${remoteTaskId}`, {
          headers: peer.peer_token ? { 'X-Peer-Token': peer.peer_token } : {},
          signal: AbortSignal.timeout(10_000),
        });

        if (!res.ok) {
          failedPolls++;
          if (failedPolls >= maxFailedPolls) {
            logger.warn(`[TaskDistributor] Peer ${peer.name} unreachable after ${maxFailedPolls} polls, marking task failed`);
            return { output: null, status: 'failed' };
          }
          continue;
        }

        failedPolls = 0;
        const data = (await res.json()) as Record<string, unknown>;
        const task = (data.task || data.data || data) as Record<string, unknown>;
        const status = task.status as string;

        if (status === 'completed' || status === 'failed') {
          const output = (task.output as string) || null;

          // Update local task record
          const now = new Date().toISOString();
          await this.db.from('agent_workforce_tasks').update({
            status,
            output: output || (status === 'failed' ? (task.error_message as string) || 'Remote task failed' : ''),
            completed_at: now,
            updated_at: now,
          }).eq('id', localTaskId);

          this.emitter?.emit('task:completed', {
            taskId: localTaskId,
            status,
            delegated: true,
            peerId,
            peerName: peer.name,
          });

          return { output, status };
        }

        // Still running, continue polling
      } catch (err) {
        failedPolls++;
        logger.debug(`[TaskDistributor] Poll error: ${err instanceof Error ? err.message : err}`);
        if (failedPolls >= maxFailedPolls) {
          logger.warn(`[TaskDistributor] Max poll failures reached for delegated task ${remoteTaskId}`);
          return { output: null, status: 'failed' };
        }
      }
    }
  }
}
