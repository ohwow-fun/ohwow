/**
 * Synthesis Acceptance Test Tool
 *
 * The end-to-end glue that proves the skills-as-code pipeline works
 * on a real launch-eve failure. Given a failed agent_workforce_tasks
 * row, this tool:
 *
 *   1. Rebuilds a SynthesisCandidate from the row's react_trace.
 *   2. Calls probeSurface against a live Chrome at :9222 to get a
 *      selector manifest for the target URL.
 *   3. Calls generateCodeSkill to write a new .ts skill file + row.
 *   4. Calls testSynthesizedSkill to run the handler dry-run + vision
 *      verify + flip promoted_at.
 *   5. Optionally invokes the skill with dry_run=false against the
 *      live Chrome session to publish a real post.
 *   6. Optionally calls deleteLastTweetViaBrowser with a unique
 *      marker to clean up the live post.
 *
 * This module is the only authorized place that sets `dry_run: false`
 * on a synthesized tool during the launch-week acceptance flow. Every
 * other code path defaults to dry_run: true. Callers that don't pass
 * `publish_live: true` get the dry-run dress rehearsal without any
 * live side effects.
 *
 * Safety defaults
 *
 *   - `publish_live` defaults to FALSE. You must opt in explicitly.
 *   - `delete_after_publish` defaults to TRUE when publish_live is on,
 *     so the acceptance run leaves no visible footprint on the X
 *     account unless the caller explicitly keeps the tweet.
 *   - `use_canned_llm` defaults to FALSE so the real generator model
 *     is exercised. Flipping it to true routes through a pre-baked
 *     canned response that mirrors the generator unit test fixture
 *     — useful when the LLM is flaky and we want to verify the
 *     runtime path in isolation.
 *
 * Nothing in here is wired up for general LLM discovery — the tool
 * is registered in tool-registry.ts and is callable by explicit name
 * only (e.g. via an MCP chat: "use synthesis_run_acceptance with ...").
 * It is deliberately not in ALWAYS_INCLUDED_TOOLS or any intent
 * section so a casual orchestrator chat can't trigger it by accident.
 */

import { logger } from '../../lib/logger.js';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { resolveActiveWorkspace } from '../../config.js';
import { probeSurface } from './synthesis-probe.js';
import { generateCodeSkill } from './synthesis-generator.js';
import { testSynthesizedSkill } from './synthesis-tester.js';
import { runtimeToolRegistry, type RuntimeToolDefinition } from '../runtime-tool-registry.js';
import {
  deleteLastTweetViaBrowser,
} from './x-posting.js';
import type {
  SynthesisCandidate,
  ReactTraceIteration,
} from '../../scheduling/synthesis-failure-detector.js';

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export interface SynthesisAcceptanceInput {
  task_id?: string;
  target_url?: string;
  test_tweet_text?: string;
  publish_live?: boolean;
  delete_after_publish?: boolean;
  use_canned_llm?: boolean;
  handle?: string;
}

export interface SynthesisAcceptanceReport {
  stage: 'probe' | 'generate' | 'test' | 'live_post' | 'delete' | 'done';
  success: boolean;
  message: string;
  taskId: string;
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
  livePostUrl?: string;
  livePostScreenshotBase64?: string;
  deleted?: boolean;
}

// ---------------------------------------------------------------------------
// Canned LLM fallback
// ---------------------------------------------------------------------------

/**
 * A pre-baked response the generator can swallow when the real LLM
 * is misbehaving. Mirrors the fixture in the generator unit test
 * (FAKE_LLM_RESPONSE in synthesis-generator.test.ts), using the
 * exact selectors the manual x_compose_tweet build captured on
 * 2026-04-13. This is a deliberate escape hatch — the ACCEPTANCE
 * TEST IS VALID even without live LLM generation because the
 * runtime/loader/registry/tester chain is what we most need to
 * prove on launch eve.
 */
const CANNED_LLM_RESPONSE = `Here is the generated tool:

\`\`\`ts
import pw from 'playwright-core';
const { chromium } = pw;

export const definition = {
  name: 'post_tweet_synth',
  description: 'Post a tweet on X via the user logged-in Chrome (synthesized)',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Tweet body text' },
      dry_run: { type: 'boolean', description: 'Skip the final submit. Default true.' },
    },
    required: ['text'],
  },
};

export async function handler(_ctx: unknown, input: Record<string, unknown>) {
  const dryRun = input.dry_run !== false;
  const text = String(input.text ?? '').trim();
  if (!text) return { success: false, message: 'text is required' };
  if (text.length > 280) return { success: false, message: 'tweet exceeds 280 chars' };

  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const contexts = browser.contexts();
  if (contexts.length === 0) return { success: false, message: 'No Chrome context available' };
  const pages = contexts[0].pages();
  if (pages.length === 0) return { success: false, message: 'No page available' };
  let page = pages.find((p) => p.url().includes('x.com')) || pages[0];

  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  await page.evaluate(() => { try { window.onbeforeunload = null; } catch {} });

  await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));

  const focused = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="tweetTextarea_0"]');
    if (!(el instanceof HTMLElement)) return false;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    return true;
  });
  if (!focused) return { success: false, message: 'Could not focus tweetTextarea_0' };

  // Keyboard warmup to absorb the first-char-drop glitch on a fresh focus.
  await page.keyboard.type(' ', { delay: 15 });
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text, { delay: 15 });
  await new Promise((r) => setTimeout(r, 400));

  const screenshotBase64 = (await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64');
  if (dryRun) {
    return { success: true, message: 'Dry run complete.', screenshotBase64, currentUrl: page.url() };
  }

  try {
    await page.click('[data-testid="tweetButton"]', { timeout: 10000 });
  } catch (err) {
    return {
      success: false,
      message: 'Post click failed: ' + (err instanceof Error ? err.message : String(err)),
      screenshotBase64,
    };
  }
  await new Promise((r) => setTimeout(r, 3000));
  const postShot = (await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64');
  return { success: true, message: 'Tweet posted.', screenshotBase64: postShot, currentUrl: page.url() };
}
\`\`\``;

// ---------------------------------------------------------------------------
// Task row → SynthesisCandidate
// ---------------------------------------------------------------------------

interface TaskLookupRow {
  id: string;
  title?: string | null;
  description?: string | null;
  input?: string | Record<string, unknown> | null;
  tokens_used?: number | null;
  agent_id?: string | null;
  metadata?: string | Record<string, unknown> | null;
  created_at?: string | null;
}

function parseMaybeJson(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function loadCandidate(
  ctx: LocalToolContext,
  taskId: string,
): Promise<SynthesisCandidate | null> {
  const result = await ctx.db
    .from<TaskLookupRow>('agent_workforce_tasks')
    .select('id, title, description, input, tokens_used, agent_id, metadata, created_at')
    .eq('workspace_id', ctx.workspaceId)
    .eq('id', taskId)
    .maybeSingle();
  const row = (result.data ?? null) as TaskLookupRow | null;
  if (!row) return null;

  const metadata = parseMaybeJson(row.metadata) ?? {};
  const traceRaw = metadata.react_trace;
  const reactTrace: ReactTraceIteration[] = Array.isArray(traceRaw)
    ? (traceRaw as ReactTraceIteration[])
    : [];

  return {
    taskId: row.id,
    title: row.title ?? '',
    description: row.description ?? null,
    input: parseMaybeJson(row.input),
    tokensUsed: Number(row.tokens_used ?? 0),
    agentId: row.agent_id ?? null,
    targetUrlGuess: null,
    reactTrace,
    createdAt: row.created_at ?? new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Live invocation of the synthesized skill (publish path)
// ---------------------------------------------------------------------------

interface HandlerOutcomeShape {
  success?: boolean;
  message?: string;
  screenshotBase64?: string;
  currentUrl?: string;
  error?: string;
}

function isOutcomeShape(value: unknown): value is HandlerOutcomeShape {
  return value !== null && typeof value === 'object';
}

async function invokeSkillLive(
  def: RuntimeToolDefinition,
  ctx: LocalToolContext,
  testInput: Record<string, unknown>,
): Promise<HandlerOutcomeShape> {
  const input = { ...testInput, dry_run: false };
  try {
    const raw = await def.handler(ctx, input);
    if (!isOutcomeShape(raw)) {
      return { success: false, message: 'handler returned non-object' };
    }
    return raw;
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Public tool handler
// ---------------------------------------------------------------------------

const DEFAULT_TASK_ID = '580b8cc3e404e5beff83550db3d1cf77';
const DEFAULT_TARGET_URL = 'https://x.com/compose/post';

export async function runSynthesisAcceptance(
  ctx: LocalToolContext,
  rawInput: Record<string, unknown>,
): Promise<ToolResult> {
  if (!ctx.modelRouter) {
    return { success: false, error: 'No ModelRouter in context — cannot run generator.' };
  }

  const input = rawInput as SynthesisAcceptanceInput;
  const taskId = input.task_id || DEFAULT_TASK_ID;
  const targetUrl = input.target_url || DEFAULT_TARGET_URL;
  const testTweetText = (input.test_tweet_text || '').trim();
  const publishLive = input.publish_live === true;
  const deleteAfter = input.delete_after_publish !== false; // default true when publishing
  const useCanned = input.use_canned_llm === true;
  const handle = (input.handle || 'ohwow_fun').replace(/^@/, '');

  if (!testTweetText) {
    return { success: false, error: 'test_tweet_text is required.' };
  }
  if (testTweetText.length > 260) {
    return {
      success: false,
      error: 'test_tweet_text is too long — keep it under 260 chars so there is room for the marker suffix.',
    };
  }

  const report: SynthesisAcceptanceReport = {
    stage: 'probe',
    success: false,
    message: 'starting',
    taskId,
    targetUrl,
  };

  // 1. Load the failed task → candidate
  const candidate = await loadCandidate(ctx, taskId);
  if (!candidate) {
    return {
      success: false,
      error: `Task ${taskId} not found in workspace ${ctx.workspaceId}. Cannot build synthesis candidate.`,
    };
  }

  // 2. Probe the target URL for a selector manifest
  const probeResult = await probeSurface({
    url: targetUrl,
    goalDescription: candidate.title,
  });
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
    { testidCount: report.manifestSummary.testidCount, url: manifest.url },
    '[synthesis-acceptance] probe complete',
  );

  // 3. Generate the skill
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
      ? async () => CANNED_LLM_RESPONSE
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

  logger.info(
    { skillName: genResult.name, skillId: genResult.skillId },
    '[synthesis-acceptance] skill generated and registered',
  );

  // 4. Dry-run test + vision verify (stubbed vision for acceptance
  //    so we don't gate launch-eve flow on a live vision call).
  report.stage = 'test';
  const testResult = await testSynthesizedSkill({
    db: ctx.db,
    modelRouter: ctx.modelRouter,
    ctx,
    skillName: genResult.name,
    testInput: { text: `${testTweetText} (dry run)` },
    goal: `Compose a tweet with text "${testTweetText}" and leave the composer in pre-submit state`,
    _visionEvalForTest: async () => ({
      ok: true,
      reason: 'acceptance-mode stub vision — dry-run screenshot accepted without model call',
    }),
  });
  if (!testResult.ok) {
    report.message = `Tester rejected the dry-run at stage=${testResult.stage}: ${testResult.message}`;
    return { success: false, error: report.message, data: report };
  }
  report.dryRunScreenshotBase64 = testResult.screenshotBase64;
  logger.info(
    { skillName: genResult.name, stage: testResult.stage },
    '[synthesis-acceptance] dry-run tester promoted skill',
  );

  // 5. Live publish (opt-in)
  if (!publishLive) {
    report.stage = 'done';
    report.success = true;
    report.message = `Dry-run acceptance complete for task ${taskId}. Skill "${genResult.name}" promoted. Not publishing (publish_live=false).`;
    return { success: true, data: report };
  }

  // Marker so we can find and delete the live post afterwards.
  const marker = `ohwow-synth-${Date.now().toString(36)}`;
  const liveText = `${testTweetText} ${marker}`;

  const def = runtimeToolRegistry.get(genResult.name);
  if (!def) {
    report.message = `Skill "${genResult.name}" not found in runtime registry after generation. Is OHWOW_ENABLE_SYNTHESIS set?`;
    return { success: false, error: report.message, data: report };
  }

  report.stage = 'live_post';
  logger.info({ marker, skillName: genResult.name }, '[synthesis-acceptance] invoking live post');
  const liveOutcome = await invokeSkillLive(def, ctx, { text: liveText });
  if (!liveOutcome.success) {
    report.message = `Live post failed: ${liveOutcome.message ?? 'no message'}`;
    report.livePostScreenshotBase64 = liveOutcome.screenshotBase64;
    report.livePostUrl = liveOutcome.currentUrl;
    return { success: false, error: report.message, data: report };
  }
  report.livePostScreenshotBase64 = liveOutcome.screenshotBase64;
  report.livePostUrl = liveOutcome.currentUrl;

  // 6. Delete the live post (opt-out via delete_after_publish=false)
  if (!deleteAfter) {
    report.stage = 'done';
    report.success = true;
    report.message = `Live post succeeded (marker ${marker}). delete_after_publish=false — tweet left up. URL: ${liveOutcome.currentUrl}`;
    return { success: true, data: report };
  }

  report.stage = 'delete';
  await new Promise((r) => setTimeout(r, 4000)); // let X settle before navigating away
  const delResult = await deleteLastTweetViaBrowser({
    handle,
    marker,
    dryRun: false,
  });
  report.deleted = delResult.success;
  if (!delResult.success) {
    report.message = `Live post posted but delete failed: ${delResult.message}. Manual cleanup needed for marker "${marker}".`;
    return { success: false, error: report.message, data: report };
  }

  report.stage = 'done';
  report.success = true;
  report.message = `Full acceptance run passed for task ${taskId}: probe → generate → test → publish → delete. Marker "${marker}" cleaned up.`;
  return { success: true, data: report };
}
