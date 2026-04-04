/**
 * Synapse Dynamics — Biological Agent-to-Agent Connections
 *
 * Merleau-Ponty's intercorporeality: coordination without central command.
 * Hegel's recognition dialectic: strength builds through mutual activation.
 *
 * Synapses are directed, typed connections between agents that strengthen
 * with use and decay without it. Some are configured by the user; others
 * emerge from observed behavior. This is the biological alternative to
 * corporate org chart hierarchy.
 *
 * Types:
 *   coordination — bidirectional, fast (nervous system signal)
 *   delegation   — one-way task assignment (efferent signal)
 *   nurture      — mentor/mentee growth (growth hormone)
 *   symbiotic    — mutualistic, both benefit (emergent from collaboration)
 *   immune       — one monitors the other's outputs (watchdog)
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { GlobalWorkspace } from '../brain/global-workspace.js';
import { logger } from '../lib/logger.js';

/** Optional Global Workspace for broadcasting synapse events */
let _workspace: GlobalWorkspace | null = null;

/** Set the Global Workspace for cross-system broadcasts. Call once at startup. */
export function setGlobalWorkspace(ws: GlobalWorkspace): void {
  _workspace = ws;
}

function broadcastSynapseEvent(
  event: string,
  content: string,
  salience: number,
  metadata: Record<string, unknown>,
): void {
  if (!_workspace) return;
  _workspace.broadcast({
    source: 'synapse-dynamics',
    type: 'synapse',
    content,
    salience,
    timestamp: Date.now(),
    metadata: { event, ...metadata },
  });
}

// ============================================================================
// TYPES
// ============================================================================

export type SynapseType = 'coordination' | 'delegation' | 'nurture' | 'symbiotic' | 'immune';
export type SynapseOrigin = 'configured' | 'emergent' | 'hybrid';

export interface Synapse {
  id: string;
  workspace_id: string;
  source_agent_id: string;
  target_agent_id: string;
  synapse_type: SynapseType;
  strength: number;
  origin: SynapseOrigin;
  evidence: Array<{ type: string; detail: string; timestamp: string }>;
  last_activated: string | null;
  activation_count: number;
  created_at: string;
  updated_at: string;
}

export interface SynapseEvidence {
  type: string;
  detail: string;
  timestamp: string;
}

// ============================================================================
// STRENGTHEN
// ============================================================================

const STRENGTHEN_INCREMENT = 0.05;
const MAX_STRENGTH = 1.0;
const MAX_EVIDENCE_ITEMS = 50;

/**
 * Strengthen a synapse after a successful interaction.
 * If the synapse doesn't exist and origin is 'emergent', creates it.
 * Strength increments by 0.05, capped at 1.0.
 */
export async function strengthenSynapse(
  db: DatabaseAdapter,
  workspaceId: string,
  sourceAgentId: string,
  targetAgentId: string,
  type: SynapseType,
  evidence: SynapseEvidence,
  origin: SynapseOrigin = 'emergent',
): Promise<void> {
  const now = new Date().toISOString();

  try {
    // Try to find existing synapse
    const { data: existing } = await db
      .from('agent_synapses')
      .select('id, strength, evidence, activation_count')
      .eq('workspace_id', workspaceId)
      .eq('source_agent_id', sourceAgentId)
      .eq('target_agent_id', targetAgentId)
      .eq('synapse_type', type)
      .maybeSingle();

    if (existing) {
      const row = existing as { id: string; strength: number; evidence: string; activation_count: number };
      const newStrength = Math.min(MAX_STRENGTH, row.strength + STRENGTHEN_INCREMENT);

      // Parse and append evidence, keeping only the most recent items
      let evidenceArr: SynapseEvidence[] = [];
      try { evidenceArr = JSON.parse(row.evidence || '[]') as SynapseEvidence[]; } catch { /* empty */ }
      evidenceArr.push(evidence);
      if (evidenceArr.length > MAX_EVIDENCE_ITEMS) {
        evidenceArr = evidenceArr.slice(-MAX_EVIDENCE_ITEMS);
      }

      await db.from('agent_synapses').update({
        strength: newStrength,
        evidence: JSON.stringify(evidenceArr),
        last_activated: now,
        activation_count: row.activation_count + 1,
        updated_at: now,
      }).eq('id', row.id);

      broadcastSynapseEvent('strengthened', `Synapse strengthened: ${type} ${sourceAgentId}→${targetAgentId}`, 0.3,
        { type, sourceAgentId, targetAgentId, strength: newStrength });

      logger.debug(
        { sourceAgentId, targetAgentId, type, strength: newStrength },
        '[synapse-dynamics] Strengthened synapse',
      );
    } else {
      // Create new synapse
      await db.from('agent_synapses').insert({
        workspace_id: workspaceId,
        source_agent_id: sourceAgentId,
        target_agent_id: targetAgentId,
        synapse_type: type,
        strength: 0.5 + STRENGTHEN_INCREMENT, // Initial + first activation
        origin,
        evidence: JSON.stringify([evidence]),
        last_activated: now,
        activation_count: 1,
      });

      broadcastSynapseEvent('created', `New ${origin} synapse: ${type} ${sourceAgentId}→${targetAgentId}`, 0.5,
        { type, sourceAgentId, targetAgentId, strength: 0.55, origin });

      logger.debug(
        { sourceAgentId, targetAgentId, type, origin },
        '[synapse-dynamics] Created new synapse',
      );
    }
  } catch (err) {
    logger.warn({ err, sourceAgentId, targetAgentId, type }, '[synapse-dynamics] Failed to strengthen synapse');
  }
}

// ============================================================================
// DECAY
// ============================================================================

const DECAY_RATE_PER_WEEK = 0.95; // multiply by this per week of inactivity
const MIN_STRENGTH_THRESHOLD = 0.1;

/**
 * Decay all synapses that haven't been activated recently.
 * Strength *= 0.95 for each week since last_activated.
 * Deletes synapses with strength < 0.1.
 *
 * Call this from the homeostasis cycle or a weekly scheduler.
 */
export async function decaySynapses(
  db: DatabaseAdapter,
  workspaceId: string,
): Promise<{ decayed: number; removed: number }> {
  let decayed = 0;
  let removed = 0;

  try {
    const { data: synapses } = await db
      .from('agent_synapses')
      .select('id, strength, last_activated')
      .eq('workspace_id', workspaceId);

    if (!synapses || !Array.isArray(synapses)) return { decayed, removed };

    const now = Date.now();

    for (const raw of synapses) {
      const row = raw as { id: string; strength: number; last_activated: string | null };
      if (!row.last_activated) continue;

      const lastActive = new Date(row.last_activated).getTime();
      const weeksSinceActive = (now - lastActive) / (7 * 24 * 60 * 60 * 1000);

      if (weeksSinceActive < 1) continue; // No decay within the first week

      const newStrength = row.strength * Math.pow(DECAY_RATE_PER_WEEK, weeksSinceActive);

      if (newStrength < MIN_STRENGTH_THRESHOLD) {
        await db.from('agent_synapses').delete().eq('id', row.id);
        removed++;
      } else {
        await db.from('agent_synapses').update({
          strength: Math.round(newStrength * 1000) / 1000, // 3 decimal places
          updated_at: new Date().toISOString(),
        }).eq('id', row.id);
        decayed++;
      }
    }

    if (removed > 0) {
      broadcastSynapseEvent('dissolved', `${removed} synapses dissolved from inactivity`, 0.4,
        { removed, decayed });
    }
    if (decayed > 0 || removed > 0) {
      logger.info({ workspaceId, decayed, removed }, '[synapse-dynamics] Decay cycle complete');
    }
  } catch (err) {
    logger.warn({ err, workspaceId }, '[synapse-dynamics] Decay cycle failed');
  }

  return { decayed, removed };
}

// ============================================================================
// HEALTH
// ============================================================================

/**
 * Compute the overall synapse health for a workspace.
 * Returns the average strength of all active synapses (0-1).
 * Returns 1.0 if no synapses exist (healthy default — no org, no problem).
 */
export async function computeSynapseHealth(
  db: DatabaseAdapter,
  workspaceId: string,
): Promise<number> {
  try {
    const { data } = await db
      .from('agent_synapses')
      .select('strength')
      .eq('workspace_id', workspaceId);

    if (!data || !Array.isArray(data) || data.length === 0) return 1.0;

    const strengths = data.map(r => (r as { strength: number }).strength);
    return strengths.reduce((sum, s) => sum + s, 0) / strengths.length;
  } catch (err) {
    logger.warn({ err }, '[synapse-dynamics] Failed to compute synapse health');
    return 1.0;
  }
}

// ============================================================================
// QUERY
// ============================================================================

/**
 * Get all synapses involving a specific agent (as source or target).
 */
export async function getAgentConnections(
  db: DatabaseAdapter,
  agentId: string,
  workspaceId: string,
): Promise<Synapse[]> {
  // Query both directions
  const [{ data: outgoing }, { data: incoming }] = await Promise.all([
    db.from('agent_synapses').select('*').eq('workspace_id', workspaceId).eq('source_agent_id', agentId),
    db.from('agent_synapses').select('*').eq('workspace_id', workspaceId).eq('target_agent_id', agentId),
  ]);

  const all = [...(outgoing || []), ...(incoming || [])] as unknown as Synapse[];

  // Deduplicate (coordination synapses may appear in both)
  const seen = new Set<string>();
  return all.filter(s => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

/**
 * Get the full org topology for a workspace: organ systems, agents, and synapses.
 */
export async function getOrgTopology(
  db: DatabaseAdapter,
  workspaceId: string,
): Promise<{
  organSystems: Array<{
    id: string;
    name: string;
    telos: string | null;
    parentId: string | null;
    systemType: string;
    agentIds: string[];
  }>;
  agents: Array<{
    id: string;
    name: string;
    role: string | null;
    organSystemId: string | null;
    autonomyLevel: number;
  }>;
  synapses: Array<{
    id: string;
    source: string;
    target: string;
    type: SynapseType;
    strength: number;
    origin: SynapseOrigin;
    activationCount: number;
  }>;
}> {
  const [{ data: depts }, { data: agents }, { data: synapses }] = await Promise.all([
    db.from('agent_workforce_departments').select('*').eq('workspace_id', workspaceId).order('sort_order'),
    db.from('agent_workforce_agents').select('id, name, role, department_id, autonomy_level').eq('workspace_id', workspaceId),
    db.from('agent_synapses').select('*').eq('workspace_id', workspaceId),
  ]);

  // Build agent ID sets per department
  const agentsByDept = new Map<string, string[]>();
  for (const raw of (agents || []) as Array<{ id: string; department_id: string | null }>) {
    if (raw.department_id) {
      const list = agentsByDept.get(raw.department_id) || [];
      list.push(raw.id);
      agentsByDept.set(raw.department_id, list);
    }
  }

  return {
    organSystems: ((depts || []) as Array<{
      id: string; name: string; telos: string | null;
      parent_id: string | null; system_type: string;
    }>).map(d => ({
      id: d.id,
      name: d.name,
      telos: d.telos,
      parentId: d.parent_id,
      systemType: d.system_type || 'organ_system',
      agentIds: agentsByDept.get(d.id) || [],
    })),
    agents: ((agents || []) as Array<{
      id: string; name: string; role: string | null;
      department_id: string | null; autonomy_level: number;
    }>).map(a => ({
      id: a.id,
      name: a.name,
      role: a.role,
      organSystemId: a.department_id,
      autonomyLevel: a.autonomy_level ?? 2,
    })),
    synapses: ((synapses || []) as Array<{
      id: string; source_agent_id: string; target_agent_id: string;
      synapse_type: SynapseType; strength: number; origin: SynapseOrigin;
      activation_count: number;
    }>).map(s => ({
      id: s.id,
      source: s.source_agent_id,
      target: s.target_agent_id,
      type: s.synapse_type,
      strength: s.strength,
      origin: s.origin,
      activationCount: s.activation_count,
    })),
  };
}
