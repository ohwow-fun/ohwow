/**
 * Person Model Refinement — periodic processing of unprocessed observations.
 *
 * Processes observations from agent_workforce_person_observations
 * and merges them into the corresponding Person Model dimensions.
 * Designed to run as a periodic maintenance task alongside
 * memory-maintenance.ts.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from './logger.js';

interface RefinementResult {
  modelsRefined: number;
  observationsProcessed: number;
}

/**
 * Run Person Model refinement for all models in a workspace.
 * Processes unprocessed observations and updates model dimensions.
 */
export async function runPersonModelRefinement(
  db: DatabaseAdapter,
  workspaceId: string,
): Promise<RefinementResult> {
  // Find models with unprocessed observations
  const { data: observations, error } = await db
    .from('agent_workforce_person_observations')
    .select('id, person_model_id, dimension, data, observation_type')
    .eq('workspace_id', workspaceId)
    .eq('processed', 0);

  if (error || !observations || observations.length === 0) {
    return { modelsRefined: 0, observationsProcessed: 0 };
  }

  // Group by model
  const byModel = new Map<string, typeof observations>();
  for (const obs of observations) {
    const modelId = obs.person_model_id as string;
    const list = byModel.get(modelId) || [];
    list.push(obs);
    byModel.set(modelId, list);
  }

  let totalProcessed = 0;

  for (const [modelId, modelObs] of byModel.entries()) {
    // Group observations by dimension
    const byDimension = new Map<string, typeof observations>();
    for (const obs of modelObs) {
      const dim = obs.dimension as string;
      const list = byDimension.get(dim) || [];
      list.push(obs);
      byDimension.set(dim, list);
    }

    // Get current model
    const { data: model } = await db
      .from('agent_workforce_person_models')
      .select('*')
      .eq('id', modelId)
      .single();

    if (!model) continue;

    const updates: Record<string, unknown> = {};

    for (const [dimension, dimObs] of byDimension.entries()) {
      const latest = dimObs[dimObs.length - 1];
      let obsData: unknown;
      try {
        obsData = typeof latest.data === 'string' ? JSON.parse(latest.data as string) : latest.data;
      } catch {
        continue;
      }

      if (!obsData || typeof obsData !== 'object') continue;

      let current: unknown;
      try {
        const raw = (model as Record<string, unknown>)[dimension];
        current = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        current = null;
      }

      if (Array.isArray(current)) {
        updates[dimension] = JSON.stringify([...current, ...(Array.isArray(obsData) ? obsData : [obsData])]);
      } else if (current && typeof current === 'object') {
        updates[dimension] = JSON.stringify({ ...(current as Record<string, unknown>), ...(obsData as Record<string, unknown>) });
      } else {
        updates[dimension] = JSON.stringify(obsData);
      }
    }

    // Apply updates
    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      await db
        .from('agent_workforce_person_models')
        .update(updates)
        .eq('id', modelId);
    }

    // Mark observations as processed
    for (const obs of modelObs) {
      await db
        .from('agent_workforce_person_observations')
        .update({ processed: 1 })
        .eq('id', obs.id as string);
    }

    totalProcessed += modelObs.length;
  }

  logger.info(
    { workspaceId, modelsRefined: byModel.size, observationsProcessed: totalProcessed },
    'Person Model refinement completed',
  );

  return { modelsRefined: byModel.size, observationsProcessed: totalProcessed };
}
