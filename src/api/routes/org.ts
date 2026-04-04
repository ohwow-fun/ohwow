/**
 * Org Topology Routes
 * Biological org hierarchy: organ systems, agent synapses, and topology graph.
 *
 * Merleau-Ponty's intercorporeality — coordination without central command.
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import {
  getOrgTopology,
  getAgentConnections,
  type SynapseType,
  type SynapseOrigin,
} from '../../symbiosis/synapse-dynamics.js';

const VALID_SYNAPSE_TYPES: SynapseType[] = ['coordination', 'delegation', 'nurture', 'symbiotic', 'immune'];
const VALID_ORIGINS: SynapseOrigin[] = ['configured', 'emergent', 'hybrid'];

export function createOrgRouter(db: DatabaseAdapter): Router {
  const router = Router();

  // Full org topology graph
  router.get('/api/org/topology', async (req, res) => {
    try {
      const topology = await getOrgTopology(db, req.workspaceId);
      res.json({ data: topology });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // List all synapses
  router.get('/api/org/synapses', async (req, res) => {
    try {
      const { data, error } = await db.from('agent_synapses')
        .select('*')
        .eq('workspace_id', req.workspaceId)
        .order('strength', { ascending: false });

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Create a configured synapse
  router.post('/api/org/synapses', async (req, res) => {
    try {
      const { source_agent_id, target_agent_id, synapse_type, strength } = req.body;

      if (!source_agent_id || !target_agent_id) {
        res.status(400).json({ error: 'source_agent_id and target_agent_id are required' });
        return;
      }
      if (!synapse_type || !VALID_SYNAPSE_TYPES.includes(synapse_type)) {
        res.status(400).json({ error: `synapse_type must be one of: ${VALID_SYNAPSE_TYPES.join(', ')}` });
        return;
      }
      if (source_agent_id === target_agent_id) {
        res.status(400).json({ error: 'Source and target must be different agents' });
        return;
      }

      const now = new Date().toISOString();
      const id = crypto.randomUUID();

      const { error } = await db.from('agent_synapses').insert({
        id,
        workspace_id: req.workspaceId,
        source_agent_id,
        target_agent_id,
        synapse_type,
        strength: typeof strength === 'number' ? Math.max(0, Math.min(1, strength)) : 0.5,
        origin: 'configured',
        evidence: '[]',
        last_activated: now,
        activation_count: 0,
        created_at: now,
        updated_at: now,
      });

      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: created } = await db.from('agent_synapses').select('*').eq('id', id).single();
      res.status(201).json({ data: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Update a synapse
  router.patch('/api/org/synapses/:id', async (req, res) => {
    try {
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

      if (typeof req.body.strength === 'number') {
        updates.strength = Math.max(0, Math.min(1, req.body.strength));
      }
      if (req.body.synapse_type && VALID_SYNAPSE_TYPES.includes(req.body.synapse_type)) {
        updates.synapse_type = req.body.synapse_type;
      }
      if (req.body.origin && VALID_ORIGINS.includes(req.body.origin)) {
        updates.origin = req.body.origin;
      }

      const { error } = await db.from('agent_synapses')
        .update(updates)
        .eq('id', req.params.id)
        .eq('workspace_id', req.workspaceId);

      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: updated } = await db.from('agent_synapses').select('*').eq('id', req.params.id).single();
      res.json({ data: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Delete a synapse
  router.delete('/api/org/synapses/:id', async (req, res) => {
    try {
      const { error } = await db.from('agent_synapses')
        .delete()
        .eq('id', req.params.id)
        .eq('workspace_id', req.workspaceId);

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: { id: req.params.id } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Get all connections for a specific agent
  router.get('/api/org/agents/:id/connections', async (req, res) => {
    try {
      const connections = await getAgentConnections(db, req.params.id, req.workspaceId);
      res.json({ data: connections });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
