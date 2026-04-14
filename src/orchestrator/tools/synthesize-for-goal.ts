/**
 * Synthesize for Goal — autonomous-learning entry point
 *
 * Tool schema definition lives at the top; runtime handler below.
 *
 * Thin wrapper around the same probe → generate → test pipeline that
 * `synthesis_run_acceptance` uses, but without requiring a backing
 * `agent_workforce_tasks` row. The orchestrator calls this tool when
 * it decides on its own initiative that a new deterministic skill
 * would be worth having.
 *
 * That's the subtle difference from acceptance: acceptance replays a
 * KNOWN failure (408k-token tweet post). This tool runs on a PROPOSED
 * goal that the orchestrator picked from its own reasoning about
 * ohwow's current capability gaps. No trace, no prior tokens burned
 * — just "here is a web surface I want to interact with deterministically,
 * go write me a tool for it".
 *
 * Always dry-run. This tool never publishes. If a synthesized skill
 * turns out to be useful for a subsequent live action, the user or
 * the orchestrator can call it explicitly via its generated name
 * through the runtime tool registry — same dispatch path any other
 * tool takes.
 *
 * Safety is the same as acceptance: real-LLM generator by default,
 * stub vision verdict, ALL live side-effect flags default to false.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { logger } from '../../lib/logger.js';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { resolveActiveWorkspace } from '../../config.js';
import { probeSurface } from './synthesis-probe.js';
import { generateCodeSkill } from './synthesis-generator.js';
import { testSynthesizedSkill } from './synthesis-tester.js';
import type { SynthesisCandidate } from '../../scheduling/synthesis-failure-detector.js';

export const SYNTHESIZE_FOR_GOAL_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'synthesize_skill_for_goal',
    description: 'Autonomously synthesize a new deterministic TypeScript skill from a goal + target URL. Runs the real generator LLM (no canned fallback) against the strict template, probes the live surface via CDP, writes the file + inserts the skill row, and dry-run-tests the handler with a stub vision verdict. Always dry-run — no live side effects. Use this to teach ohwow a new read-only web skill on its own initiative.',
    input_schema: {
      type: 'object' as const,
      properties: {
        goal: {
          type: 'string',
          description: 'One-sentence description of what the skill should do. Gets copied into the generator prompt as the goal.',
        },
        target_url: {
          type: 'string',
          description: 'Absolute http(s) URL the generated tool will drive. The probe navigates here first.',
        },
        name_hint: {
          type: 'string',
          description: 'Optional human-readable naming hint. The generator LLM is still free to pick its own snake_case name.',
        },
        use_canned_llm: {
          type: 'boolean',
          description: 'Leave false for real-LLM generation. True is not supported by this tool — it has no canned fallback.',
        },
        test_input: {
          type: 'object',
          description: 'Optional input object the dry-run tester hands to the generated skill. Defaults to {} (always combined with dry_run: true). Supply this when the skill has required string parameters that would otherwise break with undefined — e.g. a description field the skill will fill in. Values never leave the browser because the tester always runs in dry-run mode.',
        },
      },
      required: ['goal', 'target_url'],
    },
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SynthesizeForGoalInput {
  /** One-sentence description of what the skill should do. */
  goal?: string;
  /** Absolute URL the skill will drive. Probe navigates here first. */
  target_url?: string;
  /** Optional human-readable name hint. The LLM is still free to pick its own snake_case name. */
  name_hint?: string;
  /** Stub out the generator's model call with a canned response. Off by default for autonomous runs. */
  use_canned_llm?: boolean;
  /**
   * Input object handed to the dry-run tester when it invokes the
   * generated skill. Defaults to `{}`, which only works for skills
   * that have no required parameters. Skills with required string
   * params (e.g. a `description` field on an edit form) fail at
   * `page.fill(sel, undefined)` with an empty stub; passing a real
   * placeholder here gives the tester something to type so the dry
   * run can complete and the skill can land in the registry.
   * Always combined with `dry_run: true` downstream, so values
   * here never leave the browser.
   */
  test_input?: Record<string, unknown>;
}

export interface SynthesizeForGoalReport {
  success: boolean;
  stage: 'probe' | 'generate' | 'test' | 'done';
  goal: string;
  targetUrl: string;
  skillName?: string;
  skillId?: string;
  scriptPath?: string;
  modelUsed?: string;
  manifestSummary?: {
    testidCount: number;
    formCount: number;
    contentEditableCount: number;
    observations: string[];
  };
  dryRunScreenshotBase64?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Pseudo-candidate builder
// ---------------------------------------------------------------------------

/**
 * Build a SynthesisCandidate that looks plausible to the generator
 * without actually being rooted in a failed task row. The generator
 * only reads `title`, `input`, `reactTrace`, `tokensUsed` — the rest
 * are cosmetic. Leaving `reactTrace` empty is fine: the prompt
 * includes "(no trace available)" in that case and the LLM still
 * produces valid output.
 */
function pseudoCandidate(goal: string, targetUrl: string): SynthesisCandidate {
  const autonomousId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? `autonomous_${crypto.randomUUID().replace(/-/g, '')}`
      : `autonomous_${Date.now().toString(16)}`;
  return {
    taskId: autonomousId,
    title: goal,
    description: 'Autonomous learning: orchestrator proposed this skill with no prior failure trace.',
    input: null,
    tokensUsed: 0,
    agentId: null,
    targetUrlGuess: targetUrl,
    reactTrace: [],
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public tool handler
// ---------------------------------------------------------------------------

export async function synthesizeSkillForGoal(
  ctx: LocalToolContext,
  rawInput: Record<string, unknown>,
): Promise<ToolResult> {
  if (!ctx.modelRouter) {
    return { success: false, error: 'No ModelRouter in context — cannot run generator.' };
  }

  const input = rawInput as SynthesizeForGoalInput;
  const goal = (input.goal || '').trim();
  const targetUrl = (input.target_url || '').trim();
  const nameHint = (input.name_hint || '').trim();
  const useCanned = input.use_canned_llm === true;
  const testInput: Record<string, unknown> = {
    ...(input.test_input ?? {}),
    dry_run: true,
  };

  if (!goal) {
    return { success: false, error: 'goal is required (one-sentence description of the skill)' };
  }
  if (!targetUrl || !/^https?:\/\//.test(targetUrl)) {
    return { success: false, error: 'target_url is required and must be an absolute http(s) URL' };
  }

  const effectiveGoal = nameHint ? `${goal} (name hint: ${nameHint})` : goal;
  const candidate = pseudoCandidate(effectiveGoal, targetUrl);

  const report: SynthesizeForGoalReport = {
    success: false,
    stage: 'probe',
    goal: effectiveGoal,
    targetUrl,
    message: 'starting',
  };

  // 1. Probe
  const probeResult = await probeSurface({ url: targetUrl, goalDescription: effectiveGoal });
  if (!probeResult.success || !probeResult.manifest) {
    report.message = `Probe failed: ${probeResult.message}`;
    return { success: false, error: report.message, data: report };
  }
  const manifest = probeResult.manifest;
  report.manifestSummary = {
    testidCount: manifest.testidElements.length,
    formCount: manifest.formElements.length,
    contentEditableCount: manifest.contentEditables.length,
    observations: manifest.observations,
  };
  logger.info(
    { testidCount: manifest.testidElements.length, url: manifest.url, goal: effectiveGoal },
    '[synthesize-for-goal] probe complete',
  );

  // 2. Generate
  report.stage = 'generate';
  const layout = resolveActiveWorkspace();
  const genResult = await generateCodeSkill({
    db: ctx.db,
    workspaceId: ctx.workspaceId,
    modelRouter: ctx.modelRouter,
    candidate,
    manifest,
    skillsDir: layout.skillsDir,
    _llmCallForTest: useCanned
      ? async () => {
          throw new Error('synthesize_skill_for_goal does not carry a canned LLM fallback');
        }
      : undefined,
  });
  if (!genResult.ok) {
    report.message = `Generator failed at stage=${genResult.stage}: ${genResult.error}`;
    return { success: false, error: report.message, data: report };
  }
  report.skillId = genResult.skillId;
  report.skillName = genResult.name;
  report.scriptPath = genResult.scriptPath;
  report.modelUsed = genResult.modelUsed;

  // 3. Dry-run test with stub vision
  report.stage = 'test';
  const testResult = await testSynthesizedSkill({
    db: ctx.db,
    modelRouter: ctx.modelRouter,
    ctx,
    skillName: genResult.name,
    testInput,
    goal: effectiveGoal,
    _visionEvalForTest: async () => ({
      ok: true,
      reason: 'autonomous-learning mode — stub vision accepted without model call',
    }),
  });
  if (!testResult.ok) {
    report.message = `Tester rejected the dry-run at stage=${testResult.stage}: ${testResult.message}`;
    return { success: false, error: report.message, data: report };
  }
  report.dryRunScreenshotBase64 = testResult.screenshotBase64;
  report.stage = 'done';
  report.success = true;
  report.message = `Autonomous learning run passed for goal "${effectiveGoal.slice(0, 80)}". Skill "${genResult.name}" registered and promoted. Always dry-run — no live side effects.`;
  return { success: true, data: report };
}
