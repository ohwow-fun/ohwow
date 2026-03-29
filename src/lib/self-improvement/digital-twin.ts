/**
 * Digital Twin Builder (E24) — Build Causal Graph from Business Metrics
 *
 * Queries 90 days of business metrics and constructs a causal
 * model that can be used for what-if simulations.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { buildCausalEdges } from './causal-model.js';
import type { CausalNode, CausalModelSnapshot, TwinBuildResult } from './types.js';
import { logger } from '../logger.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const LOOKBACK_DAYS = 90;

// ============================================================================
// METRIC COLLECTORS
// ============================================================================

function dateBuckets(days: number): string[] {
  const buckets: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    buckets.push(d.toISOString().split('T')[0]);
  }
  return buckets;
}

async function collectTaskThroughput(db: DatabaseAdapter, workspaceId: string, since: string): Promise<number[]> {
  const { data: tasks } = await db
    .from('agent_workforce_tasks')
    .select('completed_at')
    .eq('workspace_id', workspaceId)
    .eq('status', 'completed')
    .gte('completed_at', since)
    .order('completed_at', { ascending: true });

  const buckets = dateBuckets(LOOKBACK_DAYS);
  const counts = new Array(buckets.length).fill(0);

  if (tasks) {
    for (const task of tasks) {
      const date = ((task as Record<string, unknown>).completed_at as string)?.split('T')[0];
      const idx = buckets.indexOf(date);
      if (idx >= 0) counts[idx]++;
    }
  }

  return counts;
}

async function collectSuccessRate(db: DatabaseAdapter, workspaceId: string, since: string): Promise<number[]> {
  const { data: tasks } = await db
    .from('agent_workforce_tasks')
    .select('status, completed_at')
    .eq('workspace_id', workspaceId)
    .in('status', ['completed', 'failed'])
    .gte('completed_at', since);

  const buckets = dateBuckets(LOOKBACK_DAYS);
  const successes = new Array(buckets.length).fill(0);
  const totals = new Array(buckets.length).fill(0);

  if (tasks) {
    for (const task of tasks) {
      const row = task as Record<string, unknown>;
      const date = (row.completed_at as string)?.split('T')[0];
      const idx = buckets.indexOf(date);
      if (idx >= 0) {
        totals[idx]++;
        if (row.status === 'completed') successes[idx]++;
      }
    }
  }

  return buckets.map((_, i) => totals[i] > 0 ? successes[i] / totals[i] : 0);
}

async function collectAvgCost(db: DatabaseAdapter, workspaceId: string, since: string): Promise<number[]> {
  const { data: tasks } = await db
    .from('agent_workforce_tasks')
    .select('cost_cents, completed_at')
    .eq('workspace_id', workspaceId)
    .eq('status', 'completed')
    .gte('completed_at', since);

  const buckets = dateBuckets(LOOKBACK_DAYS);
  const costs = new Array(buckets.length).fill(0);
  const counts = new Array(buckets.length).fill(0);

  if (tasks) {
    for (const task of tasks) {
      const row = task as Record<string, unknown>;
      const date = (row.completed_at as string)?.split('T')[0];
      const idx = buckets.indexOf(date);
      if (idx >= 0) {
        costs[idx] += (row.cost_cents as number) || 0;
        counts[idx]++;
      }
    }
  }

  return buckets.map((_, i) => counts[i] > 0 ? costs[i] / counts[i] : 0);
}

async function collectContactCount(db: DatabaseAdapter, workspaceId: string, since: string): Promise<number[]> {
  try {
    const { data: contacts } = await db
      .from('agent_workforce_contacts')
      .select('created_at')
      .eq('workspace_id', workspaceId)
      .gte('created_at', since)
      .order('created_at', { ascending: true });

    const buckets = dateBuckets(LOOKBACK_DAYS);
    const counts = new Array(buckets.length).fill(0);

    const { count: baseCount } = await db
      .from('agent_workforce_contacts')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .lt('created_at', since);

    let cumulative = baseCount ?? 0;

    if (contacts) {
      for (const contact of contacts) {
        const date = ((contact as Record<string, unknown>).created_at as string)?.split('T')[0];
        const idx = buckets.indexOf(date);
        if (idx >= 0) counts[idx]++;
      }
    }

    return counts.map((c) => {
      cumulative += c;
      return cumulative;
    });
  } catch {
    return new Array(LOOKBACK_DAYS).fill(0);
  }
}

// ============================================================================
// MAIN BUILDER
// ============================================================================

/**
 * Build the causal model from 90 days of business metrics.
 */
export async function buildDigitalTwin(
  db: DatabaseAdapter,
  workspaceId: string
): Promise<{ result: TwinBuildResult; snapshot: CausalModelSnapshot }> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [throughput, successRate, avgCost, contacts] = await Promise.all([
    collectTaskThroughput(db, workspaceId, since),
    collectSuccessRate(db, workspaceId, since),
    collectAvgCost(db, workspaceId, since),
    collectContactCount(db, workspaceId, since),
  ]);

  const nodes: CausalNode[] = [
    { id: 'throughput', name: 'Agent Throughput (tasks/day)', currentValue: throughput[throughput.length - 1] || 0, historicalValues: throughput, unit: 'tasks/day' },
    { id: 'success_rate', name: 'Agent Success Rate', currentValue: successRate[successRate.length - 1] || 0, historicalValues: successRate, unit: 'ratio' },
    { id: 'avg_cost', name: 'Average Task Cost', currentValue: avgCost[avgCost.length - 1] || 0, historicalValues: avgCost, unit: 'cents' },
    { id: 'contacts', name: 'Contact Count', currentValue: contacts[contacts.length - 1] || 0, historicalValues: contacts, unit: 'contacts' },
  ];

  const edges = buildCausalEdges(nodes);

  const avgCorrelation = edges.length > 0
    ? edges.reduce((sum, e) => sum + Math.abs(e.correlation), 0) / edges.length
    : 0;

  const snapshot: CausalModelSnapshot = {
    nodes,
    edges,
    projections: [],
    confidence: avgCorrelation,
    createdAt: new Date().toISOString(),
  };

  // Persist snapshot
  try {
    await db
      .from('agent_workforce_digital_twin_snapshots')
      .insert({
        workspace_id: workspaceId,
        causal_graph: JSON.stringify({ nodes, edges }),
        metrics_snapshot: JSON.stringify(nodes.map((n) => ({ id: n.id, name: n.name, currentValue: n.currentValue, unit: n.unit }))),
        confidence: avgCorrelation,
      });
  } catch { /* non-fatal */ }

  logger.info(
    { workspaceId, metricsCount: nodes.length, edgesCount: edges.length, confidence: avgCorrelation.toFixed(3) },
    '[DigitalTwin] Causal model built',
  );

  return {
    result: { metricsCount: nodes.length, edgesCount: edges.length, projectionsCount: 0, confidence: avgCorrelation },
    snapshot,
  };
}
