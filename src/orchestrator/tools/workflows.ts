/**
 * Workflow orchestrator tools: list, run, get detail, create, update, delete
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { logger } from '../../lib/logger.js';

export const WORKFLOW_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'list_workflows',
    description:
      'List workflows in the workspace. Returns { total, returned, limit, workflows }. `total` is the unfiltered-by-limit count — use it to tell whether `workflows` is the complete set or only the first page. Default limit 50, max 500.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max workflows to return (default 50, max 500)' },
      },
      required: [],
    },
  },
  {
    name: 'run_workflow',
    description:
      'Execute a workflow by ID. Always confirm first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string', description: 'The workflow ID' },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: 'get_workflow_detail',
    description:
      'Get full details of a workflow including its step definitions and recent run history.',
    input_schema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string', description: 'The workflow ID' },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: 'generate_workflow',
    description:
      'Generate a workflow from a natural language description using AI. Auto-saves by default. Confirm before generating.',
    input_schema: {
      type: 'object' as const,
      properties: {
        description: { type: 'string', description: 'Natural language description of the workflow' },
        auto_save: { type: 'boolean', description: 'Auto-save the generated workflow (default true)' },
      },
      required: ['description'],
    },
  },
  {
    name: 'create_workflow',
    description:
      'Create a workflow with explicit step definitions. Use generate_workflow for natural language descriptions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Workflow name' },
        description: { type: 'string', description: 'Optional description' },
        definition: {
          type: 'object',
          description: 'Workflow definition with a steps array',
          properties: {
            steps: { type: 'array', description: 'Array of workflow steps' },
          },
          required: ['steps'],
        },
      },
      required: ['name', 'definition'],
    },
  },
  {
    name: 'update_workflow',
    description:
      'Update a workflow\'s name, description, status, or step definitions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string', description: 'The workflow ID' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['active', 'paused'] },
        definition: { type: 'object', description: 'Updated definition with steps' },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: 'delete_workflow',
    description:
      'Delete a workflow. Always confirm first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string', description: 'The workflow ID' },
      },
      required: ['workflow_id'],
    },
  },
];

export async function listWorkflows(
  ctx: LocalToolContext,
  input?: Record<string, unknown>,
): Promise<ToolResult> {
  // Before E4 this handler had a hardcoded limit(20) with no caller
  // override and no total field — the most severe of the list_* bugs
  // the fuzz surfaced, because there was no escape hatch at all. A
  // workspace with 21+ workflows would silently lose visibility into
  // every extra row forever. Accept a limit param with a sane default
  // and always return a total companion.
  const rawLimit = typeof input?.limit === 'number' ? (input.limit as number) : 50;
  const limit = Math.max(1, Math.min(500, Math.floor(rawLimit)));

  const { data, error } = await ctx.db
    .from('agent_workforce_workflows')
    .select('id, name, description, status, created_at, run_count')
    .eq('workspace_id', ctx.workspaceId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return { success: false, error: error.message };

  // Total-count companion so the caller can tell whether the
  // returned page is the complete set. No filter stack to mirror
  // here — list_workflows only filters by workspace_id.
  const { count: totalCount } = await ctx.db
    .from('agent_workforce_workflows')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', ctx.workspaceId);

  const workflows = (data || []) as Array<Record<string, unknown>>;

  return {
    success: true,
    data: {
      total: totalCount ?? workflows.length,
      returned: workflows.length,
      limit,
      workflows,
    },
  };
}

export async function runWorkflow(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const workflowId = input.workflow_id as string;
  if (!workflowId) return { success: false, error: 'workflow_id is required' };

  const { data: workflow } = await ctx.db
    .from('agent_workforce_workflows')
    .select('id, name, workspace_id, steps, run_count')
    .eq('id', workflowId)
    .single();

  if (!workflow) return { success: false, error: 'Workflow not found' };
  const w = workflow as { id: string; name: string; workspace_id: string; steps: string | unknown[]; run_count: number | null };
  if (w.workspace_id !== ctx.workspaceId) return { success: false, error: 'Workflow not in your workspace' };

  const steps = typeof w.steps === 'string' ? JSON.parse(w.steps) : w.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return { success: false, error: 'Workflow has no steps' };
  }

  // Execute workflow steps sequentially, passing context between steps
  const executeWorkflow = async () => {
    const contextParts: string[] = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepType = step.step_type || step.type;
      const stepAction = step.action || step.prompt;
      if ((stepType === 'agent_prompt' || stepType === 'agent_task' || !stepType) && step.agent_id && stepAction) {
        // Build input with prior step context
        const fullInput = contextParts.length > 0
          ? `${stepAction}\n\n## Context from prior steps\n${contextParts.join('\n')}`
          : stepAction;

        const { data: task } = await ctx.db
          .from('agent_workforce_tasks')
          .insert({
            workspace_id: ctx.workspaceId,
            agent_id: step.agent_id,
            title: stepAction.slice(0, 100),
            input: fullInput,
            status: 'pending',
          })
          .select('id')
          .single();

        if (task) {
          const result = await ctx.engine.executeTask(step.agent_id, (task as { id: string }).id);

          if (!result.success) {
            logger.error(`[orchestrator:run_workflow] Step ${i + 1} failed: ${result.error}`);
            break; // Stop workflow on step failure
          }

          // Accumulate context for subsequent steps
          const output = (typeof result.output === 'string' ? result.output : '').slice(0, 2000);
          if (output) {
            const title = step.title || stepAction.slice(0, 60);
            contextParts.push(`Step ${i + 1} (${title}): ${output}`);
          }
        }
      }
    }

    // Increment run count
    await ctx.db.from('agent_workforce_workflows').update({
      run_count: (w.run_count || 0) + 1,
      updated_at: new Date().toISOString(),
    }).eq('id', workflowId);
  };

  // Run async
  executeWorkflow().catch((err) => {
    logger.error(`[orchestrator:run_workflow] Execution failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  return { success: true, data: { message: `Workflow "${w.name}" execution started.` } };
}

export async function getWorkflowDetail(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const workflowId = input.workflow_id as string;
  if (!workflowId) return { success: false, error: 'workflow_id is required' };

  const { data: workflow } = await ctx.db
    .from('agent_workforce_workflows')
    .select('id, name, description, status, steps, created_at, updated_at, run_count')
    .eq('id', workflowId)
    .eq('workspace_id', ctx.workspaceId)
    .single();

  if (!workflow) return { success: false, error: 'Workflow not found' };

  return { success: true, data: workflow };
}

export async function createWorkflow(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const name = input.name as string;
  if (!name) return { success: false, error: 'name is required' };

  const definition = input.definition as { steps: unknown[] } | undefined;
  if (!definition?.steps || !Array.isArray(definition.steps)) {
    return { success: false, error: 'definition with steps array is required' };
  }

  const { data, error } = await ctx.db
    .from('agent_workforce_workflows')
    .insert({
      id: crypto.randomUUID(),
      workspace_id: ctx.workspaceId,
      name,
      description: (input.description as string) || '',
      status: 'active',
      steps: JSON.stringify(definition.steps),
      run_count: 0,
    })
    .select('id, name')
    .single();

  if (error) return { success: false, error: error.message };

  return { success: true, data: { message: `Created workflow: ${(data as { name: string }).name}`, workflow: data } };
}

export async function updateWorkflow(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const workflowId = input.workflow_id as string;
  if (!workflowId) return { success: false, error: 'workflow_id is required' };

  const { data: existing } = await ctx.db
    .from('agent_workforce_workflows')
    .select('id')
    .eq('id', workflowId)
    .eq('workspace_id', ctx.workspaceId)
    .single();

  if (!existing) return { success: false, error: 'Workflow not found' };

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.status) updates.status = input.status;
  if (input.definition) {
    const def = input.definition as { steps: unknown[] };
    if (def.steps) updates.steps = JSON.stringify(def.steps);
  }

  const { error } = await ctx.db
    .from('agent_workforce_workflows')
    .update(updates)
    .eq('id', workflowId);

  if (error) return { success: false, error: error.message };

  return { success: true, data: { message: 'Workflow updated' } };
}

export async function deleteWorkflow(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const workflowId = input.workflow_id as string;
  if (!workflowId) return { success: false, error: 'workflow_id is required' };

  const { data: existing } = await ctx.db
    .from('agent_workforce_workflows')
    .select('id, name')
    .eq('id', workflowId)
    .eq('workspace_id', ctx.workspaceId)
    .single();

  if (!existing) return { success: false, error: 'Workflow not found' };

  const { error } = await ctx.db
    .from('agent_workforce_workflows')
    .delete()
    .eq('id', workflowId);

  if (error) return { success: false, error: error.message };

  return { success: true, data: { message: `Deleted workflow: ${(existing as { name: string }).name}` } };
}

export async function generateWorkflow(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const description = input.description as string;
  if (!description) return { success: false, error: 'description is required' };

  // Need Anthropic API key or model router for generation
  if (!ctx.anthropicApiKey && !ctx.modelRouter) {
    return { success: false, error: 'Workflow generation requires an AI model. Set up a local model or API key.' };
  }

  // Load available agents for context
  const { data: agents } = await ctx.db
    .from('agent_workforce_agents')
    .select('id, name, role')
    .eq('workspace_id', ctx.workspaceId)
    .eq('paused', 0);

  const agentList = (agents || []).map((a: Record<string, unknown>) =>
    `- ${a.name} (${a.role}) [id: ${a.id}]`
  ).join('\n');

  const prompt = `Generate a workflow definition based on this description: "${description}"

Available agents:
${agentList || 'No agents available'}

Respond with ONLY a JSON object with this structure:
{
  "name": "Workflow Name",
  "description": "What this workflow does",
  "steps": [
    {
      "title": "Step title",
      "agent_id": "agent-uuid",
      "step_type": "agent_prompt",
      "action": "What the agent should do"
    }
  ]
}`;

  try {
    let responseText: string;

    if (ctx.modelRouter) {
      const provider = await ctx.modelRouter.getProvider('orchestrator');
      const result = await provider.createMessage({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 2048,
        temperature: 0.3,
      });
      responseText = result.content;
    } else if (ctx.anthropicApiKey) {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey: ctx.anthropicApiKey });
      const result = await client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 2048,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }],
      });
      responseText = result.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
    } else {
      return { success: false, error: 'No model available' };
    }

    // Extract JSON from response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { success: false, error: 'Couldn\'t generate a valid workflow. Try rephrasing.' };

    const generated = JSON.parse(jsonMatch[0]);

    // Auto-save if requested (default true)
    const autoSave = input.auto_save !== false;
    if (autoSave && generated.steps) {
      const { data: saved } = await ctx.db
        .from('agent_workforce_workflows')
        .insert({
          id: crypto.randomUUID(),
          workspace_id: ctx.workspaceId,
          name: generated.name || 'Generated Workflow',
          description: generated.description || description,
          status: 'active',
          steps: JSON.stringify(generated.steps),
          run_count: 0,
        })
        .select('id, name')
        .single();

      return {
        success: true,
        data: {
          message: `Generated and saved workflow: ${generated.name || 'Generated Workflow'}`,
          workflow: saved,
          definition: generated,
        },
      };
    }

    return { success: true, data: { message: 'Workflow generated', definition: generated } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Workflow generation failed' };
  }
}
