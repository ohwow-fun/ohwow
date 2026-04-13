/**
 * Synthesis Tester — dry-run + vision-verify + promotion gate
 *
 * After the generator writes a synthesized skill and the loader
 * registers it, the tester takes the next step: actually invoke the
 * handler in dry-run mode, capture a screenshot, ask a vision model
 * "does this look like the intended pre-submit state?", and flip the
 * skill out of probation on yes.
 *
 * What makes the tester worth a whole module instead of inline code
 * in the generator: it's the only layer that gets to decide whether
 * a synthesized tool earns the trust to be shown to the LLM. The
 * runtime registry hides probation tools from the prompt by default
 * — promotion happens exclusively here, and only after two
 * independent signals agree: (1) the handler ran without throwing
 * AND returned success=true AND produced a screenshot; (2) the
 * vision model saw the screenshot and emitted ok=true for the
 * stated goal.
 *
 * Pass criteria
 *
 *   1. Handler did not throw and returned { success: true }.
 *   2. Handler returned a non-empty screenshotBase64.
 *   3. Vision model parsed a JSON verdict of {ok: true, ...} from
 *      the screenshot + goal prompt. Anything other than a
 *      well-formed ok-true verdict is a fail (including parse
 *      errors — we refuse to promote on ambiguity).
 *
 * On pass
 *
 *   - UPDATE agent_workforce_skills SET promoted_at = now, is_active = 1
 *   - Trigger the active runtime loader to re-load the file so the
 *     in-memory RuntimeToolDefinition's `probation` field flips to
 *     false and the tool becomes LLM-visible.
 *
 * On fail
 *
 *   - UPDATE agent_workforce_skills SET fail_count = fail_count + 1
 *   - Leave the probation flag on so the tool stays invisible.
 *   - Return a structured reason so the caller can display it.
 *
 * Nothing here publishes anything. The tester only runs the handler
 * with `dry_run: true`. The launch-day acceptance test (M8) is the
 * one place where dry_run is explicitly false, and that lives in
 * its own script — never here.
 */

import { logger } from '../../lib/logger.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import type { MessageContentPart, ModelRouter } from '../../execution/model-router.js';
import {
  runtimeToolRegistry,
  type RuntimeToolDefinition,
} from '../runtime-tool-registry.js';
import { getActiveRuntimeSkillLoader } from '../runtime-skill-loader.js';

// ---------------------------------------------------------------------------
// Handler outcome shape
// ---------------------------------------------------------------------------

/**
 * The concrete return shape the synthesis generator instructs skills
 * to produce. It's a ToolResult plus the extra fields the tester
 * needs for vision verification (screenshot + url + human-readable
 * message). Kept as a local type so non-synthesis tools aren't
 * forced to carry these fields, while the tester has precise types
 * instead of casting to `unknown`.
 *
 * Extends ToolResult so the existing tool-executor dispatch path
 * treats synthesized skills identically to static ones — anything
 * that consumes a ToolResult already sees the `success`/`data`/
 * `error` fields and ignores the extras.
 */
export interface SynthesizedSkillOutcome extends ToolResult {
  /** Human-readable summary the tester can show on failure. */
  message?: string;
  /** JPEG base64 from the skill's final `page.screenshot()` call. */
  screenshotBase64?: string;
  /** Landed URL after navigation — useful for vision eval context. */
  currentUrl?: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VisionVerdict {
  ok: boolean;
  reason: string;
}

export interface TestSynthesizedSkillInput {
  db: DatabaseAdapter;
  modelRouter: ModelRouter;
  /**
   * LocalToolContext to pass to the handler. Synthesized skills
   * typically ignore ctx (their generator template names it `_ctx`),
   * but we still need a real value to satisfy the ToolHandler
   * signature. Callers that don't have a full context may pass a
   * minimal stub.
   */
  ctx: LocalToolContext;
  /** The `name` of a synthesized skill already registered in runtimeToolRegistry. */
  skillName: string;
  /** Input to pass to the handler. `dry_run` is overridden to true regardless. */
  testInput: Record<string, unknown>;
  /** One-sentence description of what the tool is trying to do — fed to the vision model. */
  goal: string;
  /**
   * Inject the vision verdict function so unit tests can drive the
   * tester without a real model. Production callers leave this undefined.
   */
  _visionEvalForTest?: (screenshotBase64: string, goal: string) => Promise<VisionVerdict>;
}

export interface TestSynthesizedSkillResult {
  ok: boolean;
  stage: 'not_found' | 'handler_error' | 'no_screenshot' | 'vision_reject' | 'promoted';
  message: string;
  handlerResult?: SynthesizedSkillOutcome;
  visionVerdict?: VisionVerdict;
  screenshotBase64?: string;
  currentUrl?: string;
}

// ---------------------------------------------------------------------------
// Vision eval — default implementation
// ---------------------------------------------------------------------------

const VISION_PROMPT_TEMPLATE = (goal: string) => `You are verifying the output of a synthesized automation tool during its dry-run phase. The tool just composed an action against a web UI but has NOT yet submitted. You are looking at the screenshot of the UI RIGHT BEFORE the final submit click.

Goal the tool was asked to achieve:
"${goal}"

Your job: decide whether this screenshot shows the tool in a reasonable pre-submit state for that goal. Specifically:

  - Is the tool on the right page for the goal?
  - Does the UI show the intended content composed (e.g. text typed in the right field)?
  - Are there any error messages, login walls, empty states, or "undo" banners that suggest the tool is NOT actually ready to submit?

Output ONLY a single-line JSON object with two fields — no prose, no markdown, no code fences:

  {"ok": true, "reason": "short explanation"}

ok=true means "I would let this tool proceed to submit". ok=false means "stop, something is wrong".`;

async function defaultVisionEval(
  modelRouter: ModelRouter,
  screenshotBase64: string,
  goal: string,
): Promise<VisionVerdict> {
  try {
    const provider = await modelRouter.getProvider('vision');
    const content: MessageContentPart[] = [
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` } },
      { type: 'text', text: VISION_PROMPT_TEMPLATE(goal) },
    ];
    const response = await provider.createMessage({
      messages: [{ role: 'user', content }],
      maxTokens: 256,
      temperature: 0.1,
    });
    // ModelResponse.content is declared as `string` in model-router.ts,
    // so no array-of-parts unwrapping is needed here.
    return parseVisionVerdict(response.content);
  } catch (err) {
    return {
      ok: false,
      reason: `vision eval threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Parse the vision model's response into a VisionVerdict. Accepts
 * exactly one JSON object anywhere in the response — models sometimes
 * wrap it in markdown or add "Here is the verdict:" prefaces we
 * don't want to bind on. Anything else is treated as ok:false with
 * the raw text as the reason.
 */
export function parseVisionVerdict(raw: string): VisionVerdict {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, reason: 'empty vision response' };
  }
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) {
    return { ok: false, reason: `no JSON object in response: ${raw.slice(0, 120)}` };
  }
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed?.ok !== 'boolean') {
      return { ok: false, reason: 'verdict missing `ok` boolean' };
    }
    return {
      ok: Boolean(parsed.ok),
      reason: typeof parsed.reason === 'string' ? parsed.reason : '(no reason)',
    };
  } catch {
    return { ok: false, reason: `invalid JSON: ${match[0].slice(0, 120)}` };
  }
}

// ---------------------------------------------------------------------------
// Handler invocation
// ---------------------------------------------------------------------------

/**
 * Shape we accept when a handler chose to nest the screenshot under
 * `data`. Declared explicitly so we can reach into `data` without
 * blanket-casting to `unknown` — we narrow via property checks and
 * type guards instead.
 */
interface NestedScreenshotPayload {
  screenshotBase64?: unknown;
  currentUrl?: unknown;
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function pickNestedScreenshot(data: unknown): { screenshotBase64?: string; currentUrl?: string } {
  if (!data || typeof data !== 'object') return {};
  const nested = data as NestedScreenshotPayload;
  return {
    screenshotBase64: pickString(nested.screenshotBase64),
    currentUrl: pickString(nested.currentUrl),
  };
}

/**
 * Call the skill's handler with dry_run forced to true. Tolerates
 * both the synthesized-tool return shape
 * ({success, message, screenshotBase64, currentUrl}) and the
 * standard ToolResult shape ({success, data, error}). The tester
 * doesn't care which — as long as we get back a success flag + a
 * screenshot, we can move on to vision verification.
 *
 * The cast from `ToolResult` → `SynthesizedSkillOutcome` is valid
 * because SynthesizedSkillOutcome extends ToolResult with only
 * optional extra fields; at runtime synthesized skills populate
 * those extras (the generator template enforces it), but for
 * handlers that don't, the fields are just undefined.
 */
async function invokeHandlerDryRun(
  def: RuntimeToolDefinition,
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<SynthesizedSkillOutcome> {
  const forced = { ...input, dry_run: true };
  try {
    const raw = await def.handler(ctx, forced);
    if (!raw || typeof raw !== 'object') {
      return { success: false, error: 'handler returned non-object', message: 'handler returned non-object' };
    }
    const outcome = raw as SynthesizedSkillOutcome;
    if (!outcome.screenshotBase64) {
      const nested = pickNestedScreenshot(outcome.data);
      if (nested.screenshotBase64) outcome.screenshotBase64 = nested.screenshotBase64;
      if (nested.currentUrl) outcome.currentUrl = nested.currentUrl;
    }
    return outcome;
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// DB mutators
// ---------------------------------------------------------------------------

async function incrementFailCount(
  db: DatabaseAdapter,
  skillId: string,
): Promise<void> {
  try {
    const result = await db
      .from<{ fail_count?: number }>('agent_workforce_skills')
      .select('fail_count')
      .eq('id', skillId)
      .maybeSingle();
    const current = Number((result.data as { fail_count?: number } | null)?.fail_count ?? 0);
    await db
      .from('agent_workforce_skills')
      .update({
        fail_count: current + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', skillId);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, skillId },
      '[synthesis-tester] failed to increment fail_count',
    );
  }
}

async function markPromoted(
  db: DatabaseAdapter,
  skillId: string,
): Promise<void> {
  const now = new Date().toISOString();
  try {
    await db
      .from('agent_workforce_skills')
      .update({
        promoted_at: now,
        is_active: 1,
        updated_at: now,
      })
      .eq('id', skillId);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, skillId },
      '[synthesis-tester] failed to mark promoted_at',
    );
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function testSynthesizedSkill(
  input: TestSynthesizedSkillInput,
): Promise<TestSynthesizedSkillResult> {
  const def = runtimeToolRegistry.get(input.skillName);
  if (!def) {
    return {
      ok: false,
      stage: 'not_found',
      message: `Skill "${input.skillName}" is not registered in the runtime tool registry`,
    };
  }

  // Step 1: dry-run invocation
  const handlerResult = await invokeHandlerDryRun(def, input.ctx, input.testInput);
  if (!handlerResult.success) {
    await incrementFailCount(input.db, def.skillId);
    return {
      ok: false,
      stage: 'handler_error',
      message: handlerResult.message ?? handlerResult.error ?? 'handler returned success=false',
      handlerResult,
    };
  }

  // Step 2: need a screenshot to verify
  const screenshotBase64 = handlerResult.screenshotBase64;
  if (!screenshotBase64 || typeof screenshotBase64 !== 'string' || screenshotBase64.length < 16) {
    await incrementFailCount(input.db, def.skillId);
    return {
      ok: false,
      stage: 'no_screenshot',
      message: 'handler succeeded but did not return a screenshot to verify',
      handlerResult,
    };
  }

  // Step 3: vision verification
  const verdict = input._visionEvalForTest
    ? await input._visionEvalForTest(screenshotBase64, input.goal)
    : await defaultVisionEval(input.modelRouter, screenshotBase64, input.goal);

  if (!verdict.ok) {
    await incrementFailCount(input.db, def.skillId);
    return {
      ok: false,
      stage: 'vision_reject',
      message: `vision model rejected the dry-run screenshot: ${verdict.reason}`,
      handlerResult,
      visionVerdict: verdict,
      screenshotBase64,
      currentUrl: handlerResult.currentUrl,
    };
  }

  // Step 4: promote. Mark in DB and hot-reload so the in-memory
  // RuntimeToolDefinition flips probation=false.
  await markPromoted(input.db, def.skillId);
  const loader = getActiveRuntimeSkillLoader();
  if (loader) {
    try {
      await loader.loadFile(def.scriptPath);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, skillId: def.skillId },
        '[synthesis-tester] failed to reload skill after promotion (will be picked up by watcher)',
      );
    }
  }

  logger.info(
    { skillId: def.skillId, skillName: def.name },
    '[synthesis-tester] synthesized skill promoted',
  );

  return {
    ok: true,
    stage: 'promoted',
    message: `Skill "${def.name}" promoted. Vision verdict: ${verdict.reason}`,
    handlerResult,
    visionVerdict: verdict,
    screenshotBase64,
    currentUrl: handlerResult.currentUrl,
  };
}
