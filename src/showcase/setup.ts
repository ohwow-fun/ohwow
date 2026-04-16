/**
 * Showcase setup writer.
 *
 * Turns a `ShowcasePlan` into real DB rows: a Contact, a Project, a Goal,
 * and a tailored Agent, all linked to the resolved workspace. Uses the same
 * DatabaseAdapter pattern the rest of the runtime uses — no raw SQL.
 *
 * Never hardcode `WHERE id='local'` (see ohwow/CLAUDE.md) — we resolve the
 * workspace row positionally so this works in both local-only and cloud
 * workspaces.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { DEFAULT_AGENT_TOOLS } from '../tui/data/agent-presets.js';
import type { ShowcaseOutcome, ShowcasePlan, ShowcaseResult, ShowcaseTarget } from './types.js';

function hexId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolve the workspace row id for the active workspace. Reads positionally
 * with LIMIT 1 — after cloud consolidation the seed row's id is rewritten
 * from `'local'` to the cloud UUID, so hardcoding `'local'` returns nothing.
 */
export async function resolveWorkspaceId(db: DatabaseAdapter): Promise<string | null> {
  const { data } = await db
    .from('agent_workforce_workspaces')
    .select('id')
    .limit(1)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

export interface ApplyShowcaseInput {
  workspaceId: string;
  target: ShowcaseTarget;
  result: ShowcaseResult;
  plan: ShowcasePlan;
  /** Ollama model id to stamp on the agent config. Caller usually passes config.ollamaModel. */
  ollamaModel?: string;
}

export async function applyShowcase(
  db: DatabaseAdapter,
  input: ApplyShowcaseInput,
): Promise<ShowcaseOutcome> {
  const { workspaceId, target, result, plan, ollamaModel } = input;
  const now = new Date().toISOString();

  // ── Contact ─────────────────────────────────────────────────────────────
  const contactId = hexId();
  const customFields: Record<string, unknown> = { source: 'showcase' };
  if (result.pageUrl) customFields.website = result.pageUrl;
  if (target.company) customFields.company = target.company;
  if (result.pageTitle) customFields.page_title = result.pageTitle;
  if (result.pageDescription) customFields.page_description = result.pageDescription;

  await db.from('agent_workforce_contacts').insert({
    id: contactId,
    workspace_id: workspaceId,
    name: plan.contactName,
    email: target.email ?? null,
    company: target.company ?? (target.kind === 'company' ? target.name : null),
    contact_type: 'lead',
    status: 'active',
    tags: JSON.stringify(['showcase', target.kind]),
    custom_fields: JSON.stringify(customFields),
    notes: result.pageDescription ?? null,
    created_at: now,
    updated_at: now,
  });

  // ── Goal ────────────────────────────────────────────────────────────────
  const goalId = hexId();
  await db.from('agent_workforce_goals').insert({
    id: goalId,
    workspace_id: workspaceId,
    title: plan.goalTitle,
    description: `Created by ohwow showcase for ${target.name}.`,
    status: 'active',
    priority: 'normal',
    color: '#6366f1',
    position: 0,
    created_at: now,
    updated_at: now,
  });

  // ── Project ─────────────────────────────────────────────────────────────
  const projectId = hexId();
  await db.from('agent_workforce_projects').insert({
    id: projectId,
    workspace_id: workspaceId,
    name: plan.projectName,
    description: `Showcase project for ${target.name}. Contact: ${contactId}.`,
    status: 'active',
    color: '#6366f1',
    position: 0,
    goal_id: goalId,
    created_at: now,
    updated_at: now,
  });

  // ── Agent ───────────────────────────────────────────────────────────────
  const agentId = hexId();
  await db.from('agent_workforce_agents').insert({
    id: agentId,
    workspace_id: workspaceId,
    name: plan.agentName,
    role: plan.agentRole,
    description: plan.agentDescription,
    system_prompt: plan.agentSystemPrompt,
    config: JSON.stringify({
      model: ollamaModel || 'qwen3:4b',
      temperature: 0.7,
      max_tokens: 4096,
      tools_enabled: [...new Set([...DEFAULT_AGENT_TOOLS, 'local_crm'])],
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

  return { agentId, projectId, goalId, contactId };
}
