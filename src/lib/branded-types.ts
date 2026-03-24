/**
 * Branded Types
 *
 * Nominal typing for entity IDs. Prevents accidental mixing of
 * different ID types (e.g. passing an AgentId where a TaskId is expected).
 */

import { z } from 'zod';

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

// ============================================================================
// BRANDED ID TYPES
// ============================================================================

export type AgentId = Brand<string, 'AgentId'>;
export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type AutomationId = Brand<string, 'AutomationId'>;
export type TriggerId = Brand<string, 'TriggerId'>;
export type PeerId = Brand<string, 'PeerId'>;
export type ContactId = Brand<string, 'ContactId'>;
export type WorkflowId = Brand<string, 'WorkflowId'>;
export type AttachmentId = Brand<string, 'AttachmentId'>;
export type SessionId = Brand<string, 'SessionId'>;

// ============================================================================
// CONSTRUCTOR FUNCTIONS
// ============================================================================

export function agentId(raw: string): AgentId { return raw as AgentId; }
export function workspaceId(raw: string): WorkspaceId { return raw as WorkspaceId; }
export function taskId(raw: string): TaskId { return raw as TaskId; }
export function automationId(raw: string): AutomationId { return raw as AutomationId; }
export function triggerId(raw: string): TriggerId { return raw as TriggerId; }
export function peerId(raw: string): PeerId { return raw as PeerId; }
export function contactId(raw: string): ContactId { return raw as ContactId; }
export function workflowId(raw: string): WorkflowId { return raw as WorkflowId; }
export function attachmentId(raw: string): AttachmentId { return raw as AttachmentId; }
export function sessionId(raw: string): SessionId { return raw as SessionId; }

// ============================================================================
// ZOD SCHEMAS
// ============================================================================

export const AgentIdSchema = z.string().uuid().transform(s => s as AgentId);
export const WorkspaceIdSchema = z.string().transform(s => s as WorkspaceId);
export const TaskIdSchema = z.string().uuid().transform(s => s as TaskId);
export const AutomationIdSchema = z.string().uuid().transform(s => s as AutomationId);
export const TriggerIdSchema = z.string().uuid().transform(s => s as TriggerId);
export const PeerIdSchema = z.string().uuid().transform(s => s as PeerId);
export const ContactIdSchema = z.string().uuid().transform(s => s as ContactId);
export const WorkflowIdSchema = z.string().uuid().transform(s => s as WorkflowId);
export const AttachmentIdSchema = z.string().uuid().transform(s => s as AttachmentId);
export const SessionIdSchema = z.string().uuid().transform(s => s as SessionId);
