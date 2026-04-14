/**
 * Sub-Orchestrator — lightweight, ephemeral tool loop for focused subtasks.
 * Runs its own message history and tool loop, returns only a summary to the parent.
 * Prevents context bloat in the parent orchestrator for multi-step research/data tasks.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  ContentBlockParam,
  ContentBlock,
  Tool,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalToolContext, ToolResult } from './local-tool-types.js';
import type { ModelRouter, ModelProvider, ModelResponseWithTools } from '../execution/model-router.js';
import type { CircuitBreaker } from './error-recovery.js';
import { ConsecutiveToolBreaker } from './error-recovery.js';
import type { IntentSection } from './tool-definitions.js';
import type { ToolCallRequest, ToolExecutionContext, BrowserState } from './tool-executor.js';
import type { ToolCache } from './tool-cache.js';
import type { ChannelChatOptions } from './orchestrator-types.js';
import { ORCHESTRATOR_TOOL_DEFINITIONS, filterToolsByIntent } from './tool-definitions.js';
import { executeToolCallsBatch } from './batch-executor.js';
import { buildReflectionPrompt } from './reflection.js';
import { buildStaticInstructionsForIntent } from './system-prompt.js';
import { stripThinkTags } from './orchestrator-types.js';
import { convertToolsToOpenAI } from '../execution/tool-format.js';
import { parseToolArguments } from '../execution/tool-parse.js';
import { getWorkingNumCtx } from '../lib/ollama-models.js';
import { detectDevice } from '../lib/device-info.js';
import { ContextBudget } from './context-budget.js';
import { summarizeToolResult } from './result-summarizer.js';
import type { FoldResult } from '../execution/fold-types.js';
import { emptyFold } from '../execution/fold-types.js';

// ============================================================================
// TYPES
// ============================================================================

export interface SubOrchestratorOptions {
  prompt: string;
  sections: IntentSection[];
  /** Recursive fold depth (0 = first level, max 3). Controls nested delegate_subtask. */
  depth?: number;
  parentToolCtx: LocalToolContext;
  modelRouter: ModelRouter | null;
  anthropic: Anthropic;
  anthropicApiKey: string;
  orchestratorModel: string;
  circuitBreaker: CircuitBreaker;
  toolCache?: ToolCache;
  maxIterations?: number;
  /** Hard wall-clock timeout for the entire sub-orchestrator run. Defaults to 60s. */
  timeoutMs?: number;
  options?: ChannelChatOptions;
  /**
   * Focus tag from the parent delegate_subtask call. When set to
   * 'investigate', the sub-orchestrator switches to the bisection
   * prompt, applies the read-only tool allowlist (no write/mutate
   * tools, no nested investigations), and post-processes the final
   * assistant message through enforceInvestigationSchema to strip
   * premature conclusions.
   */
  focus?: string;
}

export interface SubOrchestratorResult {
  summary: string;
  /** Structured fold of the exploration (when available, prefer over raw summary) */
  fold: FoldResult;
  toolsCalled: string[];
  tokensUsed: { input: number; output: number };
  success: boolean;
}

// ============================================================================
// FOLD EXTRACTION
// ============================================================================

/**
 * Extract a structured FoldResult from the model's raw text output.
 * Looks for structured patterns (bullet points, headings) and extracts
 * into the typed fold format. Falls back to treating the full text as
 * the conclusion if no structure is found.
 */
function extractFoldResult(rawText: string, toolsCalled: string[]): FoldResult {
  const fold = emptyFold();
  if (!rawText || rawText.trim().length === 0) return fold;

  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

  // Try to identify structured sections
  const deadEnds: Array<{ approach: string; failure_reason: string; learning: string }> = [];
  const evidence: string[] = [];
  const decisions: string[] = [];
  let conclusion = '';

  let currentSection = 'general';

  for (const line of lines) {
    const lower = line.toLowerCase();

    // Detect section headers
    if (lower.includes('conclusion') || lower.includes('summary') || lower.includes('result')) {
      currentSection = 'conclusion';
      continue;
    }
    if (lower.includes('evidence') || lower.includes('finding') || lower.includes('found')) {
      currentSection = 'evidence';
      continue;
    }
    if (lower.includes('decision') || lower.includes('chose') || lower.includes('selected')) {
      currentSection = 'decisions';
      continue;
    }
    if (lower.includes('dead end') || lower.includes('failed') || lower.includes('didn\'t work')) {
      currentSection = 'dead_ends';
      continue;
    }

    // Strip bullet markers
    const cleaned = line.replace(/^[-*•]\s*/, '').replace(/^\d+\.\s*/, '');

    switch (currentSection) {
      case 'conclusion':
        conclusion += (conclusion ? ' ' : '') + cleaned;
        break;
      case 'evidence':
        if (cleaned.length > 10) evidence.push(cleaned);
        break;
      case 'decisions':
        if (cleaned.length > 10) decisions.push(cleaned);
        break;
      case 'dead_ends':
        if (cleaned.length > 10) {
          deadEnds.push({ approach: cleaned, failure_reason: 'See context', learning: cleaned });
        }
        break;
      default:
        // General text goes to conclusion
        conclusion += (conclusion ? ' ' : '') + cleaned;
    }
  }

  // If no structured conclusion was found, use the full text
  if (!conclusion) conclusion = rawText.slice(0, 500);

  fold.conclusion = conclusion;
  fold.evidence = evidence.slice(0, 10);
  fold.decisions_made = decisions.slice(0, 5);
  fold.dead_ends = deadEnds.slice(0, 5);
  fold.artifacts_created = toolsCalled.filter(t =>
    ['create_file', 'write_file', 'run_agent', 'queue_task', 'set_state'].includes(t),
  );

  return fold;
}

// ============================================================================
// INVESTIGATION SCHEMA ENFORCEMENT
// ============================================================================

export interface InvestigationHypothesis {
  claim: string;
  confirm_query: string;
  confirm_result: string;
  rejected_because: string | null;
}

export interface InvestigationFields {
  hypotheses_considered: InvestigationHypothesis[];
  queries_run: string[];
  confirmation_searches: string[];
  root_cause: string | null;
  recommended_fix?: { file: string; summary: string; confidence: 'high' | 'medium' | 'low' };
}

export interface SchemaEnforcementResult {
  /** The extracted + sanitized fields, with premature conclusions stripped. */
  fields: InvestigationFields;
  /** Warnings the parser emitted. Surfaced to the caller via fold.dead_ends. */
  warnings: string[];
  /** True iff the raw text contained a parseable JSON block. False = model skipped the schema entirely. */
  parsed: boolean;
}

/**
 * Parse a sub-orchestrator's final assistant text, extract the
 * investigation schema JSON block, and enforce the hard rules that
 * negative prompting cannot guarantee:
 *
 *   - root_cause is null unless every hypothesis has non-empty
 *     confirm_query AND confirm_result fields.
 *   - At least 2 hypotheses must be present (single-hypothesis runs
 *     are evidence the model skipped bisection — strip root_cause).
 *   - Returned fields default to empty arrays / null so downstream
 *     consumers can rely on shape even for broken model outputs.
 */
export function enforceInvestigationSchema(rawText: string): SchemaEnforcementResult {
  const warnings: string[] = [];
  const fields: InvestigationFields = {
    hypotheses_considered: [],
    queries_run: [],
    confirmation_searches: [],
    root_cause: null,
  };

  // Look for a ```json ... ``` fenced block. Fall back to a raw { ... } scan.
  const fencedMatch = rawText.match(/```json\s*\n([\s\S]*?)\n```/);
  const rawJson = fencedMatch ? fencedMatch[1] : extractJsonObject(rawText);

  if (!rawJson) {
    warnings.push('investigator did not emit the mandatory JSON output schema — falling back to empty fold');
    return { fields, warnings, parsed: false };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawJson) as Record<string, unknown>;
  } catch (err) {
    warnings.push(`investigator JSON did not parse: ${err instanceof Error ? err.message : 'unknown error'}`);
    return { fields, warnings, parsed: false };
  }

  // Hypotheses
  const rawHypotheses = Array.isArray(parsed.hypotheses_considered) ? parsed.hypotheses_considered : [];
  for (const h of rawHypotheses) {
    if (!h || typeof h !== 'object') continue;
    const rec = h as Record<string, unknown>;
    const claim = typeof rec.claim === 'string' ? rec.claim : '';
    const confirm_query = typeof rec.confirm_query === 'string' ? rec.confirm_query : '';
    const confirm_result = typeof rec.confirm_result === 'string' ? rec.confirm_result : '';
    const rejected_because = typeof rec.rejected_because === 'string' ? rec.rejected_because : null;
    if (claim) {
      fields.hypotheses_considered.push({ claim, confirm_query, confirm_result, rejected_because });
    }
  }

  // Queries + confirmations
  if (Array.isArray(parsed.queries_run)) {
    fields.queries_run = parsed.queries_run.filter((q: unknown): q is string => typeof q === 'string');
  }
  if (Array.isArray(parsed.confirmation_searches)) {
    fields.confirmation_searches = parsed.confirmation_searches.filter(
      (q: unknown): q is string => typeof q === 'string',
    );
  }

  // Recommended fix (optional)
  if (parsed.recommended_fix && typeof parsed.recommended_fix === 'object') {
    const rec = parsed.recommended_fix as Record<string, unknown>;
    const file = typeof rec.file === 'string' ? rec.file : '';
    const summary = typeof rec.summary === 'string' ? rec.summary : '';
    const rawConfidence = typeof rec.confidence === 'string' ? rec.confidence.toLowerCase() : 'medium';
    const confidence: 'high' | 'medium' | 'low' =
      rawConfidence === 'high' || rawConfidence === 'low' ? rawConfidence : 'medium';
    if (file && summary) {
      fields.recommended_fix = { file, summary, confidence };
    }
  }

  // Root cause — gated on schema rules
  const rawRootCause = typeof parsed.root_cause === 'string' ? parsed.root_cause : null;
  if (rawRootCause) {
    if (fields.hypotheses_considered.length < 2) {
      warnings.push(
        `investigator named root_cause with only ${fields.hypotheses_considered.length} hypothesis — stripping. At least 2 hypotheses are required so bisection is real.`,
      );
    } else {
      const missing = fields.hypotheses_considered.filter(
        (h) => !h.confirm_query.trim() || !h.confirm_result.trim(),
      );
      if (missing.length > 0) {
        warnings.push(
          `investigator named root_cause but ${missing.length} hypothesis entry had empty confirm_query or confirm_result — stripping. The parser requires every hypothesis to be actually checked.`,
        );
      } else {
        fields.root_cause = rawRootCause;
      }
    }
    if (!fields.root_cause && fields.recommended_fix) {
      // Demote recommended_fix confidence since its justification was stripped.
      fields.recommended_fix = { ...fields.recommended_fix, confidence: 'low' };
    }
  }

  return { fields, warnings, parsed: true };
}

/**
 * Fallback JSON extractor: if the model emitted a `{ ... }` block
 * without markdown fences, try to find the largest outermost object
 * in the text. Intentionally permissive — enforceInvestigationSchema
 * rejects malformed content downstream.
 */
function extractJsonObject(text: string): string | null {
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return null;
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let escape = false;
  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (inString) {
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(firstBrace, i + 1);
    }
  }
  return null;
}

/** Focus areas map to tool intent sections. */
const FOCUS_SECTIONS: Record<string, IntentSection[]> = {
  research: ['rag', 'business'],
  agents: ['agents'],
  crm: ['business'],
  projects: ['projects', 'agents'],
  data: ['pulse', 'business', 'agents'],
  // Wiki focus: only the markdown synthesis layer. Used by wiki_curate
  // and any future janitorial wiki work that should run in isolation
  // from the parent chat's context.
  wiki: ['rag'],
  // Investigate focus: code-level bisection. Pulls in filesystem reads
  // (local_search_content / local_read_file), LSP tools, RAG, and the
  // dedicated investigate_shell for DB introspection. The read-only
  // write-tool blocklist is applied separately in getExcludedTools.
  investigate: ['investigate', 'filesystem', 'dev', 'rag'],
};

/**
 * Per-focus wall-clock timeouts. Janitorial focuses that walk a
 * backlog (e.g., wiki lint-fix loops across 14+ pages) legitimately
 * need several minutes on cloud-tier Haiku. Research-shaped focuses
 * should fail fast because a stuck RAG loop is usually a model
 * confusion loop, not real work.
 */
const FOCUS_TIMEOUTS_MS: Record<string, number> = {
  wiki: 420_000,     // 7 min — 18 iters × ~20s worst case
  research: 180_000, // 3 min
  agents: 180_000,
  crm: 180_000,
  projects: 240_000,
  data: 240_000,
  // 6 min — investigate may need 10+ bisect rounds through the
  // codebase. The 15-iteration budget (set in local-orchestrator's
  // focusIterations) assumes ~20–30s per iter on cheap Haiku.
  investigate: 360_000,
};

export function getTimeoutForFocus(focus: string): number {
  return FOCUS_TIMEOUTS_MS[focus] ?? DEFAULT_SUB_ORCHESTRATOR_TIMEOUT_MS;
}

/** Max recursive fold depth for nested sub-orchestrators */
const MAX_FOLD_DEPTH = 3;

/** Browser tools excluded from sub-orchestrators (they'd need a browser service) */
const EXCLUDED_BROWSER_TOOLS = new Set([
  'request_browser',
  'browser_navigate', 'browser_screenshot', 'browser_click', 'browser_type',
  'browser_scroll', 'browser_back', 'browser_evaluate', 'browser_close',
]);

/**
 * Tools the `investigate` focus explicitly refuses to surface to its
 * sub-orchestrator model. The investigate focus is read-only by
 * contract: its job is to find a root cause, not to apply fixes.
 * Everything that mutates state — filesystem writes, unrestricted
 * shell (use investigate_shell instead), agent/task/CRM writes,
 * outbound comms — lives here. If the investigation needs something
 * in this list, the right answer is to return a recommended_fix in
 * the fold and let the parent orchestrator apply it, not to chain
 * the mutation inside the investigation.
 */
const INVESTIGATE_EXCLUDED_WRITE_TOOLS = new Set([
  // Filesystem writes (reads are kept via local_search_content / local_read_file)
  'local_write_file', 'local_edit_file', 'local_delete_file',
  'local_move_file', 'local_copy_file',
  // Raw shell replaced by regex-gated investigate_shell
  'run_bash',
  // Agent / task / project / goal mutations
  'run_agent', 'run_sequence', 'spawn_agents', 'queue_task', 'retry_task',
  'cancel_task', 'approve_task', 'reject_task', 'update_agent_status',
  'update_agent_schedule', 'create_project', 'update_project', 'delete_project',
  'create_goal', 'update_goal', 'link_task_to_goal', 'link_project_to_goal',
  // CRM mutations
  'create_contact', 'update_contact', 'delete_contact', 'log_contact_event',
  // Workflow / automation mutations
  'create_workflow', 'update_workflow', 'delete_workflow', 'generate_workflow',
  'create_workflow_trigger', 'update_workflow_trigger', 'delete_workflow_trigger',
  'create_automation', 'propose_automation', 'run_workflow',
  // Outbound comms — investigation must not reach the outside world
  'send_whatsapp_message', 'send_telegram_message', 'connect_whatsapp',
  'send_a2a_task', 'delegate_to_peer', 'ask_peer',
  // State writes (reads via get_agent_state / list_agent_state stay)
  'set_agent_state', 'delete_agent_state', 'clear_agent_state',
  // Knowledge mutations
  'upload_knowledge', 'add_knowledge_from_url', 'delete_knowledge', 'assign_knowledge',
  // Deliverable writes
  'save_deliverable',
  // Nested investigate is blocked below via the delegate_subtask entry.
]);

/**
 * Get excluded tools based on fold depth AND the caller focus.
 *
 * - At depths below MAX_FOLD_DEPTH, `delegate_subtask` is allowed so a
 *   sub-orchestrator can fold into a deeper sub-orchestrator.
 * - At MAX_FOLD_DEPTH, `delegate_subtask` is excluded to prevent
 *   infinite recursion.
 * - For `focus === 'investigate'`, the full INVESTIGATE_EXCLUDED_WRITE_TOOLS
 *   set is applied AND `delegate_subtask` is hard-blocked regardless of
 *   depth. One-level-deep rule: investigate inside investigate is a
 *   sign the first layer didn't decompose properly, so we surface
 *   that as a missing-tool error rather than burning more budget.
 */
function getExcludedTools(depth: number, focus?: string): Set<string> {
  const excluded = new Set(EXCLUDED_BROWSER_TOOLS);
  if (depth >= MAX_FOLD_DEPTH) {
    excluded.add('delegate_subtask');
  }
  if (focus === 'investigate') {
    for (const t of INVESTIGATE_EXCLUDED_WRITE_TOOLS) excluded.add(t);
    excluded.add('delegate_subtask');
  }
  return excluded;
}

/**
 * Default wall-clock timeout for a sub-orchestrator run. Individual
 * callers override via SubOrchestratorOptions.timeoutMs when the work
 * is known to be longer (e.g., wiki janitorial passes walking a backlog
 * of lint findings). 180s is long enough for 5 default iterations even
 * on a slow cloud provider, short enough that a stuck loop fails fast.
 */
const DEFAULT_SUB_ORCHESTRATOR_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_ITERATIONS = 5;

// ============================================================================
// SYSTEM PROMPT
// ============================================================================

function buildSubOrchestratorPrompt(sections: Set<IntentSection>): string {
  const staticInstructions = buildStaticInstructionsForIntent(sections);
  return `You are a focused research assistant. Complete the task using the tools available, then write a concise summary of your findings.

${staticInstructions}

## Constraints
- You have a limited number of iterations. Be efficient.
- Use tools to gather data, then synthesize into a clear summary.
- Do not ask follow-up questions. Work with what you have.
- Your final message should be a summary of findings, not raw tool output.`;
}

/**
 * Prompt for the `investigate` focus. Replaces the generic research
 * prompt with a 7-step bisection protocol and a mandatory structured
 * output schema. The schema is also enforced programmatically by
 * enforceInvestigationSchema after the run completes — negative
 * prompting alone ("don't conclude X") is unreliable under pressure,
 * so the parser strips any premature root_cause and demotes the
 * result to success=false.
 */
function buildInvestigatePrompt(sections: Set<IntentSection>): string {
  const staticInstructions = buildStaticInstructionsForIntent(sections);
  return `You are a code-investigation sub-orchestrator. A parent check failed and you must find the ROOT CAUSE of the discrepancy by searching the codebase. Your job is NOT to accept the first plausible narrative — it is to bisect until the evidence is unambiguous.

${staticInstructions}

## Protocol (mandatory, in order)

1. **READ** the discrepancy carefully. Quote it back in your own words in your first thought, including the exact symptoms and the two values that disagreed.

2. **EXPAND**: in your first turn, write down 3–5 semantic search variations that would find relevant code. Vary wording across: method name → related concept → error message → SQL keyword → schema column. Do NOT call a separate llm tool for this — generate the variations inline as part of your reasoning.

3. **FAN OUT**: run each variation via \`local_search_content\` (prefer) or \`investigate_shell rg ...\` (when you need a regex the filesystem tool cannot express). Collect the hits.

4. **READ HITS**: for each top hit, call \`local_read_file\` on the containing file and quote the relevant 3–10 lines.

5. **HYPOTHESIZE**: form AT LEAST 2 candidate root causes. Each hypothesis must have a \`claim\` (one sentence), a \`confirm_query\` (the exact search/read/sql you will run to check it), and — if ruled out — a \`rejected_because\` explaining why. You MAY NOT name a \`root_cause\` until every hypothesis has a non-empty \`confirm_query\` and a non-empty \`confirm_result\`.

6. **BISECT**: run each confirm_query (a search, a \`local_read_file\`, or an \`investigate_shell\` sqlite SELECT). Record the result under each hypothesis as \`confirm_result\`.

7. **CONCLUDE** with a structured final message — see the schema below. No tool calls in the final message, just the JSON block.

## Output schema (MANDATORY on your final assistant message)

Your final message must include a fenced JSON code block matching this shape, and nothing else besides a short narrative wrapper:

\`\`\`json
{
  "hypotheses_considered": [
    {
      "claim": "<one sentence>",
      "confirm_query": "<the actual search/read/sql you ran>",
      "confirm_result": "<what came back — quote a fragment>",
      "rejected_because": null
    }
  ],
  "queries_run": ["<every expansion variation you tried>"],
  "confirmation_searches": ["<every bisect query>"],
  "root_cause": "<the highest-confidence hypothesis's claim, or null if evidence is thin>",
  "recommended_fix": {
    "file": "<path relative to the repo root>",
    "summary": "<one sentence describing the change>",
    "confidence": "high"
  },
  "dead_ends": [{"approach": "<what you tried>", "learning": "<what to remember>"}]
}
\`\`\`

## Hard rules (enforced by the sub-orchestrator parser, not just this prompt)

- \`root_cause\` will be STRIPPED if any hypothesis has an empty \`confirm_query\` or empty \`confirm_result\`. You must actually run the confirmation before concluding.
- You must report at least 2 hypotheses, even if the first one is obviously correct. Reporting only one is evidence you skipped bisection.
- You must run at least one \`local_search_content\`, \`local_read_file\`, or \`investigate_shell\` call per hypothesis's \`confirm_query\` — no "by inspection" shortcuts.
- Do not call \`delegate_subtask\`. Investigate-inside-investigate is blocked; if you can't decompose the problem with your own tools, return with \`root_cause: null\` and describe what additional tools you would need in \`dead_ends\`.

## Forbidden shortcuts (these will not save you — the parser catches them)

- "Data drift" is only a valid root cause if you've confirmed the underlying values changed between capture and query. Run a direct query on the data to verify before naming drift.
- "Environment issue" is only valid if you've read the relevant config file and spotted a concrete mismatch.
- "Model reporting error" is only valid if you've read the tool handler source and found the bucket-collapsing logic.`;
}

// ============================================================================
// SUB-ORCHESTRATOR
// ============================================================================

export function getFocusSections(focus: string): IntentSection[] {
  return FOCUS_SECTIONS[focus] ?? ['rag', 'business'];
}

export async function runSubOrchestrator(opts: SubOrchestratorOptions): Promise<SubOrchestratorResult> {
  const {
    prompt,
    sections,
    parentToolCtx,
    modelRouter,
    anthropic,
    orchestratorModel,
    circuitBreaker,
    toolCache,
    options,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    timeoutMs = DEFAULT_SUB_ORCHESTRATOR_TIMEOUT_MS,
    depth = 0,
    focus,
  } = opts;

  const sectionSet = new Set(sections);
  const toolsCalled: string[] = [];

  // Build scoped tool list (depth-aware: allow delegate_subtask below MAX_FOLD_DEPTH).
  // When focus === 'investigate', getExcludedTools also strips every
  // write/mutate tool AND hard-blocks delegate_subtask regardless of
  // depth (one-level-deep investigation rule).
  const excludedTools = getExcludedTools(depth, focus);
  const tools = filterToolsByIntent([...ORCHESTRATOR_TOOL_DEFINITIONS], sectionSet)
    .filter(t => !excludedTools.has(t.name));

  // Pick the prompt shape based on focus. Investigate gets a bisection
  // protocol with a mandatory JSON output schema; everything else gets
  // the generic research-assistant prompt.
  const systemPrompt = focus === 'investigate'
    ? buildInvestigatePrompt(sectionSet)
    : buildSubOrchestratorPrompt(sectionSet);

  // Create a timeout promise
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Sub-orchestrator timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });

  // Build execution context (no browser, shared circuit breaker)
  const executedToolCalls = new Map<string, ToolResult>();
  const noBrowserState: BrowserState = { service: null, activated: false, headless: true, dataDir: '' };
  const execCtx: ToolExecutionContext = {
    toolCtx: parentToolCtx,
    executedToolCalls,
    browserState: noBrowserState,
    waitForPermission: async () => false, // No permissions in sub-orchestrator
    addAllowedPath: async () => {},
    options,
    circuitBreaker,
    toolCache,
    // Recursive delegate_subtask: spawns a nested sub-orchestrator at depth+1.
    // The investigate focus blocks the delegate_subtask tool entirely,
    // so this branch is effectively unreachable from inside an
    // investigation. Kept for the other focuses (research → research,
    // wiki → wiki, etc.).
    delegateSubtask: depth < MAX_FOLD_DEPTH && focus !== 'investigate'
      ? async (subPrompt: string, nestedFocus: string) => runSubOrchestrator({
          prompt: subPrompt,
          sections: getFocusSections(nestedFocus),
          parentToolCtx,
          modelRouter,
          anthropic,
          anthropicApiKey: opts.anthropicApiKey,
          orchestratorModel,
          circuitBreaker,
          toolCache,
          options,
          depth: depth + 1,
          timeoutMs: getTimeoutForFocus(nestedFocus),
          focus: nestedFocus,
        })
      : undefined,
  };

  try {
    // Detect model path
    let result: SubOrchestratorResult;
    if (modelRouter) {
      let provider: ModelProvider;
      try {
        provider = await modelRouter.getProvider('orchestrator');
      } catch {
        return { summary: 'No model available for sub-orchestrator.', fold: emptyFold(), toolsCalled, tokensUsed: { input: 0, output: 0 }, success: false };
      }

      if (provider.name === 'ollama' && provider.createMessageWithTools) {
        result = await Promise.race([
          runOllamaSubLoop(provider as ModelProvider & { createMessageWithTools: NonNullable<ModelProvider['createMessageWithTools']> }, systemPrompt, prompt, tools, execCtx, executedToolCalls, toolsCalled, orchestratorModel, maxIterations),
          timeoutPromise,
        ]);
      } else {
        // Anthropic provider — fall through to Haiku path below
        result = await Promise.race([
          runAnthropicSubLoop(anthropic, systemPrompt, prompt, tools, execCtx, executedToolCalls, toolsCalled, maxIterations),
          timeoutPromise,
        ]);
      }
    } else {
      // Anthropic path — use Haiku for cost savings
      result = await Promise.race([
        runAnthropicSubLoop(anthropic, systemPrompt, prompt, tools, execCtx, executedToolCalls, toolsCalled, maxIterations),
        timeoutPromise,
      ]);
    }

    // Investigate-focus post-processing: parse the structured output
    // schema out of the sub-orchestrator's final text, enforce the
    // hard rules (>=2 hypotheses, every confirm field populated before
    // root_cause can stick), and merge the results into the fold.
    // Warnings become dead_ends entries so the parent can tell the
    // model failed to follow the protocol.
    if (focus === 'investigate') {
      const enforcement = enforceInvestigationSchema(result.summary);
      result.fold.hypotheses_considered = enforcement.fields.hypotheses_considered;
      result.fold.queries_run = enforcement.fields.queries_run;
      result.fold.confirmation_searches = enforcement.fields.confirmation_searches;
      result.fold.root_cause = enforcement.fields.root_cause;
      if (enforcement.fields.recommended_fix) {
        result.fold.recommended_fix = enforcement.fields.recommended_fix;
      }
      for (const warning of enforcement.warnings) {
        result.fold.dead_ends.push({
          approach: 'investigator schema compliance',
          failure_reason: warning,
          learning: 'the investigate sub-orchestrator must emit the mandatory JSON schema with populated confirm_query/confirm_result fields for every hypothesis before naming a root cause',
        });
      }
      // A run with no parseable schema, no root_cause, or only one
      // hypothesis is a failed investigation — the parent should treat
      // it as "needs a bigger investigation" rather than "fix is ready".
      if (!enforcement.parsed || !enforcement.fields.root_cause || enforcement.fields.hypotheses_considered.length < 2) {
        result.success = false;
      }
    }

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Sub-orchestrator failed';
    return {
      summary: `Sub-orchestrator error: ${msg}`,
      fold: emptyFold(),
      toolsCalled,
      tokensUsed: { input: 0, output: 0 },
      success: false,
    };
  }
}

// ============================================================================
// ANTHROPIC SUB-LOOP
// ============================================================================

async function runAnthropicSubLoop(
  anthropic: Anthropic,
  systemPrompt: string,
  userPrompt: string,
  tools: Tool[],
  execCtx: ToolExecutionContext,
  executedToolCalls: Map<string, ToolResult>,
  toolsCalled: string[],
  maxIterations: number,
): Promise<SubOrchestratorResult> {
  const messages: MessageParam[] = [{ role: 'user', content: userPrompt }];
  let totalInput = 0;
  let totalOutput = 0;
  let fullContent = '';
  const consecutiveBreaker = new ConsecutiveToolBreaker();

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: systemPrompt,
      messages,
      tools,
      tool_choice: { type: 'auto' },
      temperature: 0.3,
    });

    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;

    // Collect text
    for (const block of response.content) {
      if (block.type === 'text' && block.text) {
        fullContent += block.text;
      }
    }

    const toolUseBlocks = response.content.filter(
      (block): block is ContentBlock & { type: 'tool_use' } => block.type === 'tool_use',
    );

    if (toolUseBlocks.length === 0) break;

    // Append assistant message
    messages.push({ role: 'assistant', content: response.content as ContentBlockParam[] });

    // Execute tools in batch
    const requests: ToolCallRequest[] = toolUseBlocks.map(t => ({
      id: t.id,
      name: t.name,
      input: t.input as Record<string, unknown>,
    }));

    const batchGen = executeToolCallsBatch(requests, execCtx);
    let outcomes: import('./tool-executor.js').ToolCallOutcome[];
    for (;;) {
      const { value, done } = await batchGen.next();
      if (done) { outcomes = value; break; }
      // Discard events (sub-orchestrator doesn't stream to TUI)
    }

    const toolResults: ToolResultBlockParam[] = [];
    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i];
      toolsCalled.push(outcome.toolName);
      const decision = consecutiveBreaker.record(
        outcome.toolName,
        !outcome.isError,
        outcome.isError ? outcome.resultContent : undefined,
      );
      let summarized = summarizeToolResult(outcome.toolName, outcome.resultContent, outcome.isError);
      if (decision === 'nudge') {
        summarized = `${summarized}${consecutiveBreaker.buildNudgeMessage(outcome.toolName)}`;
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUseBlocks[i].id,
        content: summarized,
        is_error: outcome.isError,
      });
    }

    // Re-anchoring
    const reflectionText = buildReflectionPrompt(userPrompt, executedToolCalls, iteration, maxIterations);
    messages.push({
      role: 'user',
      content: [...toolResults, { type: 'text' as const, text: reflectionText }],
    });

    if (consecutiveBreaker.isAborted()) {
      fullContent += `\n\n${consecutiveBreaker.buildAbortMessage()}`;
      break;
    }
  }

  const uniqueTools = [...new Set(toolsCalled)];
  return {
    summary: fullContent || 'No results found.',
    fold: extractFoldResult(fullContent, uniqueTools),
    toolsCalled: uniqueTools,
    tokensUsed: { input: totalInput, output: totalOutput },
    success: true,
  };
}

// ============================================================================
// OLLAMA SUB-LOOP
// ============================================================================

interface OllamaMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

async function runOllamaSubLoop(
  provider: ModelProvider & { createMessageWithTools: NonNullable<ModelProvider['createMessageWithTools']> },
  systemPrompt: string,
  userPrompt: string,
  tools: Tool[],
  execCtx: ToolExecutionContext,
  executedToolCalls: Map<string, ToolResult>,
  toolsCalled: string[],
  orchestratorModel: string,
  maxIterations: number,
): Promise<SubOrchestratorResult> {
  const openaiTools = convertToolsToOpenAI(tools);
  const numCtx = getWorkingNumCtx(orchestratorModel || '', undefined, detectDevice());
  const budget = new ContextBudget(numCtx, 2048);
  budget.setSystemPrompt(systemPrompt);

  const messages: OllamaMessage[] = [{ role: 'user', content: userPrompt }];
  let totalInput = 0;
  let totalOutput = 0;
  let fullContent = '';
  const consecutiveBreaker = new ConsecutiveToolBreaker();

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let response: ModelResponseWithTools;
    try {
      response = await provider.createMessageWithTools({
        model: orchestratorModel || undefined,
        system: systemPrompt,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
          ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        })),
        maxTokens: 2048,
        temperature: 0.3,
        tools: openaiTools,
        numCtx,
      });
    } catch {
      // Tool calling failed — break and return what we have
      break;
    }

    totalInput += response.inputTokens;
    totalOutput += response.outputTokens;

    const hasToolCalls = response.toolCalls && response.toolCalls.length > 0;
    if (response.content && !hasToolCalls) {
      const cleaned = stripThinkTags(response.content);
      if (cleaned) fullContent += cleaned;
    }

    if (!hasToolCalls) break;

    // Append assistant with tool calls
    messages.push({
      role: 'assistant',
      content: response.content || '',
      tool_calls: response.toolCalls!.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: tc.function,
      })),
    });

    // Parse and execute tools
    const toolCalls = response.toolCalls!;
    const validRequests: { req: ToolCallRequest; toolCall: (typeof toolCalls)[0] }[] = [];
    for (const toolCall of toolCalls) {
      const parsed = parseToolArguments(toolCall.function.arguments, toolCall.function.name);
      if (parsed.error) {
        messages.push({ role: 'tool', content: parsed.error, tool_call_id: toolCall.id });
        continue;
      }
      validRequests.push({
        req: { id: toolCall.id, name: toolCall.function.name, input: parsed.args },
        toolCall,
      });
    }

    if (validRequests.length > 0) {
      const batchGen = executeToolCallsBatch(validRequests.map(v => v.req), execCtx);
      let outcomes: import('./tool-executor.js').ToolCallOutcome[];
      for (;;) {
        const { value, done } = await batchGen.next();
        if (done) { outcomes = value; break; }
      }

      const resultsSummary: string[] = [];
      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i];
        const { toolCall } = validRequests[i];
        toolsCalled.push(outcome.toolName);
        const decision = consecutiveBreaker.record(
          outcome.toolName,
          !outcome.isError,
          outcome.isError ? outcome.resultContent : undefined,
        );
        let summarized = summarizeToolResult(outcome.toolName, outcome.resultContent, outcome.isError);
        if (decision === 'nudge') {
          summarized = `${summarized}${consecutiveBreaker.buildNudgeMessage(outcome.toolName)}`;
        }
        messages.push({ role: 'tool', content: summarized, tool_call_id: toolCall.id });
        resultsSummary.push(`## ${outcome.toolName}\n${summarized}`);
      }

      // Re-anchoring
      const reflection = buildReflectionPrompt(userPrompt, executedToolCalls, iteration, maxIterations);
      messages.push({
        role: 'user',
        content: `[Tool Results:\n${resultsSummary.join('\n\n')}\n\n${reflection}]`,
      });
    }

    if (consecutiveBreaker.isAborted()) {
      fullContent += `\n\n${consecutiveBreaker.buildAbortMessage()}`;
      break;
    }
  }

  const uniqueToolsOllama = [...new Set(toolsCalled)];
  return {
    summary: fullContent || 'No results found.',
    fold: extractFoldResult(fullContent, uniqueToolsOllama),
    toolsCalled: uniqueToolsOllama,
    tokensUsed: { input: totalInput, output: totalOutput },
    success: true,
  };
}
