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
 * Cloud sync for team_member rows happens via the shared
 * `syncResource` dispatcher. The cloud agent_workforce_team_members
 * table needs the row so an invited member can authenticate, find
 * their guide agent, and have their COS-voiced briefing render.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { logger } from '../../lib/logger.js';
import { syncResource, hexToUuid } from '../../control-plane/sync-resources.js';
import { DEFAULT_AGENT_TOOLS } from '../../tui/data/agent-presets.js';
import { activateConversationPersona } from '../conversation-persona.js';

export const TEAM_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'create_team_member',
    description: 'Add a new human team member to the workspace. Use this when the user says "X is joining the team" or "hire Y" or "onboard Z". Returns the new member record; follow up with assign_guide_agent and start_person_ingestion to run the full onboarding flow.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Full name (required)' },
        email: { type: 'string', description: 'Email address' },
        role: { type: 'string', description: 'Role or job title (e.g. "Growth Lead")' },
        timezone: { type: 'string', description: 'IANA timezone like America/Los_Angeles' },
        phone: { type: 'string', description: 'Phone (optional)' },
        group_label: { type: 'string', description: 'Free-form team label: "engineering", "gtm", etc.' },
        capacity_hours: { type: 'number', description: 'Weekly capacity in hours' },
        skills: { type: 'array', items: { type: 'string' }, description: 'List of skill tags' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_team_members',
    description: 'List all human team members in the workspace with their guide agent, onboarding status, and invite status.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'update_team_member',
    description: 'Edit an existing team member record. Pass only the fields you want to change.',
    input_schema: {
      type: 'object' as const,
      properties: {
        team_member_id: { type: 'string', description: 'Team member id (from create_team_member or list_team_members)' },
        name: { type: 'string' },
        email: { type: 'string' },
        role: { type: 'string' },
        timezone: { type: 'string' },
        phone: { type: 'string' },
        group_label: { type: 'string' },
        capacity_hours: { type: 'number' },
        skills: { type: 'array', items: { type: 'string' } },
        onboarding_status: { type: 'string', description: 'not_started | in_progress | ready | active' },
      },
      required: ['team_member_id'],
    },
  },
  {
    name: 'assign_guide_agent',
    description: 'Assign a dedicated "chief of staff" guide agent to a team member. If agent_id is omitted, a new Chief of Staff agent is auto-spawned for them. The guide becomes the member\'s always-on AI partner.',
    input_schema: {
      type: 'object' as const,
      properties: {
        team_member_id: { type: 'string', description: 'Team member id' },
        agent_id: { type: 'string', description: 'Optional: pick an existing agent instead of spawning one' },
      },
      required: ['team_member_id'],
    },
  },
  {
    name: 'draft_cloud_invite',
    description: 'Draft (do NOT send yet) a cloud dashboard invite email for a team member. Returns a preview email body the founder can review before calling send_cloud_invite. Use this when the founder wants to review before sending.',
    input_schema: {
      type: 'object' as const,
      properties: {
        team_member_id: { type: 'string', description: 'Team member id' },
        role: { type: 'string', description: 'Cloud role: admin, member, viewer. Default: member.' },
      },
      required: ['team_member_id'],
    },
  },
  {
    name: 'send_cloud_invite',
    description: 'Actually send a cloud dashboard invite to a team member via email. Creates a workspace_invites row on the cloud, sends the invite email, and stores the token on the local team_members row so we can track acceptance. The member will receive a real email with a 7-day invite link. Use this when the founder says something like "send the invite", "invite them", or "send mario the link" — it replaces the draft-only flow.',
    input_schema: {
      type: 'object' as const,
      properties: {
        team_member_id: { type: 'string', description: 'Team member id' },
        role: { type: 'string', description: 'Cloud role: admin, member, viewer. Default: member.' },
      },
      required: ['team_member_id'],
    },
  },
  {
    name: 'list_member_tasks',
    description: 'List work routed to a specific human team member via the work router.',
    input_schema: {
      type: 'object' as const,
      properties: {
        team_member_id: { type: 'string', description: 'Team member id' },
      },
      required: ['team_member_id'],
    },
  },
];

/** Convert a local team_members row into the payload shape the cloud expects. */
export function teamMemberSyncPayload(row: Record<string, unknown>): Record<string, unknown> & { id: string } {
  const id = hexToUuid(row.id as string);
  let skills: unknown = [];
  if (typeof row.skills === 'string') {
    try {
      skills = JSON.parse(row.skills);
    } catch {
      skills = [];
    }
  } else if (Array.isArray(row.skills)) {
    skills = row.skills;
  }
  const guideAgentId = row.assigned_guide_agent_id;
  return {
    id,
    name: row.name,
    email: row.email ?? null,
    role: row.role ?? null,
    skills,
    capacity: row.capacity_hours ?? null,
    timezone: row.timezone ?? null,
    phone: row.phone ?? null,
    group_label: row.group_label ?? null,
    avatar_url: row.avatar_url ?? null,
    // Cloud expects dashed uuid for the FK as well.
    assigned_guide_agent_id: typeof guideAgentId === 'string' && guideAgentId ? hexToUuid(guideAgentId) : null,
    cloud_invite_token: row.cloud_invite_token ?? null,
    cloud_invite_status: row.cloud_invite_status ?? null,
    onboarding_status: row.onboarding_status ?? 'not_started',
  };
}

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
  if (loaded) {
    void syncResource(ctx, 'team_member', 'upsert', teamMemberSyncPayload(loaded));
  }
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
  if (refreshed) {
    void syncResource(ctx, 'team_member', 'upsert', teamMemberSyncPayload(refreshed));
  }
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

  // Sync the refreshed row upstream so the cloud chat route can see
  // assigned_guide_agent_id when the member next opens their chat.
  const refreshedForSync = await loadTeamMember(ctx, teamMemberId);
  if (refreshedForSync) {
    void syncResource(ctx, 'team_member', 'upsert', teamMemberSyncPayload(refreshedForSync));
  }

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

// ---------------------------------------------------------------------------
// send_cloud_invite — actually POST the invite to the cloud
// ---------------------------------------------------------------------------

export async function sendCloudInvite(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const teamMemberId = input.team_member_id as string | undefined;
  if (!teamMemberId) return { success: false, error: 'team_member_id is required' };
  if (!ctx.controlPlane) {
    return {
      success: false,
      error: 'No control plane connection. The local daemon is not connected to the cloud.',
    };
  }

  const member = await loadTeamMember(ctx, teamMemberId);
  if (!member) return { success: false, error: 'Team member not found in this workspace' };
  if (!member.email) {
    return {
      success: false,
      error: 'Team member has no email on file. Update the member first with update_team_member.',
    };
  }

  const role = (input.role as string | undefined) || 'member';
  if (!['admin', 'member', 'viewer'].includes(role)) {
    return { success: false, error: 'role must be one of: admin, member, viewer' };
  }

  const result = await ctx.controlPlane.proxyCloudPost('/api/local-runtime/invite-team-member', {
    email: member.email,
    role,
    memberName: member.name,
  });

  if (!result.ok) {
    return {
      success: false,
      error: `Cloud invite failed: ${result.error ?? 'unknown error'}. The local record is unchanged.`,
    };
  }

  const cloudData = (result.data as { invite?: { token?: string }; inviteAcceptUrl?: string } | undefined) ?? {};
  const inviteToken = cloudData.invite?.token ?? null;
  const acceptUrl = cloudData.inviteAcceptUrl ?? null;

  await ctx.db
    .from('agent_workforce_team_members')
    .update({
      cloud_invite_status: 'sent',
      cloud_invite_token: inviteToken,
      updated_at: new Date().toISOString(),
    })
    .eq('id', teamMemberId)
    .eq('workspace_id', ctx.workspaceId);

  // Reflect the new invite state upstream so the cloud team_member row
  // is aware of the pending invitation. (Independent of the
  // workspace_invites row the cloud route already created.)
  const refreshedAfterInvite = await loadTeamMember(ctx, teamMemberId);
  if (refreshedAfterInvite) {
    void syncResource(ctx, 'team_member', 'upsert', teamMemberSyncPayload(refreshedAfterInvite));
  }

  try {
    await ctx.db.rpc('create_agent_activity', {
      p_workspace_id: ctx.workspaceId,
      p_activity_type: 'team_member_invited',
      p_title: `Invited ${member.name} to the workspace`,
      p_description: `Role: ${role}. Invite email sent to ${member.email}.`,
    });
  } catch (err) {
    logger.debug({ err }, '[team] activity log failed (non-fatal)');
  }

  return {
    success: true,
    data: {
      message: `Invite sent to ${member.email}. They'll get an email with a link to join the workspace as ${role}.`,
      teamMemberId,
      email: member.email,
      role,
      inviteToken,
      acceptUrl,
      expiresInDays: 7,
      nextStep:
        'Once they accept and log in, their chat session on the cloud dashboard will auto-scope to their assigned guide agent. You can mention this to the founder so they know what to expect.',
    },
  };
}

// ---------------------------------------------------------------------------
// draft_cloud_invite — preview-only, no actual send
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
