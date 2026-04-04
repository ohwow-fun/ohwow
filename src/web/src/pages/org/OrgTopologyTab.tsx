/**
 * Org Topology visualization tab.
 * Renders organ systems, agents, and synapses as an interactive DAG
 * using the shared FlowRenderer.
 */

import { useState, useMemo, useCallback } from 'react';
import { FlowRenderer } from '../automations/flow-builder/renderer/FlowRenderer';
import type { FlowNode, NodeTypes, EdgeTypes } from '../automations/flow-builder/renderer/types';
import { useApi } from '../../hooks/useApi';
import { useWsRefresh } from '../../hooks/useWebSocket';
import { OrgAgentNode } from './OrgAgentNode';
import { OrgSystemNode } from './OrgSystemNode';
import { OrgSynapseEdge } from './OrgSynapseEdge';
import { convertTopologyToFlow, type OrgTopology } from './org-converter';
import { layoutOrgNodes } from './org-layout';

const nodeTypes: NodeTypes = {
  agent: OrgAgentNode,
  organSystem: OrgSystemNode,
};

const edgeTypes: EdgeTypes = {
  synapse: OrgSynapseEdge,
  membership: OrgSynapseEdge,
};

export function OrgTopologyTab() {
  const tick = useWsRefresh([
    'agent:upserted',
    'agent:removed',
    'department:upserted',
    'department:removed',
  ]);
  const { data, loading } = useApi<OrgTopology>('/api/org/topology', [tick]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const { nodes, edges } = useMemo(() => {
    if (!data) return { nodes: [] as FlowNode[], edges: [] };
    const converted = convertTopologyToFlow(data);
    const laid = layoutOrgNodes(converted.nodes, converted.edges);
    return { nodes: laid, edges: converted.edges };
  }, [data]);

  const onNodeClick = useCallback((_nodeId: string, _node: FlowNode) => {
    setSelectedNodeId(_nodeId);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-500">
        Loading topology...
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-zinc-500">
        <p className="text-lg mb-1">No agents or departments yet</p>
        <p className="text-sm text-zinc-600">
          Create agents and departments to see the org topology
        </p>
      </div>
    );
  }

  return (
    <div className="h-[600px] border border-zinc-800 rounded-lg overflow-hidden">
      <FlowRenderer
        nodes={nodes}
        edges={edges}
        selectedNodeId={selectedNodeId}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        fitViewOnMount
      />
    </div>
  );
}
