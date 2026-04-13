/**
 * Conversation persona tools.
 *
 * These let the orchestrator install or remove an "active persona" on the
 * current chat session. When a persona is active, subsequent turns in
 * the same session run under that agent's system_prompt + model_policy
 * instead of the generic orchestrator voice.
 *
 * Use cases this unlocks:
 *
 * - A team member's assigned guide / Chief of Staff actually drives
 *   their onboarding thread.
 * - A specialist sales agent takes over a lead qualification thread.
 * - A support agent takes over an incident thread.
 * - Recursive hand-off: a persona agent can activate a sub-persona if
 *   the thread needs deeper specialization.
 *
 * The orchestrator is expected to call `activate_guide_persona` right
 * after assigning a guide to a team member — or the caller can be more
 * explicit with `activate_persona` when they already know the agent id.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import {
  activateConversationPersona,
  deactivateConversationPersona,
  loadConversationPersona,
} from '../conversation-persona.js';

// ---------------------------------------------------------------------------
// activate_guide_persona — look up the member's assigned guide agent and
// install it as the active persona on the current conversation.
// ---------------------------------------------------------------------------

export async function activateGuidePersona(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const teamMemberId = input.team_member_id as string | undefined;
  if (!teamMemberId) return { success: false, error: 'team_member_id is required' };
  if (!ctx.sessionId) {
    return {
      success: false,
      error: 'No active chat session — activate_guide_persona is only usable from a chat turn',
    };
  }

  const { data: member } = await ctx.db
    .from('agent_workforce_team_members')
    .select('id, name, assigned_guide_agent_id')
    .eq('id', teamMemberId)
    .eq('workspace_id', ctx.workspaceId)
    .maybeSingle();
  if (!member) return { success: false, error: 'Team member not found in this workspace' };
  const memberRow = member as { id: string; name: string; assigned_guide_agent_id: string | null };
  if (!memberRow.assigned_guide_agent_id) {
    return {
      success: false,
      error:
        `${memberRow.name} has no assigned guide agent yet. Call assign_guide_agent first.`,
    };
  }

  const { data: agent } = await ctx.db
    .from('agent_workforce_agents')
    .select('id, name, role')
    .eq('id', memberRow.assigned_guide_agent_id)
    .eq('workspace_id', ctx.workspaceId)
    .maybeSingle();
  if (!agent) {
    return {
      success: false,
      error: 'Assigned guide agent not found in this workspace',
    };
  }
  const agentRow = agent as { id: string; name: string; role: string | null };

  await activateConversationPersona(ctx.db, ctx.sessionId, agentRow.id);

  return {
    success: true,
    data: {
      message:
        `${agentRow.name} is now driving this conversation as ${memberRow.name}'s guide. From the next turn on, the reply will use that agent's voice, prompt, and model.`,
      teamMemberId: memberRow.id,
      teamMemberName: memberRow.name,
      agentId: agentRow.id,
      agentName: agentRow.name,
      agentRole: agentRow.role,
    },
  };
}

// ---------------------------------------------------------------------------
// activate_persona — install any agent in this workspace as persona,
// without requiring a team_member. Useful for sales/support takeovers.
// ---------------------------------------------------------------------------

export async function activatePersona(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const agentId = input.agent_id as string | undefined;
  if (!agentId) return { success: false, error: 'agent_id is required' };
  if (!ctx.sessionId) {
    return { success: false, error: 'No active chat session' };
  }

  const { data: agent } = await ctx.db
    .from('agent_workforce_agents')
    .select('id, name, role')
    .eq('id', agentId)
    .eq('workspace_id', ctx.workspaceId)
    .maybeSingle();
  if (!agent) return { success: false, error: 'Agent not found in this workspace' };
  const agentRow = agent as { id: string; name: string; role: string | null };

  await activateConversationPersona(ctx.db, ctx.sessionId, agentRow.id);
  return {
    success: true,
    data: {
      message: `${agentRow.name} is now driving this conversation.`,
      agentId: agentRow.id,
      agentName: agentRow.name,
      agentRole: agentRow.role,
    },
  };
}

// ---------------------------------------------------------------------------
// deactivate_persona — return control to the orchestrator for this session.
// ---------------------------------------------------------------------------

export async function deactivatePersona(
  ctx: LocalToolContext,
  _input: Record<string, unknown>,
): Promise<ToolResult> {
  if (!ctx.sessionId) {
    return { success: false, error: 'No active chat session' };
  }
  await deactivateConversationPersona(ctx.db, ctx.sessionId);
  return { success: true, data: { message: 'Persona cleared. Orchestrator is driving again.' } };
}

// ---------------------------------------------------------------------------
// get_active_persona — read current persona state, useful for debugging.
// ---------------------------------------------------------------------------

export async function getActivePersona(
  ctx: LocalToolContext,
  _input: Record<string, unknown>,
): Promise<ToolResult> {
  if (!ctx.sessionId) {
    return { success: false, error: 'No active chat session' };
  }
  const persona = await loadConversationPersona(ctx.db, ctx.workspaceId, ctx.sessionId);
  if (!persona) {
    return { success: true, data: { active: false } };
  }
  return {
    success: true,
    data: {
      active: true,
      agentId: persona.agentId,
      name: persona.name,
      role: persona.role,
      model: persona.modelDefault,
    },
  };
}
