/**
 * Agent Heartbeat Coordinator
 * Wakes agents on a configurable cadence for autonomous operation.
 *
 * Agents with a `heartbeat_interval_minutes` config field get periodic wakeup
 * tasks created and executed automatically. The coordinator runs alongside
 * LocalScheduler and uses the same RuntimeEngine for task execution.
 *
 * Heartbeat flow:
 *   1. Coordinator ticks every 60 seconds
 *   2. Checks which agents are due for a heartbeat (based on last_heartbeat_at)
 *   3. Creates a lightweight "heartbeat" task for each due agent
 *   4. Executes via RuntimeEngine (which may route to Claude Code CLI)
 *   5. Updates last_heartbeat_at timestamp
 *
 * Agent config fields:
 *   - heartbeat_enabled: boolean (default: false)
 *   - heartbeat_interval_minutes: number (default: 30, min: 5)
 *   - heartbeat_prompt: string (default: "Check for pending work and take action")
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { RuntimeEngine } from '../execution/engine.js';
import { logger } from '../lib/logger.js';

interface HeartbeatAgent {
  id: string;
  workspace_id: string;
  name: string;
  config: Record<string, unknown>;
  status: string;
}

const TICK_INTERVAL_MS = 60_000; // Check every 60 seconds
const MIN_INTERVAL_MINUTES = 5;
const DEFAULT_INTERVAL_MINUTES = 30;
const DEFAULT_HEARTBEAT_PROMPT = 'You are waking up on a scheduled heartbeat. Check your current state, review any pending work, and take the most impactful action available to you. If nothing is pending, report your status.';

export class HeartbeatCoordinator {
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private activeTasks = new Set<string>(); // agentIds with running heartbeat tasks

  constructor(
    private db: DatabaseAdapter,
    private engine: RuntimeEngine,
    private workspaceId: string,
  ) {}

  /**
   * Start the heartbeat coordinator.
   * Runs an initial tick, then checks every 60 seconds.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    logger.info('[HeartbeatCoordinator] Starting');

    // Initial tick
    await this.tick().catch((err) => {
      logger.error({ err }, '[HeartbeatCoordinator] Initial tick failed');
    });

    // Periodic tick
    this.tickTimer = setInterval(() => {
      this.tick().catch((err) => {
        logger.error({ err }, '[HeartbeatCoordinator] Tick error');
      });
    }, TICK_INTERVAL_MS);
  }

  /**
   * Stop the coordinator.
   */
  stop(): void {
    this.running = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    logger.info('[HeartbeatCoordinator] Stopped');
  }

  /**
   * Check all heartbeat-enabled agents and wake any that are due.
   */
  private async tick(): Promise<void> {
    if (!this.running) return;

    const now = new Date();

    // Find agents with heartbeat enabled
    const { data: agents } = await this.db
      .from<HeartbeatAgent>('agent_workforce_agents')
      .select('id, workspace_id, name, config, status')
      .eq('workspace_id', this.workspaceId);

    if (!agents) return;

    for (const row of agents) {
      const config = typeof row.config === 'string'
        ? (() => { try { return JSON.parse(row.config as string); } catch { return {}; } })()
        : (row.config || {});

      if (!config.heartbeat_enabled) continue;
      if (row.status === 'working') continue; // Don't wake busy agents
      if (this.activeTasks.has(row.id)) continue; // Already has a running heartbeat

      const intervalMinutes = Math.max(
        MIN_INTERVAL_MINUTES,
        (config.heartbeat_interval_minutes as number) || DEFAULT_INTERVAL_MINUTES,
      );

      // Check last heartbeat
      const lastHeartbeat = config.last_heartbeat_at
        ? new Date(config.last_heartbeat_at as string)
        : new Date(0); // Never run → always due

      const minutesSinceLastHeartbeat = (now.getTime() - lastHeartbeat.getTime()) / 60_000;

      if (minutesSinceLastHeartbeat < intervalMinutes) continue;

      // This agent is due for a heartbeat
      await this.wakeAgent(row, config);
    }
  }

  /**
   * Create and execute a heartbeat task for an agent.
   */
  private async wakeAgent(agent: HeartbeatAgent, agentConfig: Record<string, unknown>): Promise<void> {
    const prompt = (agentConfig.heartbeat_prompt as string) || DEFAULT_HEARTBEAT_PROMPT;

    logger.info({ agentId: agent.id, agentName: agent.name }, '[HeartbeatCoordinator] Waking agent');

    // Create heartbeat task
    const taskId = crypto.randomUUID();
    await this.db.from('agent_workforce_tasks').insert({
      id: taskId,
      agent_id: agent.id,
      title: `Heartbeat: ${agent.name}`,
      description: 'Scheduled heartbeat wakeup',
      input: prompt,
      status: 'pending',
      metadata: JSON.stringify({ trigger: 'heartbeat', heartbeat_at: new Date().toISOString() }),
    });

    // Track active heartbeat
    this.activeTasks.add(agent.id);

    // Execute (fire-and-forget, don't block the tick loop)
    this.engine.executeTask(agent.id, taskId)
      .then(async (result) => {
        logger.info(
          { agentId: agent.id, success: result.success, tokens: result.tokensUsed },
          '[HeartbeatCoordinator] Heartbeat completed',
        );

        // Update last_heartbeat_at in agent config
        await this.updateLastHeartbeat(agent.id);
      })
      .catch((err) => {
        logger.error({ err, agentId: agent.id }, '[HeartbeatCoordinator] Heartbeat execution failed');
      })
      .finally(() => {
        this.activeTasks.delete(agent.id);
      });
  }

  /**
   * Update the agent's last_heartbeat_at timestamp in their config.
   */
  private async updateLastHeartbeat(agentId: string): Promise<void> {
    try {
      const { data: agent } = await this.db
        .from('agent_workforce_agents')
        .select('config')
        .eq('id', agentId)
        .single();

      if (!agent) return;
      const config = typeof (agent as { config: unknown }).config === 'string'
        ? JSON.parse((agent as { config: string }).config)
        : (agent as { config: Record<string, unknown> }).config || {};

      config.last_heartbeat_at = new Date().toISOString();

      await this.db.from('agent_workforce_agents').update({
        config: JSON.stringify(config),
        updated_at: new Date().toISOString(),
      }).eq('id', agentId);
    } catch (err) {
      logger.warn({ err, agentId }, '[HeartbeatCoordinator] Failed to update last_heartbeat_at');
    }
  }
}
