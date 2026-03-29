/**
 * Ergon — Work Classification (Aristotle)
 *
 * "The function (ergon) of man is an activity of soul which follows
 * or implies a rational principle." — Aristotle, Nicomachean Ethics
 *
 * Every piece of work has a proper function — its ergon. Different
 * types of work succeed differently:
 * - Theoria succeeds when understanding deepens
 * - Poiesis succeeds when the artifact is good
 * - Praxis succeeds when the world changes
 *
 * Treating all work the same (just "tasks with statuses") misses this.
 */

import type { WorkKind, ErgonClassification, ErgonInput, SuccessCriterion } from './types.js';

// ============================================================================
// KEYWORD PATTERNS
// ============================================================================

const THEORIA_PATTERNS = /\b(research|analyze|analys[ei]s|compare|investigate|study|evaluate|report|audit|review|understand|assess|benchmark|survey|diagnose|examine|inspect|monitor|observe|forecast|predict)\b/i;
const POIESIS_PATTERNS = /\b(build|create|design|write|generate|draft|develop|produce|implement|launch|ship|deploy|setup|configure|automate|compose|craft|code|template|prototype|mockup|wireframe)\b/i;
const PRAXIS_PATTERNS = /\b(send|post|publish|sell|contact|schedule|hire|negotiate|close|onboard|follow.?up|outreach|pitch|delegate|manage|coordinate|approve|reject|assign|distribute|announce|notify|invoice|collect)\b/i;

/** Tool names that suggest specific work kinds. */
const TOOL_KIND_MAP: Record<string, WorkKind> = {
  // Theoria tools
  scrape_url: 'theoria',
  scrape_search: 'theoria',
  deep_research: 'theoria',
  analyze_image: 'theoria',
  ocr_extract_text: 'theoria',
  search_knowledge_base: 'theoria',
  // Poiesis tools
  generate_image: 'poiesis',
  create_workflow: 'poiesis',
  generate_workflow: 'poiesis',
  // Praxis tools
  send_whatsapp_message: 'praxis',
  send_telegram_message: 'praxis',
  send_email: 'praxis',
  run_agent: 'praxis',
  queue_task: 'praxis',
  create_contact: 'praxis',
  log_contact_event: 'praxis',
};

// ============================================================================
// SUCCESS CRITERIA BY KIND
// ============================================================================

const THEORIA_CRITERIA: SuccessCriterion[] = [
  { metric: 'insight_depth', threshold: 0.7 },
  { metric: 'source_diversity', threshold: 3 },
  { metric: 'output_substance', threshold: 0.6 },
];

const POIESIS_CRITERIA: SuccessCriterion[] = [
  { metric: 'artifact_delivered', threshold: 1.0 },
  { metric: 'quality_score', threshold: 0.7 },
  { metric: 'completeness', threshold: 0.8 },
];

const PRAXIS_CRITERIA: SuccessCriterion[] = [
  { metric: 'action_completed', threshold: 1.0 },
  { metric: 'truth_score', threshold: 70 },
  { metric: 'world_state_changed', threshold: 1.0 },
];

const EVALUATION_APPROACHES: Record<WorkKind, string> = {
  theoria: 'Evaluate by insight quality, source diversity, and analytical depth. Volume of output matters less than depth of understanding.',
  poiesis: 'Evaluate by artifact quality, completeness, and adherence to requirements. The deliverable should be usable as-is.',
  praxis: 'Evaluate by whether the intended change occurred. Did the message send? Did the contact respond? Did the deal close?',
};

// ============================================================================
// CLASSIFICATION
// ============================================================================

/**
 * Classify a task by its work kind (theoria, poiesis, praxis).
 *
 * Uses keyword matching on title + description, with optional tool
 * name signals. Pure function, no LLM calls.
 */
export function classifyWork(input: ErgonInput): ErgonClassification {
  const text = `${input.taskTitle} ${input.taskDescription ?? ''}`;

  // Score each kind
  const scores: Record<WorkKind, number> = {
    theoria: 0,
    poiesis: 0,
    praxis: 0,
  };

  // Text-based scoring
  const theoriaMatches = text.match(THEORIA_PATTERNS);
  const poiesisMatches = text.match(POIESIS_PATTERNS);
  const praxisMatches = text.match(PRAXIS_PATTERNS);

  if (theoriaMatches) scores.theoria += theoriaMatches.length;
  if (poiesisMatches) scores.poiesis += poiesisMatches.length;
  if (praxisMatches) scores.praxis += praxisMatches.length;

  // Tool-based scoring (secondary signal)
  if (input.toolNames) {
    for (const tool of input.toolNames) {
      const kind = TOOL_KIND_MAP[tool];
      if (kind) scores[kind] += 0.5;
    }
  }

  // Determine winner
  const total = scores.theoria + scores.poiesis + scores.praxis;
  let kind: WorkKind = 'praxis'; // default
  let maxScore = 0;

  for (const [k, s] of Object.entries(scores) as [WorkKind, number][]) {
    if (s > maxScore) {
      maxScore = s;
      kind = k;
    }
  }

  const confidence = total > 0 ? maxScore / total : 0.33;

  return {
    kind,
    confidence: Math.min(0.95, confidence),
    successCriteria: kind === 'theoria' ? THEORIA_CRITERIA
      : kind === 'poiesis' ? POIESIS_CRITERIA
      : PRAXIS_CRITERIA,
    evaluationApproach: EVALUATION_APPROACHES[kind],
  };
}

/**
 * Get the evaluation approach text for a work kind.
 * Useful for injecting into agent system prompts.
 */
export function getEvaluationGuidance(kind: WorkKind): string {
  return EVALUATION_APPROACHES[kind];
}
