/**
 * Workflow Suggester (E27) — Generate Workflow Descriptions from Patterns
 *
 * Takes mined workflow candidates and uses LLM to generate
 * human-readable workflow descriptions. Persists discovered processes.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ModelRouter } from '../../execution/model-router.js';
import type { WorkflowCandidate, ProcessStep, ProcessMiningResult } from './types.js';
import { callLLM, parseJSONResponse, calculateCostCents } from './llm-helper.js';
import { logger } from '../logger.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_PROCESSES_PER_RUN = 5;

// ============================================================================
// PROMPTS
// ============================================================================

const WORKFLOW_SYSTEM_PROMPT = `You are a business process analyst. Given a recurring sequence of tool calls observed across an AI agent workspace, describe the business workflow this represents.

Respond with ONLY a JSON object:
{
  "name": "Human Readable Process Name",
  "description": "1-2 sentence description of the business workflow and its purpose"
}

Rules:
- Name should be clear and business-oriented (e.g., "Lead Qualification Pipeline", "Content Publishing Workflow")
- Description should explain the business value, not just list tools
- Focus on WHAT the process achieves for the business
- Be concise`;

function buildWorkflowPrompt(candidate: WorkflowCandidate): string {
  return `Tool sequence (observed ${candidate.frequency} times across ${candidate.agentIds.length} agent(s)):

${candidate.toolSequence.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Describe the business workflow this represents.`;
}

// ============================================================================
// DEDUPLICATION
// ============================================================================

interface ExistingProcess {
  id: string;
  steps: ProcessStep[];
}

function isDuplicateProcess(candidate: WorkflowCandidate, existing: ExistingProcess[]): boolean {
  for (const proc of existing) {
    const existingTools = proc.steps.map((s) => s.toolName);

    if (
      existingTools.length === candidate.toolSequence.length &&
      existingTools.every((t, i) => t === candidate.toolSequence[i])
    ) {
      return true;
    }

    const overlapCount = candidate.toolSequence.filter((t) => existingTools.includes(t)).length;
    const overlapRatio = overlapCount / Math.max(candidate.toolSequence.length, existingTools.length);
    if (overlapRatio >= 0.8) return true;
  }

  return false;
}

// ============================================================================
// MAIN SUGGESTER
// ============================================================================

/**
 * Suggest and persist workflow processes from mined candidates.
 */
export async function suggestWorkflows(
  db: DatabaseAdapter,
  router: ModelRouter,
  workspaceId: string,
  candidates: WorkflowCandidate[]
): Promise<ProcessMiningResult> {
  if (candidates.length === 0) {
    return { entriesAnalyzed: 0, candidatesFound: 0, processesDiscovered: 0, duplicatesSkipped: 0, tokensUsed: 0, costCents: 0 };
  }

  // Fetch existing for dedup
  const { data: existingData } = await db
    .from('agent_workforce_discovered_processes')
    .select('id, steps')
    .eq('workspace_id', workspaceId)
    .in('status', ['discovered', 'confirmed', 'automated']);

  const existing: ExistingProcess[] = (existingData ?? []).map((d) => {
    const row = d as Record<string, unknown>;
    let steps: ProcessStep[] = [];
    try {
      steps = typeof row.steps === 'string' ? JSON.parse(row.steps) : (row.steps as ProcessStep[]) || [];
    } catch { /* empty */ }
    return { id: row.id as string, steps };
  });

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let processesDiscovered = 0;
  let duplicatesSkipped = 0;

  const toProcess = candidates.slice(0, MAX_PROCESSES_PER_RUN);

  for (const candidate of toProcess) {
    if (isDuplicateProcess(candidate, existing)) {
      duplicatesSkipped++;
      continue;
    }

    const result = await callLLM(router, {
      system: WORKFLOW_SYSTEM_PROMPT,
      userMessage: buildWorkflowPrompt(candidate),
      maxTokens: 200,
      temperature: 0.3,
    });

    if (!result.success) {
      logger.error({ error: result.error }, '[WorkflowSuggester] LLM call failed');
      continue;
    }

    totalInputTokens += result.inputTokens;
    totalOutputTokens += result.outputTokens;

    const parsed = parseJSONResponse<{ name: string; description: string }>(result.content);
    if (!parsed || !parsed.name || !parsed.description) {
      logger.error({ content: result.content }, '[WorkflowSuggester] Invalid response');
      continue;
    }

    const steps: ProcessStep[] = candidate.toolSequence.map((toolName, i) => ({
      toolName,
      agentId: candidate.agentIds.length === 1 ? candidate.agentIds[0] : null,
      avgDurationMs: Math.round(candidate.avgDurationMs / candidate.toolSequence.length),
      order: i + 1,
    }));

    try {
      await db
        .from('agent_workforce_discovered_processes')
        .insert({
          workspace_id: workspaceId,
          name: parsed.name,
          description: parsed.description,
          steps: JSON.stringify(steps),
          frequency: candidate.frequency,
          avg_duration_ms: candidate.avgDurationMs,
          involved_agent_ids: JSON.stringify(candidate.agentIds),
          confidence: Math.min(1, candidate.frequency / 20),
          status: 'discovered',
        });

      processesDiscovered++;
      logger.info({ processName: parsed.name, frequency: candidate.frequency }, '[WorkflowSuggester] Process discovered');
    } catch (err) {
      logger.error({ err, processName: parsed.name }, '[WorkflowSuggester] Couldn\'t persist process');
    }
  }

  const costCents = calculateCostCents(totalInputTokens, totalOutputTokens);

  return {
    entriesAnalyzed: candidates.reduce((sum, c) => sum + c.sourceTaskIds.length, 0),
    candidatesFound: candidates.length,
    processesDiscovered,
    duplicatesSkipped,
    tokensUsed: totalInputTokens + totalOutputTokens,
    costCents,
  };
}
