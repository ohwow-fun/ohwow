/**
 * Type definitions for the custom flow renderer.
 * Replaces @xyflow/react types with lightweight equivalents.
 */

import type { ComponentType } from 'react';

// ─── Node types ──────────────────────────────────────────────────────────────

export interface FlowNode<T = Record<string, unknown>> {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: T;
  width?: number;
  height?: number;
  selected?: boolean;
}

export interface FlowNodeProps<T = Record<string, unknown>> {
  id: string;
  data: T;
  selected?: boolean;
  handleProps?: HandleInteractionProps;
}

// ─── Edge types ──────────────────────────────────────────────────────────────

export interface FlowEdge<T = Record<string, unknown>> {
  id: string;
  source: string;
  sourceHandle?: string;
  target: string;
  targetHandle?: string;
  type?: string;
  data?: T;
}

export interface FlowEdgeProps {
  id: string;
  path: string;
  source: string;
  target: string;
  data?: Record<string, unknown>;
  sourceX?: number;
  sourceY?: number;
  targetX?: number;
  targetY?: number;
  onInsertStep?: (sourceId: string, targetId: string) => void;
}

// ─── Viewport ────────────────────────────────────────────────────────────────

export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

// ─── Handle info (computed from node positions) ──────────────────────────────

export interface HandleInfo {
  nodeId: string;
  handleId: string;
  type: 'source' | 'target';
  x: number;
  y: number;
}

// ─── Connection drag ────────────────────────────────────────────────────────

export interface HandleInteractionProps {
  onPointerDown: (
    e: React.PointerEvent,
    nodeId: string,
    handleId: string,
    type: 'source' | 'target',
  ) => void;
  activeDropTarget: { nodeId: string; handleId: string } | null;
}

export interface ConnectionDragState {
  sourceNodeId: string;
  sourceHandleId: string;
  sourceType: 'source' | 'target';
  /** Cursor position in flow-space coordinates */
  cursorX: number;
  cursorY: number;
}

// ─── Type maps ───────────────────────────────────────────────────────────────

export type NodeTypes = Record<string, ComponentType<FlowNodeProps<never>>>;
export type EdgeTypes = Record<string, ComponentType<FlowEdgeProps>>;
