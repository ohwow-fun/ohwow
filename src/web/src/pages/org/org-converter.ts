/**
 * Converts org topology API response into FlowNode[] + FlowEdge[]
 * for rendering with the generic FlowRenderer.
 */

import type { FlowNode, FlowEdge } from '../automations/flow-builder/renderer/types';

// ─── API response shape ─────────────────────────────────────────────────────

export interface OrgTopology {
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
    type: string;
    strength: number;
    origin: string;
    activationCount: number;
  }>;
}

// ─── Node data payloads ─────────────────────────────────────────────────────

export interface OrgAgentData {
  entityType: 'agent';
  agentId: string;
  name: string;
  role: string | null;
  autonomyLevel: number;
  organSystemId: string | null;
}

export interface OrgSystemData {
  entityType: 'organSystem';
  systemId: string;
  name: string;
  telos: string | null;
  systemType: string;
  agentCount: number;
}

// ─── Edge data payload ──────────────────────────────────────────────────────

export interface OrgSynapseData {
  synapseId: string;
  synapseType: 'coordination' | 'delegation' | 'nurture' | 'symbiotic' | 'immune';
  strength: number;
  origin: string;
  activationCount: number;
}

// ─── Converter ──────────────────────────────────────────────────────────────

export function convertTopologyToFlow(
  topology: OrgTopology,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  // Organ system nodes
  for (const sys of topology.organSystems) {
    nodes.push({
      id: `sys_${sys.id}`,
      type: 'organSystem',
      position: { x: 0, y: 0 },
      data: {
        entityType: 'organSystem',
        systemId: sys.id,
        name: sys.name,
        telos: sys.telos,
        systemType: sys.systemType,
        agentCount: sys.agentIds.length,
      } satisfies OrgSystemData,
      width: 240,
      height: 60,
    });
  }

  // Agent nodes
  for (const agent of topology.agents) {
    nodes.push({
      id: `agent_${agent.id}`,
      type: 'agent',
      position: { x: 0, y: 0 },
      data: {
        entityType: 'agent',
        agentId: agent.id,
        name: agent.name,
        role: agent.role,
        autonomyLevel: agent.autonomyLevel,
        organSystemId: agent.organSystemId,
      } satisfies OrgAgentData,
      width: 220,
      height: 70,
    });

    // Membership edge: organ system -> agent
    if (agent.organSystemId) {
      edges.push({
        id: `member_${agent.id}`,
        source: `sys_${agent.organSystemId}`,
        target: `agent_${agent.id}`,
        type: 'membership',
        data: { edgeType: 'membership' },
      });
    }
  }

  // Synapse edges
  for (const syn of topology.synapses) {
    edges.push({
      id: `syn_${syn.id}`,
      source: `agent_${syn.source}`,
      target: `agent_${syn.target}`,
      type: 'synapse',
      data: {
        synapseId: syn.id,
        synapseType: syn.type,
        strength: syn.strength,
        origin: syn.origin,
        activationCount: syn.activationCount,
      } satisfies OrgSynapseData,
    });
  }

  return { nodes, edges };
}
