/**
 * Anomaly Detection — Local Workspace
 *
 * Builds behavioral profiles from SQLite task history and detects
 * deviations using z-scores and Jensen-Shannon divergence.
 */

import crypto from 'crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';

// ============================================================================
// TYPES
// ============================================================================

interface MetricStats {
  mean: number;
  stddev: number;
}

export interface AgentBehaviorProfile {
  agentId: string;
  sampleSize: number;
  metrics: {
    tokensPerTask: MetricStats;
    durationSeconds: MetricStats;
    failureRate: number;
    avgTruthScore: number;
    toolFrequency: Record<string, number>;
  };
}

export type AnomalyAlertType =
  | 'token_spike'
  | 'duration_spike'
  | 'tool_drift'
  | 'failure_spike'
  | 'quality_drop';

export type AnomalySeverity = 'info' | 'warning' | 'critical';

export interface AnomalyAlert {
  agentId: string;
  taskId: string;
  type: AnomalyAlertType;
  severity: AnomalySeverity;
  expected: number;
  actual: number;
  zScore: number;
  message: string;
}

// ============================================================================
// MATH HELPERS
// ============================================================================

const MIN_SAMPLE_SIZE = 20;
const WARNING_Z_THRESHOLD = 2.5;
const CRITICAL_Z_THRESHOLD = 3.5;
const TOOL_DRIFT_THRESHOLD = 0.3;

function computeStats(values: number[]): MetricStats {
  if (values.length === 0) return { mean: 0, stddev: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return { mean, stddev: Math.sqrt(variance) };
}

function zScore(value: number, stats: MetricStats): number {
  if (stats.stddev === 0) return 0;
  return Math.abs(value - stats.mean) / stats.stddev;
}

function jensenShannonDivergence(
  p: Record<string, number>,
  q: Record<string, number>,
): number {
  const allKeys = new Set([...Object.keys(p), ...Object.keys(q)]);
  if (allKeys.size === 0) return 0;
  const eps = 1e-10;
  const pSum = Object.values(p).reduce((a, b) => a + b, 0) || 1;
  const qSum = Object.values(q).reduce((a, b) => a + b, 0) || 1;
  let divergence = 0;
  for (const key of allKeys) {
    const pVal = (p[key] || 0) / pSum + eps;
    const qVal = (q[key] || 0) / qSum + eps;
    const mVal = (pVal + qVal) / 2;
    divergence += 0.5 * pVal * Math.log(pVal / mVal);
    divergence += 0.5 * qVal * Math.log(qVal / mVal);
  }
  return Math.min(1, Math.max(0, divergence));
}

function determineSeverity(z: number): AnomalySeverity {
  if (z >= CRITICAL_Z_THRESHOLD) return 'critical';
  if (z >= WARNING_Z_THRESHOLD) return 'warning';
  return 'info';
}

// ============================================================================
// PROFILE BUILDING (SQLite)
// ============================================================================

interface TaskRow {
  tokens_used: number;
  duration_seconds: number;
  status: string;
  truth_score: number | null;
  metadata: string | Record<string, unknown> | null;
}

export async function buildBehaviorProfileLocal(
  db: DatabaseAdapter,
  agentId: string,
  windowDays = 30,
): Promise<AgentBehaviorProfile | null> {
  const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString();

  const { data } = await db
    .from<TaskRow>('agent_workforce_tasks')
    .select('tokens_used, duration_seconds, status, truth_score, metadata')
    .eq('agent_id', agentId)
    .gte('completed_at', cutoff)
    .order('completed_at', { ascending: false });

  if (!data || data.length < MIN_SAMPLE_SIZE) return null;
  const tasks = data ?? [];

  const completedOrFailed = tasks.filter(
    (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'needs_approval',
  );
  if (completedOrFailed.length < MIN_SAMPLE_SIZE) return null;

  const tokens = completedOrFailed.filter((t) => t.tokens_used > 0).map((t) => t.tokens_used);
  const durations = completedOrFailed.filter((t) => t.duration_seconds > 0).map((t) => t.duration_seconds);
  const failedCount = completedOrFailed.filter((t) => t.status === 'failed').length;
  const truthScores = completedOrFailed
    .filter((t) => t.truth_score != null)
    .map((t) => t.truth_score!);

  const toolCounts: Record<string, number> = {};
  let totalToolCalls = 0;
  for (const task of completedOrFailed) {
    const meta = typeof task.metadata === 'string'
      ? (() => { try { return JSON.parse(task.metadata as string); } catch { return null; } })()
      : task.metadata;
    const reactTrace = (meta as Record<string, unknown> | null)?.react_trace as Array<{
      actions?: Array<{ tool: string }>;
    }> | undefined;
    if (reactTrace) {
      for (const step of reactTrace) {
        if (step.actions) {
          for (const action of step.actions) {
            toolCounts[action.tool] = (toolCounts[action.tool] || 0) + 1;
            totalToolCalls++;
          }
        }
      }
    }
  }

  const toolFrequency: Record<string, number> = {};
  if (totalToolCalls > 0) {
    for (const [tool, count] of Object.entries(toolCounts)) {
      toolFrequency[tool] = count / totalToolCalls;
    }
  }

  return {
    agentId,
    sampleSize: completedOrFailed.length,
    metrics: {
      tokensPerTask: computeStats(tokens),
      durationSeconds: computeStats(durations),
      failureRate: failedCount / completedOrFailed.length,
      avgTruthScore: truthScores.length > 0
        ? truthScores.reduce((a, b) => a + b, 0) / truthScores.length
        : 0,
      toolFrequency,
    },
  };
}

// ============================================================================
// DETECTION
// ============================================================================

interface TaskResult {
  taskId: string;
  tokensUsed: number;
  durationSeconds: number;
  failed: boolean;
  truthScore: number | null;
  toolsUsed: string[];
}

export function detectAnomaliesLocal(
  taskResult: TaskResult,
  profile: AgentBehaviorProfile,
): AnomalyAlert[] {
  const alerts: AnomalyAlert[] = [];
  const { metrics } = profile;

  if (taskResult.tokensUsed > 0 && metrics.tokensPerTask.stddev > 0) {
    const z = zScore(taskResult.tokensUsed, metrics.tokensPerTask);
    if (z >= WARNING_Z_THRESHOLD) {
      alerts.push({
        agentId: profile.agentId,
        taskId: taskResult.taskId,
        type: 'token_spike',
        severity: determineSeverity(z),
        expected: metrics.tokensPerTask.mean,
        actual: taskResult.tokensUsed,
        zScore: z,
        message: `Token usage ${taskResult.tokensUsed} is ${z.toFixed(1)}σ from mean ${Math.round(metrics.tokensPerTask.mean)}`,
      });
    }
  }

  if (taskResult.durationSeconds > 0 && metrics.durationSeconds.stddev > 0) {
    const z = zScore(taskResult.durationSeconds, metrics.durationSeconds);
    if (z >= WARNING_Z_THRESHOLD) {
      alerts.push({
        agentId: profile.agentId,
        taskId: taskResult.taskId,
        type: 'duration_spike',
        severity: determineSeverity(z),
        expected: metrics.durationSeconds.mean,
        actual: taskResult.durationSeconds,
        zScore: z,
        message: `Duration ${taskResult.durationSeconds}s is ${z.toFixed(1)}σ from mean ${Math.round(metrics.durationSeconds.mean)}s`,
      });
    }
  }

  if (taskResult.toolsUsed.length > 0 && Object.keys(metrics.toolFrequency).length > 0) {
    const taskToolFreq: Record<string, number> = {};
    for (const tool of taskResult.toolsUsed) {
      taskToolFreq[tool] = (taskToolFreq[tool] || 0) + 1;
    }
    const total = taskResult.toolsUsed.length;
    for (const key of Object.keys(taskToolFreq)) {
      taskToolFreq[key] /= total;
    }
    const jsd = jensenShannonDivergence(taskToolFreq, metrics.toolFrequency);
    if (jsd >= TOOL_DRIFT_THRESHOLD) {
      alerts.push({
        agentId: profile.agentId,
        taskId: taskResult.taskId,
        type: 'tool_drift',
        severity: jsd >= 0.6 ? 'warning' : 'info',
        expected: 0,
        actual: jsd,
        zScore: 0,
        message: `Tool usage pattern diverged from baseline (JSD: ${jsd.toFixed(2)})`,
      });
    }
  }

  if (taskResult.failed && metrics.failureRate < 0.5) {
    alerts.push({
      agentId: profile.agentId,
      taskId: taskResult.taskId,
      type: 'failure_spike',
      severity: 'warning',
      expected: metrics.failureRate,
      actual: 1.0,
      zScore: 0,
      message: `Task failed; baseline failure rate is ${(metrics.failureRate * 100).toFixed(0)}%`,
    });
  }

  if (taskResult.truthScore != null && metrics.avgTruthScore > 0) {
    const truthStddev = metrics.avgTruthScore * 0.15;
    if (truthStddev > 0) {
      const z = (metrics.avgTruthScore - taskResult.truthScore) / truthStddev;
      if (z >= 2) {
        alerts.push({
          agentId: profile.agentId,
          taskId: taskResult.taskId,
          type: 'quality_drop',
          severity: z >= 3 ? 'critical' : 'warning',
          expected: metrics.avgTruthScore,
          actual: taskResult.truthScore,
          zScore: z,
          message: `Truth score ${taskResult.truthScore} is ${z.toFixed(1)}σ below average ${Math.round(metrics.avgTruthScore)}`,
        });
      }
    }
  }

  return alerts;
}

/**
 * Persist anomaly alerts to the local SQLite database.
 */
export async function persistAlertsLocal(
  db: DatabaseAdapter,
  workspaceId: string,
  alerts: AnomalyAlert[],
): Promise<void> {
  for (const alert of alerts) {
    await db.from('agent_workforce_anomaly_alerts').insert({
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      agent_id: alert.agentId,
      task_id: alert.taskId,
      alert_type: alert.type,
      severity: alert.severity,
      expected_value: alert.expected,
      actual_value: alert.actual,
      z_score: alert.zScore,
      message: alert.message,
    });
  }
}
