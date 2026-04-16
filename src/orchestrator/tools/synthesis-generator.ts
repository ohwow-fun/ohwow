/**
 * Synthesis Generator — LLM-driven code-skill creator
 *
 * Given a failing task (from the synthesis failure detector) and a
 * selector manifest (from the synthesis probe), call a cheap model
 * with a strict template to emit a deterministic TypeScript tool,
 * write it to the workspace skills dir, insert a matching
 * agent_workforce_skills row, and trigger the runtime loader so the
 * tool becomes hot-available on the next orchestrator turn.
 *
 * Design choices
 *
 *   - Strict output format: the prompt demands a single ```ts fenced
 *     code block. No prose, no explanation. We parse the first fence
 *     we see and drop everything else. Any text the model volunteers
 *     outside the fence is ignored.
 *
 *   - Lint before write: the generated source is run through the same
 *     FORBIDDEN_SOURCE_PATTERNS regex list the runtime loader uses at
 *     load time. On lint failure the file never hits disk, no skill
 *     row is inserted, and the caller sees a clear rejection reason.
 *     Defense in depth — we don't trust the model to respect its
 *     allowlist just because we asked.
 *
 *   - DB row before file: the skill row is inserted FIRST with the
 *     eventual script_path already set. Only after the row is in
 *     place do we write the .ts file. This ordering matters because
 *     the runtime skill loader's fs.watch will fire as soon as the
 *     file appears, and the loader refuses to register a source that
 *     has no backing row. Insert-then-write gives the loader a row
 *     to match against on its very first scan.
 *
 *   - Cheap model by default: picked via the `generation` purpose
 *     on runLlmCall, with difficulty='moderate' so the router lands
 *     on FAST/BALANCED tier (qwen/qwen3.5-35b-a3b or deepseek-v3.2).
 *     Never STRONG — the 408k-token launch-eve failure is the
 *     archetype we're replacing, and it ran on STRONG.
 *
 *   - Hot load if a loader is active: after writing the file, we
 *     call getActiveRuntimeSkillLoader()?.loadFile() directly so the
 *     tool is registered immediately, not after the 120ms watcher
 *     debounce. The M8 acceptance test depends on this — it needs
 *     to run the synthesized handler in the same turn it was made.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';
import { runLlmCall } from '../../execution/llm-organ.js';
import type { ModelRouter } from '../../execution/model-router.js';
import {
  getActiveRuntimeSkillLoader,
  lintSkillSource,
} from '../runtime-skill-loader.js';
import { runtimeToolRegistry } from '../runtime-tool-registry.js';
import type { SelectorManifest } from './synthesis-probe.js';
import type { SynthesisCandidate } from '../../scheduling/synthesis-failure-detector.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerateSkillInput {
  db: DatabaseAdapter;
  workspaceId: string;
  modelRouter: ModelRouter;
  candidate: SynthesisCandidate;
  manifest: SelectorManifest;
  skillsDir: string;
  /**
   * Override the model route used by the generator. Default: router
   * picks FAST/BALANCED via purpose='generation' + difficulty='moderate'.
   */
  preferModel?: string;
  /**
   * Inject the LLM call function so unit tests can drive the generator
   * with a canned TypeScript response without hitting a real model.
   * Production callers leave this undefined.
   */
  _llmCallForTest?: (prompt: string, system: string) => Promise<string>;
}

export interface GenerateSkillOk {
  ok: true;
  skillId: string;
  name: string;
  scriptPath: string;
  modelUsed?: string;
  source: string;
  /**
   * True when the generator short-circuited because a promoted skill
   * with the same name already existed. `source` is the on-disk
   * content of the existing file in that case, not fresh LLM output.
   */
  reused?: boolean;
}

export interface GenerateSkillErr {
  ok: false;
  error: string;
  stage: 'llm' | 'parse' | 'lint' | 'write' | 'db';
  rawResponse?: string;
}

export type GenerateSkillResult = GenerateSkillOk | GenerateSkillErr;

// ---------------------------------------------------------------------------
// Prompt template
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a code generator for ohwow, a local-first AI runtime. Your job is to turn a failed ReAct trace into a deterministic TypeScript tool the runtime can call in one shot instead of looping an LLM.

You output a SINGLE TypeScript file as a fenced code block labeled \`\`\`ts. No prose before or after the block. No comments explaining what you did. The runtime parses the first \`\`\`ts fence it sees and discards everything else.

The file MUST:

1. Import ONLY from 'playwright-core'. No other imports. No Node built-ins other than what playwright-core re-exports. No node:fs, no node:child_process, no node:http, no eval, no Function().

2. Export a \`definition\` const of shape:
   {
     name: string (snake_case, starts with a letter, matches /^[a-z][a-z0-9_]*$/);
     description: string;
     input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
   }

3. Export an async \`handler\` function of signature:
   async function handler(_ctx: unknown, input: Record<string, unknown>): Promise<{ success: boolean; message: string; screenshotBase64?: string; currentUrl?: string }>

4. The handler MUST:
   - Default \`input.dry_run\` to TRUE. Only perform the final submit action when input.dry_run === false.
   - Connect to Chrome via \`chromium.connectOverCDP('http://localhost:9222')\` and pick a page by FLATTENING all contexts (see skeleton) — NOT \`browser.contexts()[0]\`, which silently picks an arbitrary Chrome profile and can land an unauthed window on the target site.
   - Prefer a page whose URL already matches the target host; otherwise pick the first non-sensitive existing page. Never call \`context.newPage()\` — that also picks an arbitrary profile.
   - Use ONLY the selectors listed in the provided manifest. Do not invent selectors.
   - Call \`page.keyboard.type()\` to enter text (not execCommand, not element.value =).
   - Call \`page.click(selector)\` — never \`element.click()\` — so React onClick handlers fire.
   - Return a screenshot base64 on every exit path (success AND failure).
   - Tolerate the target page being in any state by navigating explicitly before the first action.

5. The handler MUST NOT:
   - Use process.exit, child_process, node:net, node:http, raw sockets, or any fs.* write/delete.
   - Swallow errors silently — on thrown errors, return { success: false, message } with the error string.
   - Reference any globals other than console, Buffer, URL, and the imported chromium.

The template below is the expected skeleton. Follow it exactly. Fill in the bracketed placeholders.`;

const TEMPLATE_SKELETON = `\`\`\`ts
import pw from 'playwright-core';
const { chromium } = pw;

export const definition = {
  name: '[snake_case_name]',
  description: '[one-sentence description of what this tool does]',
  input_schema: {
    type: 'object',
    properties: {
      // e.g. text: { type: 'string', description: 'What to type' },
      dry_run: { type: 'boolean', description: 'Skip the final submit action. Default true.' },
    },
    required: [],
  },
};

export async function handler(_ctx: unknown, input: Record<string, unknown>) {
  const dryRun = input.dry_run !== false;
  // [extract inputs with defaults and type coercion]

  const browser = await chromium.connectOverCDP('http://localhost:9222');
  // Flatten pages across ALL Chrome contexts. Playwright collapses
  // each debug-Chrome profile into its own BrowserContext, and
  // [contexts()[0]] picks whichever profile was enumerated first —
  // frequently the unauthenticated Default profile. Prefer a page
  // already on the target host (any profile) before falling back.
  const pages = browser.contexts().flatMap((c) => c.pages());
  if (pages.length === 0) return { success: false, message: 'No page available' };
  let page = pages.find((p) => p.url().includes('[host-hint]')) || pages[0];

  page.on('dialog', (d) => { d.accept().catch(() => {}); });

  await page.goto('[target-url]', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));

  // [focus input → type text → screenshot → optionally click submit]

  const screenshotBase64 = (await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64');

  if (dryRun) {
    return { success: true, message: 'Dry run complete.', screenshotBase64, currentUrl: page.url() };
  }

  // [click the submit button selector from the manifest]

  await new Promise((r) => setTimeout(r, 2500));
  const postShot = (await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64');
  return { success: true, message: 'Action submitted.', screenshotBase64: postShot, currentUrl: page.url() };
}
\`\`\``;

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildUserPrompt(candidate: SynthesisCandidate, manifest: SelectorManifest): string {
  const traceSummary = candidate.reactTrace
    .slice(0, 3)
    .map((iter) => {
      const tools = (iter.actions || []).map((a) => a.tool || 'unknown').join(', ');
      return `- iter ${iter.iteration ?? '?'}: ${tools || '(no tool calls)'}`;
    })
    .join('\n');

  const manifestForPrompt = {
    url: manifest.url,
    pageTitle: manifest.pageTitle,
    testidElements: manifest.testidElements.map((el) => ({
      selector: el.selector,
      tag: el.tag,
      role: el.role,
      placeholder: el.placeholder,
      text: el.textContent?.slice(0, 60) ?? '',
      disabled: el.disabled,
      isTextInput: el.isTextInput,
      isButton: el.isButton,
    })),
    formElements: manifest.formElements.map((el) => ({
      selector: el.selector,
      tag: el.tag,
      type: el.type,
      placeholder: el.placeholder,
      ariaLabel: el.ariaLabel,
    })),
    contentEditables: manifest.contentEditables.map((el) => ({
      selector: el.selector,
      role: el.role,
      ariaLabel: el.ariaLabel,
    })),
    observations: manifest.observations,
  };

  return [
    `# Goal`,
    candidate.title,
    candidate.description ? `\n${candidate.description}` : '',
    ``,
    `# Task input that originally failed`,
    '```json',
    JSON.stringify(candidate.input ?? {}, null, 2),
    '```',
    ``,
    `# Target URL`,
    manifest.url,
    ``,
    `# Selector manifest (use ONLY these selectors)`,
    '```json',
    JSON.stringify(manifestForPrompt, null, 2),
    '```',
    ``,
    `# Summary of what the previous attempt tried (DO NOT repeat this shape)`,
    traceSummary || '(no trace available)',
    `Tokens burned on that attempt: ${candidate.tokensUsed}`,
    ``,
    `# Template skeleton you MUST follow`,
    TEMPLATE_SKELETON,
    ``,
    `Now output the complete TypeScript file. Start with \`\`\`ts and end with \`\`\`.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

const TS_FENCE_REGEX = /```(?:ts|typescript)\s*([\s\S]*?)```/i;
const NAME_REGEX = /name:\s*['"`]([a-z][a-z0-9_]*)['"`]/;

function extractTsBlock(raw: string): string | null {
  const match = raw.match(TS_FENCE_REGEX);
  if (match) return match[1].trim();
  // Fallback: if the whole response looks like TS (starts with `import`),
  // accept it verbatim. This handles models that ignore the fence rule.
  if (/^\s*import\s/.test(raw)) return raw.trim();
  return null;
}

function extractSkillName(source: string): string | null {
  const match = source.match(NAME_REGEX);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// DB row insert
// ---------------------------------------------------------------------------

function newSkillId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return `skill_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Collision handling
// ---------------------------------------------------------------------------

/**
 * Row shape returned by the name-collision lookup. We only care about
 * the fields that drive the branching decision: whether a row with
 * this name already exists, whether it was promoted, and where its
 * source lives on disk. A separate interface keeps the cast to
 * `DatabaseAdapter.from<T>` honest.
 */
interface ExistingSkillRow {
  id: string;
  name: string;
  script_path: string | null;
  promoted_at: string | null;
}

/**
 * Look up an active code skill by `workspace + name`. If the DB has
 * more than one active row with the same name (which shouldn't
 * happen post-collision-fix but can linger from pre-fix runs), return
 * the most recently promoted one; the promoted row is the canonical
 * answer. If none are promoted, return the newest unpromoted row.
 */
async function findExistingSkillByName(
  db: DatabaseAdapter,
  workspaceId: string,
  name: string,
): Promise<ExistingSkillRow | null> {
  try {
    const result = await db
      .from<ExistingSkillRow>('agent_workforce_skills')
      .select('id, name, script_path, promoted_at')
      .eq('workspace_id', workspaceId)
      .eq('name', name)
      .eq('skill_type', 'code')
      .eq('is_active', 1)
      .limit(10);
    const rows = (result.data ?? []) as ExistingSkillRow[];
    if (rows.length === 0) return null;
    const promoted = rows.filter((r) => Boolean(r.promoted_at));
    if (promoted.length > 0) {
      // Most recently promoted wins.
      promoted.sort((a, b) => (b.promoted_at ?? '').localeCompare(a.promoted_at ?? ''));
      return promoted[0];
    }
    return rows[0];
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, workspaceId, name },
      '[synthesis-generator] failed to look up existing skill by name',
    );
    return null;
  }
}

/**
 * Deactivate an unpromoted predecessor so the new generation attempt
 * doesn't collide at the DB level. Also evict the old tool from the
 * runtime registry, if present, so the new file's register() call
 * doesn't trip the "name collision" guard in the registry. The old
 * .ts file stays on disk for forensic purposes — the loader's boot
 * scan filters on is_active=1 so it'll be skipped on next restart.
 */
async function retireExistingSkill(
  db: DatabaseAdapter,
  row: ExistingSkillRow,
): Promise<void> {
  try {
    await db
      .from('agent_workforce_skills')
      .update({ is_active: 0, updated_at: new Date().toISOString() })
      .eq('id', row.id);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, skillId: row.id },
      '[synthesis-generator] failed to deactivate predecessor row',
    );
  }
  runtimeToolRegistry.unregister(row.name);
}

async function insertSkillRow(
  db: DatabaseAdapter,
  row: {
    id: string;
    workspaceId: string;
    name: string;
    description: string;
    scriptPath: string;
    selectors: string;
    originTraceId: string;
    inputSchema: string;
    modelUsed: string;
  },
): Promise<void> {
  await db.from('agent_workforce_skills').insert({
    id: row.id,
    workspace_id: row.workspaceId,
    name: row.name,
    description: row.description,
    skill_type: 'code',
    source_type: 'synthesized',
    definition: JSON.stringify({
      input_schema: JSON.parse(row.inputSchema),
      generator_model: row.modelUsed,
      manifest_version: 1,
    }),
    agent_ids: '[]',
    pattern_support: 0,
    is_active: 1,
    script_path: row.scriptPath,
    selectors: row.selectors,
    origin_trace_id: row.originTraceId,
    success_count: 0,
    fail_count: 0,
    promoted_at: null,
    triggers: '[]',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function generateCodeSkill(input: GenerateSkillInput): Promise<GenerateSkillResult> {
  const system = SYSTEM_PROMPT;
  const prompt = buildUserPrompt(input.candidate, input.manifest);

  // Step 1: LLM call
  let rawResponse: string;
  let modelUsed = 'test-stub';
  try {
    if (input._llmCallForTest) {
      rawResponse = await input._llmCallForTest(prompt, system);
    } else {
      const result = await runLlmCall(
        {
          modelRouter: input.modelRouter,
          db: input.db,
          workspaceId: input.workspaceId,
        },
        {
          purpose: 'generation',
          prompt,
          system,
          max_tokens: 4096,
          temperature: 0.2,
          difficulty: 'moderate',
          prefer_model: input.preferModel,
        },
      );
      if (!result.ok) {
        return { ok: false, stage: 'llm', error: result.error };
      }
      rawResponse = result.data.text;
      modelUsed = result.data.model_used;
    }
  } catch (err) {
    return {
      ok: false,
      stage: 'llm',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Step 2: Parse the fenced code block
  const source = extractTsBlock(rawResponse);
  if (!source) {
    return {
      ok: false,
      stage: 'parse',
      error: 'Generator output did not contain a ```ts fenced block or a bare TypeScript import.',
      rawResponse,
    };
  }

  const skillName = extractSkillName(source);
  if (!skillName) {
    return {
      ok: false,
      stage: 'parse',
      error: 'Generator output did not declare a snake_case `name` field in `definition`.',
      rawResponse,
    };
  }

  // Step 3: Lint
  const lint = lintSkillSource(source, `<generator-output for ${skillName}>`);
  if (!lint.ok) {
    return { ok: false, stage: 'lint', error: lint.reason, rawResponse };
  }

  // Step 3b: Collision check against agent_workforce_skills.
  //
  // If an active code skill with this exact name already exists and
  // was promoted by the tester, short-circuit: return the existing
  // skill without writing a new file or inserting a new row. The
  // caller gets a `reused: true` flag so it can tell the difference
  // between "fresh generation" and "no-op, you already had this".
  //
  // If an active row exists but was never promoted, it's a stale
  // failed attempt — deactivate it, evict it from the runtime
  // registry, and proceed to write the new row + file.
  const existing = await findExistingSkillByName(input.db, input.workspaceId, skillName);
  if (existing && existing.promoted_at) {
    logger.info(
      { skillName, existingId: existing.id },
      '[synthesis-generator] promoted skill with this name already exists, reusing',
    );
    return {
      ok: true,
      skillId: existing.id,
      name: skillName,
      scriptPath: existing.script_path ?? '',
      modelUsed,
      source,
      reused: true,
    };
  }
  if (existing && !existing.promoted_at) {
    logger.info(
      { skillName, retiredId: existing.id },
      '[synthesis-generator] retiring unpromoted predecessor before regeneration',
    );
    await retireExistingSkill(input.db, existing);
  }

  // Step 4: Filenames + DB insert
  const skillId = newSkillId();
  const slug = `${skillName}_${skillId.slice(0, 8)}`;
  const scriptPath = resolve(input.skillsDir, `${slug}.ts`);

  try {
    await insertSkillRow(input.db, {
      id: skillId,
      workspaceId: input.workspaceId,
      name: skillName,
      description: `Synthesized tool for goal: ${input.candidate.title.slice(0, 120)}`,
      scriptPath,
      selectors: JSON.stringify({
        testidElements: input.manifest.testidElements,
        formElements: input.manifest.formElements,
        contentEditables: input.manifest.contentEditables,
      }),
      originTraceId: input.candidate.taskId,
      inputSchema: extractInputSchemaJson(source) ?? JSON.stringify({ type: 'object', properties: {} }),
      modelUsed,
    });
  } catch (err) {
    return {
      ok: false,
      stage: 'db',
      error: `Failed to insert skill row: ${err instanceof Error ? err.message : String(err)}`,
      rawResponse,
    };
  }

  // Step 5: Write the file (row is in place, so the watcher / manual
  // loadFile call can find its backing row).
  try {
    await mkdir(input.skillsDir, { recursive: true });
    await writeFile(scriptPath, source, 'utf8');
  } catch (err) {
    return {
      ok: false,
      stage: 'write',
      error: `Failed to write skill file: ${err instanceof Error ? err.message : String(err)}`,
      rawResponse,
    };
  }

  // Step 6: Immediate hot load via the active loader, if one exists.
  // Gracefully degrade if the daemon is running with synthesis
  // disabled — the caller will have to drive the loader themselves.
  const loader = getActiveRuntimeSkillLoader();
  if (loader) {
    try {
      await loader.loadFile(scriptPath);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, scriptPath },
        '[synthesis-generator] hot load failed (caller must load manually)',
      );
    }
  }

  logger.info(
    { skillId, skillName, scriptPath, modelUsed },
    '[synthesis-generator] synthesized skill registered',
  );

  return {
    ok: true,
    skillId,
    name: skillName,
    scriptPath,
    modelUsed,
    source,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const INPUT_SCHEMA_REGEX = /input_schema:\s*(\{[\s\S]*?\}),?\s*\n\s*\}/m;

/**
 * Best-effort extract the input_schema object from the source so we
 * can store it in the DB's definition field. Parsing TS source with
 * regex is gross, but we only need it for indexing; if it fails we
 * fall back to an empty schema and the caller just has the file on
 * disk as the source of truth.
 */
function extractInputSchemaJson(source: string): string | null {
  const match = source.match(INPUT_SCHEMA_REGEX);
  if (!match) return null;
  // Naive transform: convert single-quoted keys to double-quoted,
  // drop trailing commas. This is a best-effort loose conversion —
  // if the generator emits a cleaner JSON-ish literal we keep it,
  // otherwise the DB just gets an empty fallback.
  try {
    // Collapse the TS object literal to something JSON.parse can
    // handle: remove trailing commas, quote unquoted keys, swap
    // single-quote strings for double-quoted.
    let cleaned = match[1]
      .replace(/\/\/[^\n]*\n/g, '\n')
      .replace(/([,{]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":')
      .replace(/'([^']*)'/g, '"$1"')
      .replace(/,(\s*[}\]])/g, '$1');
    // The regex captured up to the outer closing brace; ensure it's
    // balanced by walking through and trimming to the last balanced
    // close brace.
    let depth = 0;
    let end = -1;
    for (let i = 0; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end > 0) cleaned = cleaned.slice(0, end);
    JSON.parse(cleaned); // validate
    return cleaned;
  } catch {
    return null;
  }
}

export function resolveSkillPath(skillsDir: string, slug: string): string {
  return join(skillsDir, `${slug}.ts`);
}
