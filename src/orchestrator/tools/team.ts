/**
 * Team Orchestrator Tools
 *
 * Human team-member management. Distinct from contacts (CRM) and agents (AI):
 * a team member is a real person who collaborates with the workspace owner,
 * has skills and a timezone, optionally gets a dedicated "chief of staff"
 * guide agent, and can be onboarded via the existing person-model ingestion
 * flow.
 *
 * These tools were added so onboarding a new hire (e.g. "Mario Gonzalez is
 * joining as X") can be driven through a single orchestrator chat instead of
 * manual SQL + UI clicks. The flow the orchestrator composes is:
 *
 *   create_team_member → assign_guide_agent (auto-spawns a Chief of Staff if
 *   none exists) → start_person_ingestion(variant='team_member') → the model
 *   walks the member through the interview → update_person_model on each
 *   answer → optionally draft_cloud_invite when the member is ready for
 *   dashboard access.
 *
 * Cloud sync for team_member rows is intentionally deferred — the cloud
 * sync-resource endpoint only knows about contacts + knowledge docs today.
 * When the cloud route learns team_member we will wire it here the same way
 * as syncContactUpstream in crm.ts.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { logger } from '../../lib/logger.js';
import { DEFAULT_AGENT_TOOLS } from '../../tui/data/agent-presets.js';
import { activateConversationPersona } from '../conversation-persona.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newHexId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function loadTeamMember(
  ctx: LocalToolContext,
  teamMemberId: string,
): Promise<Record<string, unknown> | null> {
  const { data } = await ctx.db
    .from('agent_workforce_team_members')
    .select(
      'id, workspace_id, name, email, role, skills, capacity_hours, timezone, phone, group_label, assigned_guide_agent_id, cloud_invite_status, onboarding_status, created_at',
    )
    .eq('id', teamMemberId)
    .eq('workspace_id', ctx.workspaceId)
    .maybeSingle();
  return data as Record<string, unknown> | null;
}

function serializeMember(row: Record<string, unknown>): Record<string, unknown> {
  const skillsRaw = row.skills;
  let skills: unknown = [];
  if (typeof skillsRaw === 'string' && skillsRaw.length > 0) {
    try {
      skills = JSON.parse(skillsRaw);
    } catch {
      skills = [];
    }
  } else if (Array.isArray(skillsRaw)) {
    skills = skillsRaw;
  }

  return {
    id: row.id,
    name: row.name,
    email: row.email ?? null,
    role: row.role ?? null,
    skills,
    capacityHours: row.capacity_hours ?? null,
    timezone: row.timezone ?? null,
    phone: row.phone ?? null,
    groupLabel: row.group_label ?? null,
    guideAgentId: row.assigned_guide_agent_id ?? null,
    cloudInviteStatus: row.cloud_invite_status ?? null,
    onboardingStatus: row.onboarding_status ?? 'not_started',
    createdAt: row.created_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// create_team_member
// ---------------------------------------------------------------------------

export async function createTeamMember(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const name = (input.name as string | undefined)?.trim();
  if (!name) return { success: false, error: 'name is required' };

  const email = (input.email as string | undefined)?.trim() || null;
  const role = (input.role as string | undefined)?.trim() || null;
  const timezone = (input.timezone as string | undefined)?.trim() || null;
  const phone = (input.phone as string | undefined)?.trim() || null;
  const groupLabel = (input.group_label as string | undefined)?.trim() || null;
  const capacityHours = typeof input.capacity_hours === 'number' ? input.capacity_hours : null;
  const skills = Array.isArray(input.skills) ? (input.skills as unknown[]) : [];

  // Duplicate guard: same name within the workspace is almost always a
  // re-run, not a real second person. Return the existing row instead of
  // silently creating a dupe that will confuse downstream ingestion.
  const { data: existingByName } = await ctx.db
    .from('agent_workforce_team_members')
    .select('id, name')
    .eq('workspace_id', ctx.workspaceId)
    .eq('name', name)
    .maybeSingle();

  if (existingByName) {
    const existingId = (existingByName as { id: string }).id;
    logger.info({ id: existingId, name }, '[team] create_team_member returning existing row');
    const member = await loadTeamMember(ctx, existingId);
    return {
      success: true,
      data: {
        message: `${name} already exists in the team. Returning existing record.`,
        alreadyExisted: true,
        member: member ? serializeMember(member) : { id: existingId, name },
      },
    };
  }

  const id = newHexId();
  const now = new Date().toISOString();
  const { error } = await ctx.db.from('agent_workforce_team_members').insert({
    id,
    workspace_id: ctx.workspaceId,
    name,
    email,
    role,
    skills: JSON.stringify(skills),
    capacity_hours: capacityHours,
    timezone,
    phone,
    group_label: groupLabel,
    onboarding_status: 'not_started',
    created_at: now,
    updated_at: now,
  });

  if (error) return { success: false, error: error.message };

  try {
    await ctx.db.rpc('create_agent_activity', {
      p_workspace_id: ctx.workspaceId,
      p_activity_type: 'team_member_created',
      p_title: `Added team member: ${name}`,
      p_description: role ? `Role: ${role}` : undefined,
    });
  } catch (err) {
    logger.debug({ err }, '[team] activity log failed (non-fatal)');
  }

  const loaded = await loadTeamMember(ctx, id);
  return {
    success: true,
    data: {
      message: `Added ${name} to the team.`,
      member: loaded ? serializeMember(loaded) : { id, name },
      nextStep:
        'Call assign_guide_agent to give them a chief-of-staff, then start_person_ingestion to run the intake interview.',
    },
  };
}

// ---------------------------------------------------------------------------
// list_team_members
// ---------------------------------------------------------------------------

export async function listTeamMembers(
  ctx: LocalToolContext,
  _input: Record<string, unknown>,
): Promise<ToolResult> {
  const { data, error } = await ctx.db
    .from('agent_workforce_team_members')
    .select(
      'id, workspace_id, name, email, role, skills, capacity_hours, timezone, phone, group_label, assigned_guide_agent_id, cloud_invite_status, onboarding_status, created_at',
    )
    .eq('workspace_id', ctx.workspaceId)
    .order('created_at', { ascending: false });

  if (error) return { success: false, error: error.message };
  const rows = (data || []) as Array<Record<string, unknown>>;
  return { success: true, data: rows.map(serializeMember) };
}

// ---------------------------------------------------------------------------
// update_team_member
// ---------------------------------------------------------------------------

export async function updateTeamMember(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const teamMemberId = input.team_member_id as string | undefined;
  if (!teamMemberId) return { success: false, error: 'team_member_id is required' };

  const existing = await loadTeamMember(ctx, teamMemberId);
  if (!existing) return { success: false, error: 'Team member not found in this workspace' };

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.email !== undefined) updates.email = input.email;
  if (input.role !== undefined) updates.role = input.role;
  if (input.timezone !== undefined) updates.timezone = input.timezone;
  if (input.phone !== undefined) updates.phone = input.phone;
  if (input.group_label !== undefined) updates.group_label = input.group_label;
  if (input.capacity_hours !== undefined) updates.capacity_hours = input.capacity_hours;
  if (input.onboarding_status !== undefined) updates.onboarding_status = input.onboarding_status;
  if (Array.isArray(input.skills)) updates.skills = JSON.stringify(input.skills);

  const { error } = await ctx.db
    .from('agent_workforce_team_members')
    .update(updates)
    .eq('id', teamMemberId)
    .eq('workspace_id', ctx.workspaceId);
  if (error) return { success: false, error: error.message };

  const refreshed = await loadTeamMember(ctx, teamMemberId);
  return {
    success: true,
    data: {
      message: `Updated ${(existing.name as string) || 'team member'}.`,
      member: refreshed ? serializeMember(refreshed) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// assign_guide_agent
// ---------------------------------------------------------------------------

const CHIEF_OF_STAFF_ROLE = 'Chief of Staff';
const CHIEF_OF_STAFF_SYSTEM_PROMPT = `You are a chief-of-staff agent for a specific team member at OHWOW. Your job is to be their always-on guide:

- Run structured intake when they first join (background, skills, availability, tools, calendar preferences)
- Curate a reading list from the knowledge base for their role
- Draft their 30/60/90 day plan and keep it updated
- Accumulate observations about how they work (energy patterns, friction points, flow triggers) via the person model
- Relay relevant activity feed events and introduce them to people they should meet
- Surface blockers to the founder before they become problems

Stay warm and direct. Keep private notes in the person model, not in public activity logs. Always check get_person_model before answering questions about your assigned member.`;

async function ensureChiefOfStaffAgent(
  ctx: LocalToolContext,
  teamMemberName: string,
): Promise<{ id: string; created: boolean }> {
  // Reuse an existing Chief of Staff dedicated to this member first.
  const { data: existingForMember } = await ctx.db
    .from('agent_workforce_agents')
    .select('id')
    .eq('workspace_id', ctx.workspaceId)
    .eq('role', CHIEF_OF_STAFF_ROLE)
    .eq('name', `Chief of Staff — ${teamMemberName}`)
    .maybeSingle();
  if (existingForMember) {
    return { id: (existingForMember as { id: string }).id, created: false };
  }

  const id = newHexId();
  await ctx.db.from('agent_workforce_agents').insert({
    id,
    workspace_id: ctx.workspaceId,
    name: `Chief of Staff — ${teamMemberName}`,
    role: CHIEF_OF_STAFF_ROLE,
    description: `Dedicated guide agent for ${teamMemberName}.`,
    system_prompt: CHIEF_OF_STAFF_SYSTEM_PROMPT,
    // Shape C: policy holds the default model; the router picks at call time.
    config: JSON.stringify({
      model_policy: { default: 'google/gemini-2.5-flash' },
      temperature: 0.5,
      max_tokens: 4096,
      tools_enabled: DEFAULT_AGENT_TOOLS,
      approval_required: false,
      web_search_enabled: true,
    }),
    status: 'idle',
    stats: JSON.stringify({
      total_tasks: 0,
      completed_tasks: 0,
      failed_tasks: 0,
      tokens_used: 0,
      cost_cents: 0,
    }),
    is_preset: 0,
    memory_document: '',
    memory_token_count: 0,
  });

  try {
    await ctx.db.rpc('create_agent_activity', {
      p_workspace_id: ctx.workspaceId,
      p_activity_type: 'agent_created',
      p_title: `Spawned Chief of Staff for ${teamMemberName}`,
      p_description: CHIEF_OF_STAFF_ROLE,
    });
  } catch {
    // activity log failures are non-fatal
  }

  return { id, created: true };
}

export async function assignGuideAgent(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const teamMemberId = input.team_member_id as string | undefined;
  if (!teamMemberId) return { success: false, error: 'team_member_id is required' };

  const member = await loadTeamMember(ctx, teamMemberId);
  if (!member) return { success: false, error: 'Team member not found in this workspace' };

  let agentId = input.agent_id as string | undefined;
  let spawned = false;

  if (agentId) {
    // Explicit agent chosen: verify it belongs to this workspace.
    const { data: agent } = await ctx.db
      .from('agent_workforce_agents')
      .select('id, name')
      .eq('id', agentId)
      .eq('workspace_id', ctx.workspaceId)
      .maybeSingle();
    if (!agent) return { success: false, error: 'agent_id not found in this workspace' };
  } else {
    const ensured = await ensureChiefOfStaffAgent(ctx, member.name as string);
    agentId = ensured.id;
    spawned = ensured.created;
  }

  await ctx.db
    .from('agent_workforce_team_members')
    .update({ assigned_guide_agent_id: agentId, updated_at: new Date().toISOString() })
    .eq('id', teamMemberId)
    .eq('workspace_id', ctx.workspaceId);

  // Auto-install this agent as the active persona for the current chat
  // session so the very next reply comes back in the guide's voice. Callers
  // that don't want the takeover can pass `activate_for_session: false`.
  const activateForSession = input.activate_for_session !== false;
  let personaActivated = false;
  if (activateForSession && ctx.sessionId) {
    try {
      await activateConversationPersona(ctx.db, ctx.sessionId, agentId);
      personaActivated = true;
    } catch (err) {
      logger.warn({ err }, '[team] persona auto-activation failed (non-fatal)');
    }
  }

  return {
    success: true,
    data: {
      message: spawned
        ? `Spawned a new Chief of Staff agent for ${member.name} and assigned them as guide.${personaActivated ? ' They are now driving this conversation.' : ''}`
        : `Assigned guide agent to ${member.name}.${personaActivated ? ' They are now driving this conversation.' : ''}`,
      teamMemberId,
      guideAgentId: agentId,
      spawned,
      personaActivated,
    },
  };
}

// ---------------------------------------------------------------------------
// draft_cloud_invite — stores a pending invite without actually sending yet
// ---------------------------------------------------------------------------

export async function draftCloudInvite(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const teamMemberId = input.team_member_id as string | undefined;
  if (!teamMemberId) return { success: false, error: 'team_member_id is required' };

  const member = await loadTeamMember(ctx, teamMemberId);
  if (!member) return { success: false, error: 'Team member not found in this workspace' };
  if (!member.email) {
    return {
      success: false,
      error: 'Team member has no email on file. Update the member first with an email address.',
    };
  }

  const role = (input.role as string | undefined) || 'member';
  if (!['admin', 'member', 'viewer'].includes(role)) {
    return { success: false, error: 'role must be one of: admin, member, viewer' };
  }

  // We don't actually send the invite yet — draft-first is the approved
  // policy during launch week. Mark the member as having a pending draft so
  // the chat surface can show a confirmation step.
  await ctx.db
    .from('agent_workforce_team_members')
    .update({
      cloud_invite_status: 'drafted',
      updated_at: new Date().toISOString(),
    })
    .eq('id', teamMemberId)
    .eq('workspace_id', ctx.workspaceId);

  const subject = `Welcome to OHWOW, ${(member.name as string).split(' ')[0]}`;
  const body = [
    `Hi ${(member.name as string).split(' ')[0]},`,
    '',
    `You've been invited to join our OHWOW workspace as ${role}. OHWOW is our local-first AI business OS — once you accept, you'll get a dedicated guide agent that already knows who you are, what you're joining to do, and how to help you ramp.`,
    '',
    'Click the link below to accept and set your login. The link expires in 7 days.',
    '',
    '[accept invite link will go here once sent]',
    '',
    'See you inside,',
    'The OHWOW team',
  ].join('\n');

  return {
    success: true,
    data: {
      message: `Drafted a cloud invite for ${member.name}. Review the draft and call send_cloud_invite when ready.`,
      teamMemberId,
      draft: {
        to: member.email,
        subject,
        body,
        role,
        cloudWorkspaceId: ctx.workspaceId,
      },
      sendInstructions:
        'Draft-only during launch week. A future send_cloud_invite tool will hit /api/workspaces/:id/invite on the cloud. For now, have the founder paste the draft body into a real email and accept the invite manually.',
    },
  };
}

// ---------------------------------------------------------------------------
// list_member_tasks — tasks routed to this human via work_routing_decisions
// ---------------------------------------------------------------------------

export async function listMemberTasks(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const teamMemberId = input.team_member_id as string | undefined;
  if (!teamMemberId) return { success: false, error: 'team_member_id is required' };

  const { data, error } = await ctx.db
    .from('work_routing_decisions')
    .select('id, task_id, confidence_score, required_skills, outcome, created_at')
    .eq('workspace_id', ctx.workspaceId)
    .eq('assigned_to_type', 'person')
    .eq('assigned_to_id', teamMemberId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return { success: false, error: error.message };
  return { success: true, data: data || [] };
}
