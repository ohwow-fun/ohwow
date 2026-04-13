/**
 * Onboarding Plan Synthesis
 *
 * propose_first_month_plan takes a team member who has gone through enough
 * person-model ingestion and produces a concrete 4-week ramp plan grounded
 * in what the COS has actually learned about them. The COS is expected to
 * call this tool INSTEAD of asking the member "what do you want to do in
 * your first month" — a new hire is the least-qualified person to answer
 * that question. A real chief of staff proposes and the member reacts.
 *
 * Current scope (Layer 1):
 *
 * - Read team_member + person_model + workspace context
 * - Send a single synthesis LLM call via the Shape C model router,
 *   purpose='planning', so the router picks a model fit for high-quality
 *   structured output
 * - Return a markdown draft the chat can render inline, plus a parsed
 *   `weeks[]` structure the caller (or a future accept tool) can turn
 *   into real tasks/goals
 * - No persistence yet. The plan is ephemeral until a follow-up
 *   `accept_onboarding_plan` tool commits it as real work items. That
 *   separation lets the member iterate on the draft without polluting
 *   the task feed.
 *
 * Guarantee: we do not ask the LLM to invent facts. The synthesis prompt
 * bakes in "ground every task in something the member literally said"
 * and we pass the raw dimensions straight through so the model can cite
 * them. If the profile is too thin (fewer than ~3 populated dimensions)
 * we refuse and tell the caller to keep the interview going.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { runLlmCall } from '../../execution/llm-organ.js';
import { logger } from '../../lib/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlanTask {
  title: string;
  description: string;
  owner: string; // "member", "guide", or a named agent
  success_criteria: string;
}

interface PlanWeek {
  week: number;
  theme: string;
  tasks: PlanTask[];
}

interface ParsedPlan {
  rationale: string;
  weeks: PlanWeek[];
  closing_question: string;
}

// ---------------------------------------------------------------------------
// Helpers — load member + person_model + workspace, assemble profile context
// ---------------------------------------------------------------------------

function parseJsonField(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Schema allows plain-text fields (e.g. learning_style) — return as-is
    return raw;
  }
}

function countFilledDimensions(pm: Record<string, unknown>): number {
  const dims = [
    'skills_map', 'tool_proficiency', 'communication_style',
    'energy_patterns', 'ambitions', 'friction_points', 'flow_triggers',
    'domain_expertise', 'learning_style', 'values_and_motivations',
    'work_history',
  ];
  let count = 0;
  for (const d of dims) {
    const v = pm[d];
    if (v == null) continue;
    if (typeof v === 'string') {
      if (v === '{}' || v === '[]' || v.trim() === '') continue;
      count++;
      continue;
    }
    if (Array.isArray(v) && v.length > 0) count++;
    else if (typeof v === 'object' && Object.keys(v as object).length > 0) count++;
  }
  return count;
}

async function loadContext(
  ctx: LocalToolContext,
  teamMemberId: string,
): Promise<
  | { ok: true; member: Record<string, unknown>; personModel: Record<string, unknown>; workspace: Record<string, unknown> | null }
  | { ok: false; error: string }
> {
  const { data: memberRow } = await ctx.db
    .from('agent_workforce_team_members')
    .select('id, name, email, role, skills, capacity_hours, timezone, phone, group_label, assigned_guide_agent_id')
    .eq('id', teamMemberId)
    .eq('workspace_id', ctx.workspaceId)
    .maybeSingle();
  if (!memberRow) return { ok: false, error: 'Team member not found in this workspace' };

  // Person model — try team_member_id FK first, fall back to name match
  // because ingestion historically didn't backfill team_member_id.
  let pmData: Record<string, unknown> | null = null;
  try {
    const { data } = await ctx.db
      .from('agent_workforce_person_models')
      .select('*')
      .eq('workspace_id', ctx.workspaceId)
      .eq('team_member_id', teamMemberId)
      .maybeSingle();
    if (data) pmData = data as Record<string, unknown>;
  } catch {
    // team_member_id column may not be indexed in older schemas; fall through
  }
  if (!pmData) {
    const { data } = await ctx.db
      .from('agent_workforce_person_models')
      .select('*')
      .eq('workspace_id', ctx.workspaceId)
      .eq('name', (memberRow as { name: string }).name)
      .maybeSingle();
    if (data) pmData = data as Record<string, unknown>;
  }
  if (!pmData) {
    return {
      ok: false,
      error:
        'No person model exists for this team member yet. Run start_person_ingestion and gather a few answers first.',
    };
  }

  const { data: ws } = await ctx.db
    .from('agent_workforce_workspaces')
    .select('id, business_name, business_type, business_description, founder_focus, growth_stage, timezone')
    .eq('id', ctx.workspaceId)
    .maybeSingle();

  return {
    ok: true,
    member: memberRow as Record<string, unknown>,
    personModel: pmData,
    workspace: (ws as Record<string, unknown>) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildSynthesisPrompt(args: {
  member: Record<string, unknown>;
  personModel: Record<string, unknown>;
  workspace: Record<string, unknown> | null;
}): { system: string; user: string } {
  const { member, personModel: pm, workspace: ws } = args;

  const profile = {
    name: member.name,
    role: member.role || null,
    timezone: member.timezone || null,
    capacity_hours_per_week: member.capacity_hours || null,
    skills_map: parseJsonField(pm.skills_map),
    tool_proficiency: parseJsonField(pm.tool_proficiency),
    domain_expertise: parseJsonField(pm.domain_expertise),
    ambitions: parseJsonField(pm.ambitions),
    communication_style: parseJsonField(pm.communication_style),
    energy_patterns: parseJsonField(pm.energy_patterns),
    learning_style: parseJsonField(pm.learning_style),
    friction_points: parseJsonField(pm.friction_points),
    flow_triggers: parseJsonField(pm.flow_triggers),
    work_history: parseJsonField(pm.work_history),
    values_and_motivations: parseJsonField(pm.values_and_motivations),
  };

  const workspaceContext = ws
    ? {
        business_name: ws.business_name || null,
        business_type: ws.business_type || null,
        business_description: ws.business_description || null,
        founder_focus: ws.founder_focus || null,
        growth_stage: ws.growth_stage || null,
      }
    : null;

  const system = `You are synthesizing a 4-week onboarding plan for a new human team member at OHWOW. You are the member's Chief of Staff agent and the plan will be shown to them directly in the chat.

Rules for the plan:

1. It must be a 4-week structure (week 1 through week 4). Week 1 is "land + observe", week 4 should include a concrete small experiment or ownership moment the member can present.
2. Each week has: theme (2-5 words), 2-4 concrete tasks, each task with a title, a short description (1-2 sentences), an owner ("member" for things only the human can do, "guide" for agent-assisted work, or a named existing agent / teammate), and a success criterion the member and guide can both see.
3. EVERY task must be grounded in something specific the member told us about themselves during intake. Do not invent expertise, tools, or ambitions they didn't mention.
4. Match the member's stated learning style, energy patterns, and communication preferences when proposing cadence, check-ins, and task size.
5. Lean into their ambition — this is a ramp, not a test. Make them feel the plan reflects what they actually want to grow into.
6. Keep task descriptions action-oriented, not corporate. Write the way a warm founder would explain the plan to a new hire in person.

Return ONLY a JSON object with this exact shape, no prose before or after:

{
  "rationale": "2-3 sentences explaining why this shape fits this specific member, citing 2-3 things they literally said",
  "weeks": [
    {
      "week": 1,
      "theme": "...",
      "tasks": [
        { "title": "...", "description": "...", "owner": "...", "success_criteria": "..." }
      ]
    }
    // weeks 2-4 same shape
  ],
  "closing_question": "Short question inviting the member to push back on anything in the plan"
}`;

  const user = `Here is everything we know about the member.

## Team member (structured)
${JSON.stringify(profile, null, 2)}

## Workspace / business context
${JSON.stringify(workspaceContext, null, 2)}

Produce the onboarding plan now.`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// Parse model output and render to markdown
// ---------------------------------------------------------------------------

function tryParsePlan(text: string): ParsedPlan | null {
  // Be forgiving about models that wrap JSON in prose or code fences.
  const trimmed = text.trim();
  const candidates: string[] = [];
  candidates.push(trimmed);

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) candidates.push(fenceMatch[1]);

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as ParsedPlan;
      if (parsed && Array.isArray(parsed.weeks) && parsed.weeks.length > 0) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function renderPlanMarkdown(memberName: string, plan: ParsedPlan): string {
  const firstName = memberName.split(/\s+/)[0] || memberName;
  const weekBlocks = plan.weeks
    .sort((a, b) => a.week - b.week)
    .map((w) => {
      const taskLines = w.tasks
        .map((t) => {
          const owner = t.owner ? ` _(${t.owner})_` : '';
          return `- **${t.title}**${owner} — ${t.description}\n  _Success:_ ${t.success_criteria}`;
        })
        .join('\n');
      return `### Week ${w.week}: ${w.theme}\n${taskLines}`;
    })
    .join('\n\n');

  return `${firstName}, here's what I think your first month at OHWOW should look like. This is a draft, grounded in what you've told me. Push back on anything.

_${plan.rationale}_

${weekBlocks}

${plan.closing_question}`;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export async function proposeFirstMonthPlan(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const teamMemberId = input.team_member_id as string | undefined;
  if (!teamMemberId) return { success: false, error: 'team_member_id is required' };
  if (!ctx.modelRouter) {
    return { success: false, error: 'Model router not available — cannot synthesize plan.' };
  }

  const loaded = await loadContext(ctx, teamMemberId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  const { member, personModel, workspace } = loaded;

  // Refuse to synthesize on a thin profile. The COS should keep interviewing
  // until we have signal across at least 3 dimensions — otherwise the plan
  // ends up generic and the whole point of grounding is lost.
  const filled = countFilledDimensions(personModel);
  if (filled < 3) {
    return {
      success: false,
      error:
        `Person model only has ${filled} populated dimensions. Need at least 3 (skills, ambitions, and communication style at minimum) before proposing a ramp plan. Ask the member a few more interview questions first.`,
    };
  }

  const { system, user } = buildSynthesisPrompt({ member, personModel, workspace });

  const llmResult = await runLlmCall(
    {
      modelRouter: ctx.modelRouter,
      db: ctx.db,
      workspaceId: ctx.workspaceId,
      currentAgentId: ctx.currentAgentId,
    },
    {
      purpose: 'planning',
      system,
      prompt: user,
      max_tokens: 2048,
      temperature: 0.4,
    } as Record<string, unknown>,
  );

  if (!llmResult.ok) {
    logger.warn({ err: llmResult.error }, '[propose_first_month_plan] llm call failed');
    return { success: false, error: `Plan synthesis failed: ${llmResult.error}` };
  }

  const plan = tryParsePlan(llmResult.data.text);
  if (!plan) {
    return {
      success: false,
      error:
        'Plan model returned text that could not be parsed as JSON. Retry, or inspect the raw output.',
      // Raw text is intentionally included so the caller can fall back to
      // showing it directly to the user even when parsing failed.
      data: { rawOutput: llmResult.data.text },
    };
  }

  const memberName = (member.name as string) || 'Team member';
  const markdown = renderPlanMarkdown(memberName, plan);

  // Persist as a draft onboarding plan (Layer 2). The accept tool will flip
  // the status later and materialize tasks/goals. Persistence failure is
  // NOT fatal — the synthesis itself already succeeded, so the chat can
  // render the plan even if the row didn't land.
  const planId = newId();
  try {
    await ctx.db.from('agent_workforce_onboarding_plans').insert({
      id: planId,
      workspace_id: ctx.workspaceId,
      team_member_id: teamMemberId,
      person_model_id: (personModel as { id?: string }).id ?? null,
      created_by_agent_id: (member as { assigned_guide_agent_id?: string }).assigned_guide_agent_id ?? null,
      status: 'draft',
      rationale: plan.rationale,
      closing_question: plan.closing_question,
      // Stamp each task with materialized_task_id=null so accept() can fill
      // them in without touching the original plan shape.
      weeks: JSON.stringify(
        plan.weeks.map((w) => ({
          ...w,
          tasks: w.tasks.map((t) => ({ ...t, materialized_task_id: null })),
        })),
      ),
      model_used: llmResult.data.model_used,
      provider: llmResult.data.provider,
      input_tokens: llmResult.data.tokens.input,
      output_tokens: llmResult.data.tokens.output,
    });
  } catch (err) {
    logger.warn({ err, teamMemberId }, '[propose_first_month_plan] draft persistence failed (non-fatal)');
  }

  return {
    success: true,
    data: {
      planId,
      teamMemberId,
      teamMemberName: memberName,
      planMarkdown: markdown,
      rationale: plan.rationale,
      weeks: plan.weeks,
      closingQuestion: plan.closing_question,
      populatedDimensions: filled,
      status: 'draft',
      modelUsed: llmResult.data.model_used,
      provider: llmResult.data.provider,
      tokensUsed: llmResult.data.tokens,
      nextStep:
        'Present this plan to the member as the assistant message. When they agree, call accept_onboarding_plan with this plan_id to materialize the tasks and goals. If they want changes, iterate the plan before accepting.',
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers shared by accept / get / list
// ---------------------------------------------------------------------------

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `op_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function newHexId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface PersistedPlanRow {
  id: string;
  workspace_id: string;
  team_member_id: string;
  person_model_id: string | null;
  created_by_agent_id: string | null;
  status: string;
  rationale: string | null;
  closing_question: string | null;
  weeks: string;
  model_used: string | null;
  provider: string | null;
  accepted_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

async function loadPlanRow(
  ctx: LocalToolContext,
  planId: string,
): Promise<PersistedPlanRow | null> {
  const { data } = await ctx.db
    .from('agent_workforce_onboarding_plans')
    .select('*')
    .eq('id', planId)
    .eq('workspace_id', ctx.workspaceId)
    .maybeSingle();
  return (data as PersistedPlanRow | null) ?? null;
}

function parseWeeks(rawWeeks: string): Array<PlanWeek & { tasks: Array<PlanTask & { materialized_task_id?: string | null }> }> {
  try {
    const parsed = JSON.parse(rawWeeks);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  return [];
}

// ---------------------------------------------------------------------------
// accept_onboarding_plan — flip status, create tasks + goals + work routing
// ---------------------------------------------------------------------------

export async function acceptOnboardingPlan(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const planId = input.plan_id as string | undefined;
  if (!planId) return { success: false, error: 'plan_id is required' };

  const row = await loadPlanRow(ctx, planId);
  if (!row) return { success: false, error: 'Onboarding plan not found in this workspace' };
  if (row.status !== 'draft') {
    return {
      success: false,
      error: `Plan is already in status "${row.status}". Only drafts can be accepted.`,
    };
  }

  // Load the target team member so we can resolve their guide agent as
  // the default task owner (tasks.agent_id is NOT NULL; any week task
  // nominally owned by the human still needs an agent row so the guide
  // shows up as the accountable party).
  const { data: memberRow } = await ctx.db
    .from('agent_workforce_team_members')
    .select('id, name, assigned_guide_agent_id')
    .eq('id', row.team_member_id)
    .eq('workspace_id', ctx.workspaceId)
    .maybeSingle();
  if (!memberRow) return { success: false, error: 'Team member for this plan no longer exists' };
  const member = memberRow as { id: string; name: string; assigned_guide_agent_id: string | null };
  const defaultAgentId = row.created_by_agent_id ?? member.assigned_guide_agent_id;
  if (!defaultAgentId) {
    return {
      success: false,
      error:
        'This team member has no guide agent assigned. Call assign_guide_agent before accepting the plan so tasks have an owner.',
    };
  }

  const weeks = parseWeeks(row.weeks);
  if (weeks.length === 0) {
    return { success: false, error: 'Plan has no weeks to materialize.' };
  }

  const now = new Date().toISOString();
  const materializedTaskIds: string[] = [];
  const createdGoalIds: string[] = [];

  // Walk each week, create a goal, and create one task per week task.
  // Member-owned tasks also get a work_routing_decisions row so the
  // human-assignment is visible to routing / load-balancing logic.
  for (const week of weeks) {
    // One goal per week keyed on theme
    const goalId = newId();
    try {
      await ctx.db.from('agent_workforce_goals').insert({
        id: goalId,
        workspace_id: ctx.workspaceId,
        title: `${member.name} ramp — Week ${week.week}: ${week.theme}`,
        description: `Week ${week.week} of ${member.name}'s first-month onboarding plan. Theme: ${week.theme}.`,
        status: 'active',
        priority: 'normal',
        color: '#6366f1',
        position: week.week,
      });
      createdGoalIds.push(goalId);
    } catch (err) {
      logger.warn({ err, week: week.week }, '[accept_onboarding_plan] goal insert failed');
      continue;
    }

    for (const task of week.tasks) {
      const taskId = newHexId();
      const ownerLabel = (task.owner || 'guide').toLowerCase();
      const isHumanOwned = ownerLabel === 'member' || ownerLabel === (member.name || '').toLowerCase();
      try {
        await ctx.db.from('agent_workforce_tasks').insert({
          id: taskId,
          workspace_id: ctx.workspaceId,
          agent_id: defaultAgentId,
          title: task.title,
          description: `${task.description}\n\nSuccess: ${task.success_criteria}\n\nOwner: ${task.owner}`,
          status: 'pending',
          priority: 'normal',
          goal_id: goalId,
          assignee_type: isHumanOwned ? 'person' : 'agent',
          assigned_to: isHumanOwned ? member.id : defaultAgentId,
          assigned_by: defaultAgentId,
          assigned_at: now,
          metadata: JSON.stringify({
            onboarding_plan_id: planId,
            onboarding_week: week.week,
            onboarding_theme: week.theme,
            owner_label: task.owner,
            success_criteria: task.success_criteria,
          }),
          source_type: 'onboarding_plan',
        });
        materializedTaskIds.push(taskId);
      } catch (err) {
        logger.warn({ err, taskId }, '[accept_onboarding_plan] task insert failed');
        continue;
      }

      // work_routing_decisions row for human-owned tasks. This keeps the
      // router aware that a human is the owner even though tasks.agent_id
      // still points at the guide.
      if (isHumanOwned) {
        try {
          await ctx.db.from('work_routing_decisions').insert({
            id: newId(),
            workspace_id: ctx.workspaceId,
            task_id: taskId,
            task_title: task.title,
            task_urgency: 'normal',
            required_skills: JSON.stringify([]),
            assigned_to_type: 'person',
            assigned_to_id: member.id,
            assignment_method: 'manual',
            confidence_score: 0.9,
            score_breakdown: JSON.stringify({ onboarding_plan: 1.0 }),
          });
        } catch (err) {
          logger.warn({ err, taskId }, '[accept_onboarding_plan] work_routing_decisions insert failed');
        }
      }
    }
  }

  // Flip the plan row and stamp materialized_task_ids back into weeks[].
  // We read the weeks, attach the ids by order, and write back. Ordering
  // relies on task-loop iteration being stable, which it is in SQLite
  // reads + our JS loops.
  try {
    let cursor = 0;
    const updatedWeeks = weeks.map((week) => ({
      ...week,
      tasks: week.tasks.map((t) => {
        const idForThisTask = materializedTaskIds[cursor];
        cursor++;
        return { ...t, materialized_task_id: idForThisTask ?? null };
      }),
    }));
    await ctx.db
      .from('agent_workforce_onboarding_plans')
      .update({
        status: 'accepted',
        accepted_at: now,
        updated_at: now,
        weeks: JSON.stringify(updatedWeeks),
      })
      .eq('id', planId);
  } catch (err) {
    logger.warn({ err, planId }, '[accept_onboarding_plan] status flip failed');
  }

  // Activity feed event so the dashboard sees the accept moment
  try {
    await ctx.db.rpc('create_agent_activity', {
      p_workspace_id: ctx.workspaceId,
      p_activity_type: 'onboarding_plan_accepted',
      p_title: `${member.name} accepted their onboarding plan`,
      p_description: `${materializedTaskIds.length} tasks across ${weeks.length} weeks, ${createdGoalIds.length} goals created.`,
    });
  } catch {
    // non-fatal
  }

  return {
    success: true,
    data: {
      message: `Plan accepted. Materialized ${materializedTaskIds.length} tasks across ${weeks.length} weeks and created ${createdGoalIds.length} goals. ${member.name} will see the full checklist on their dashboard.`,
      planId,
      teamMemberId: member.id,
      tasksCreated: materializedTaskIds.length,
      goalsCreated: createdGoalIds.length,
    },
  };
}

// ---------------------------------------------------------------------------
// get_onboarding_plan — read current state, used for display + debugging
// ---------------------------------------------------------------------------

export async function getOnboardingPlan(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const planId = input.plan_id as string | undefined;
  const teamMemberId = input.team_member_id as string | undefined;

  let row: PersistedPlanRow | null = null;
  if (planId) {
    row = await loadPlanRow(ctx, planId);
  } else if (teamMemberId) {
    const { data } = await ctx.db
      .from('agent_workforce_onboarding_plans')
      .select('*')
      .eq('workspace_id', ctx.workspaceId)
      .eq('team_member_id', teamMemberId)
      .order('created_at', { ascending: false })
      .limit(1);
    const rows = (data as PersistedPlanRow[] | null) ?? [];
    row = rows[0] ?? null;
  } else {
    return { success: false, error: 'plan_id or team_member_id is required' };
  }
  if (!row) return { success: false, error: 'No onboarding plan found' };

  return {
    success: true,
    data: {
      planId: row.id,
      teamMemberId: row.team_member_id,
      status: row.status,
      rationale: row.rationale,
      closingQuestion: row.closing_question,
      weeks: parseWeeks(row.weeks),
      modelUsed: row.model_used,
      provider: row.provider,
      createdAt: row.created_at,
      acceptedAt: row.accepted_at,
      completedAt: row.completed_at,
    },
  };
}

// ---------------------------------------------------------------------------
// list_onboarding_plans — all plans in the workspace, newest first
// ---------------------------------------------------------------------------

export async function listOnboardingPlans(
  ctx: LocalToolContext,
  _input: Record<string, unknown>,
): Promise<ToolResult> {
  const { data, error } = await ctx.db
    .from('agent_workforce_onboarding_plans')
    .select('id, team_member_id, status, rationale, model_used, created_at, accepted_at, completed_at')
    .eq('workspace_id', ctx.workspaceId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return { success: false, error: error.message };
  return { success: true, data: (data as Array<Record<string, unknown>>) ?? [] };
}
