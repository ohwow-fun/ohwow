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
  /**
   * Which ohwow capabilities the member or guide will use to execute this
   * task. Every task MUST name at least one. This is how the plan teaches
   * a new hire what ohwow does — by having them do their actual first-
   * month work through the product, not around it.
   */
  ohwow_tools?: string[];
  /** One-sentence rationale: "why this task uses ohwow vs. generic work" */
  ohwow_leverage?: string;
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

## Core philosophy — teach them ohwow BY using ohwow

OHWOW is not something the new hire learns ABOUT in week 1 and uses in week 4. The whole point of their first month is that every piece of work happens *through* ohwow. If a task could equally well be done in a Google Doc on a personal laptop, you have failed. Rewrite it so the same outcome is reached by driving one or more ohwow tools. The member should finish week 1 and already feel like a power user because they've been *using* the product to do their actual job, not reading docs about it.

Every single task in the plan MUST name at least one ohwow capability it uses, via the ohwow_tools field on the task.

## The ohwow capability cheat sheet (use these liberally)

**Research + content intake**
- \`deep_research(question, depth)\` — multi-step web research with citations, saves retrievable report
- \`scrape_url(url)\` — pull any webpage with readability mode
- \`scrape_search(query)\` — SERP search
- \`read_rss_feed(url)\`, \`youtube_transcript(url)\`, \`github_search(query)\` — targeted intel

**Knowledge base (persistent memory)**
- \`upload_knowledge(path_or_text, title)\` — add markdown/notes to the KB, gets chunked + embedded
- \`search_knowledge(query)\` — semantic + BM25 hybrid search over everything the team has uploaded
- \`get_knowledge_document(query)\` — fetch a specific doc by semantic match

**CRM + contacts**
- \`create_contact(name, email, company, tags)\` — add a lead / prospect / partner
- \`list_contacts(contact_type, status)\`, \`search_contacts(query)\`, \`update_contact\`, \`log_contact_event\`
- \`get_contact_pipeline\` — the current sales funnel view

**Agents + delegation**
- \`list_agents\` — see the current roster of AI agents in the workspace
- \`run_agent(agent_id, prompt)\` — delegate a specific task to an existing agent (e.g. a copywriter, researcher)
- \`spawn_agents(preset_ids)\` — instantiate new agents from presets (e.g. "enterprise SDR", "content drafter")
- \`get_agent_suggestions\` — ohwow recommends which agents to spin up for a given goal

**LLM organ (direct model routing)**
- \`llm(purpose, prompt)\` — direct Shape C call; purpose picks the right model (generation, critique, reasoning, planning)

**Workspace intelligence**
- \`get_workspace_stats\`, \`get_activity_feed\`, \`get_business_pulse\`, \`get_daily_reps_status\`
- \`assess_operations\` — gap analysis against where the business should be at its growth stage
- \`get_operational_pillars\` — setup pillars like lead gen, content pipeline, outbound outreach

**Automation**
- \`discover_capabilities\`, \`propose_automation\`, \`create_automation\` — build repeatable workflows
- \`create_workflow_trigger\` — schedule or event-trigger a workflow
- \`get_transition_status\` — track which tasks are moving toward full automation

**Tasks + goals**
- \`list_tasks\`, \`list_goals\`, \`create_goal\`, \`list_projects\`

**Filesystem + bash (local-first work)**
- \`local_write_file\`, \`local_read_file\`, \`local_edit_file\`, \`local_search_content\`, \`run_bash\`

**Team member profile memory (about the member themselves)**
- \`get_person_model\`, \`update_person_model\`, \`list_team_members\`, \`update_team_member\`

## Rules for the plan

1. 4-week structure, week 1 through week 4. Week 1 is "land + observe + first actual use of ohwow". Week 4 includes a concrete experiment or ownership moment the member can present.
2. Each week has a theme (2-5 words) and 2-4 tasks.
3. Every task fields:
   - title
   - description (1-2 sentences, action-oriented, names the specific ohwow capabilities involved)
   - owner ("member" for things only the human can do, "guide" for agent-assisted, or a specific named existing agent)
   - success_criteria (concrete, observable)
   - ohwow_tools: array of 1-3 ohwow capability names from the cheat sheet — REQUIRED, never empty
   - ohwow_leverage: one-sentence explanation of why using these ohwow tools is better than doing it manually
4. EVERY task must be grounded in something the member told us about themselves AND leverage at least one ohwow capability. If you can't see how an ohwow tool fits a task, cut or rewrite the task.
5. Week 1 should include at least one task that has the MEMBER personally run an ohwow tool through the chat so they experience the product immediately. Examples: scrape_url on a competitor's site, deep_research on their own industry, search_knowledge on an existing team doc.
6. Lean into their ambition and learning style. The plan is a ramp, not a test.
7. Keep task descriptions short and warm. No corporate language. No em dashes.

## Output shape (return ONLY this JSON, no prose before or after)

{
  "rationale": "2-3 sentences explaining why this shape fits this specific member, citing 2-3 things they literally said AND how ohwow's capabilities match their ambition",
  "weeks": [
    {
      "week": 1,
      "theme": "...",
      "tasks": [
        {
          "title": "...",
          "description": "...",
          "owner": "member|guide|<agent name>",
          "success_criteria": "...",
          "ohwow_tools": ["tool_name_1", "tool_name_2"],
          "ohwow_leverage": "one sentence"
        }
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
          // Show the ohwow capabilities inline so the member sees which
          // product surface each task uses. This is the "teach ohwow by
          // using ohwow" principle made visible in the chat.
          const toolHint =
            t.ohwow_tools && t.ohwow_tools.length > 0
              ? `\n  _via ohwow:_ \`${t.ohwow_tools.join('`, `')}\``
              : '';
          const leverageHint = t.ohwow_leverage ? `\n  _why:_ ${t.ohwow_leverage}` : '';
          return `- **${t.title}**${owner}\n  ${t.description}${toolHint}${leverageHint}\n  _Success:_ ${t.success_criteria}`;
        })
        .join('\n');
      return `### Week ${w.week}: ${w.theme}\n${taskLines}`;
    })
    .join('\n\n');

  return `${firstName}, here's what I think your first month at OHWOW should look like. Every task uses real ohwow capabilities, so you'll be learning the product by using it to do your actual job. Push back on anything.

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
  weeks: unknown;
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

function parseWeeks(
  rawWeeks: unknown,
): Array<PlanWeek & { tasks: Array<PlanTask & { materialized_task_id?: string | null }> }> {
  // The database adapter may return the weeks column as either a raw string
  // (SQLite JSON column) or as an already-parsed array (some adapter paths
  // auto-deserialize JSON). Accept both — the caller doesn't care which
  // layer did the parsing, only that the result is a usable array.
  if (Array.isArray(rawWeeks)) {
    return rawWeeks as Array<PlanWeek & { tasks: Array<PlanTask & { materialized_task_id?: string | null }> }>;
  }
  if (typeof rawWeeks === 'string' && rawWeeks.length > 0) {
    try {
      const parsed = JSON.parse(rawWeeks);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
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
