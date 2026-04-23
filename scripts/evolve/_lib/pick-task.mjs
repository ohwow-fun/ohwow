/**
 * Smart task picker for the self-evolution system.
 *
 * Priority:
 *   1. Seed tasks (SEED_TASKS) — returns the first uncompleted seed.
 *   2. Smart pick — when all seeds are done, calls GLM-5.1 (cheap) to
 *      generate a fresh bounded task based on recent git history, TODOs,
 *      test coverage gaps, and market intel from the evolution system.
 */
import Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pick the next task to run.
 *
 * @param {object} opts
 * @param {string[]} opts.completedTaskIds   Task IDs already in the ledger.
 * @param {Array}   opts.seedTasks           The SEED_TASKS array.
 * @param {string|null} opts.anthropicApiKey Anthropic key for smart-pick fallback.
 * @param {string[]} opts.repos              Absolute paths to repos to scan.
 * @returns {Promise<object|null>} Next task object, or null when nothing to do.
 */
export async function pickNextTask({ completedTaskIds, seedTasks, anthropicApiKey, repos }) {
  // 1. Try seed tasks first
  const nextSeed = seedTasks.find(t => !completedTaskIds.includes(t.taskId));
  if (nextSeed) return nextSeed;

  // 2. Smart pick: call Claude to generate a new task.
  // resolveClientAndModel() handles OpenRouter fallback, so we only bail if
  // there is truly no credential available anywhere.
  const hasAnyCreds =
    anthropicApiKey ||
    process.env.ANTHROPIC_API_KEY ||
    (() => {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ohwow', 'config.json'), 'utf8'));
        return cfg.openRouterApiKey || cfg.anthropicApiKey;
      } catch { return false; }
    })();
  if (!hasAnyCreds) {
    console.warn('[pick-task] no API key found anywhere — cannot generate smart task');
    return null;
  }
  return await generateSmartTask({ completedTaskIds, anthropicApiKey, repos });
}

// ---------------------------------------------------------------------------
// Context gathering helpers
// ---------------------------------------------------------------------------

/**
 * Safe exec wrapper — returns empty string instead of throwing.
 */
function safeExec(cmd, cwd, timeoutMs = 15_000) {
  try {
    return execSync(cmd, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      timeout: timeoutMs,
    }).toString();
  } catch {
    return '';
  }
}

/**
 * Read workspace CRM/pipeline state via the daemon REST API.
 * Returns a summary string for the task-picker prompt.
 */
async function gatherWorkspaceState() {
  const tokenPath = path.join(os.homedir(), '.ohwow', 'workspaces', 'default', 'daemon.token');
  if (!fs.existsSync(tokenPath)) return '(daemon not running — no workspace state)';

  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  const base = 'http://localhost:7700';
  const headers = { Authorization: `Bearer ${token}` };

  async function get(endpoint) {
    try {
      const res = await fetch(`${base}${endpoint}`, { headers, signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  const lines = [];

  // Active deals (pipeline health)
  const deals = await get('/api/deals?limit=10');
  if (deals?.data?.length) {
    lines.push('ACTIVE DEALS (CRM pipeline):');
    for (const d of deals.data.slice(0, 6)) {
      const val = d.value_cents ? `$${(d.value_cents / 100).toFixed(0)}` : '?';
      lines.push(`  [${d.stage_name}] ${d.title} — ${val} — close ${d.expected_close || '?'}`);
      if (d.notes) lines.push(`    Notes: ${d.notes.slice(0, 120)}`);
    }
  }

  // Recent market intel buyer signals
  const intelDir = path.join(os.homedir(), '.ohwow', 'workspaces', 'default', 'intel');
  try {
    if (fs.existsSync(intelDir)) {
      const latestDay = fs.readdirSync(intelDir)
        .filter(d => /^\d{4}-\d{2}-\d{2}/.test(d)).sort().pop();
      if (latestDay) {
        const briefPath = path.join(intelDir, latestDay, 'briefs.json');
        if (fs.existsSync(briefPath)) {
          const briefs = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
          const signals = (Array.isArray(briefs) ? briefs : [])
            .filter(b => b.bucket === 'buyer_intent' || b.bucket === 'competitor_move')
            .slice(0, 4);
          if (signals.length) {
            lines.push(`\nMARKET INTEL SIGNALS (${latestDay}):`);
            for (const s of signals) lines.push(`  [${s.bucket}] ${s.headline}`);
          }
        }
      }
    }
  } catch { /* non-fatal */ }

  // Pending agent tasks (what the workspace is trying to do)
  const tasks = await get('/api/tasks?status=pending&limit=8');
  if (tasks?.data?.length) {
    lines.push('\nPENDING WORKSPACE TASKS:');
    for (const t of tasks.data.slice(0, 5)) {
      lines.push(`  [${t.priority || 'normal'}] ${t.title}`);
    }
  }

  return lines.length ? lines.join('\n') : '(no workspace CRM data available)';
}

/**
 * Gather rich context across all repos for the task-picker LLM prompt.
 */
async function gatherSmartContext({ repos }) {
  const sections = [];

  // Workspace business state (money/relations context) — gathered first so it shapes priorities
  try {
    const wsState = await gatherWorkspaceState();
    sections.push(`=== WORKSPACE BUSINESS STATE ===\n${wsState}`);
  } catch { /* non-fatal */ }

  for (const repoPath of repos) {
    try {
      const repoName = path.basename(repoPath);

      // Recent commits (14 days)
      const gitLog = safeExec('git log --oneline --since="14 days ago"', repoPath).slice(0, 600);

      // TODOs and FIXMEs — focus on money/relations paths
      const todos = safeExec(
        'grep -rn "TODO\\|FIXME\\|STUB" src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -iv "test\\|spec\\|jsdoc\\|comment\\|placeholder" | head -12',
        repoPath,
      ).slice(0, 500);

      // Half-built integrations (return stubs, unimplemented methods)
      const stubs = safeExec(
        'grep -rn "return \\[\\]\\|return {}\\|return null\\|throw new Error.*not impl\\|TODO.*wire\\|NOT IMPLEMENTED" src --include="*.ts" | grep -v node_modules | grep -v "\\.test\\." | head -10',
        repoPath,
      ).slice(0, 400);

      sections.push(
        `=== ${repoName} ===\n` +
        `GIT LOG (14d):\n${gitLog || '(none)'}\n\n` +
        `TODOs/FIXMEs (non-test):\n${todos || '(none)'}\n\n` +
        `Stubs / half-built (return [], {}, null):\n${stubs || '(none)'}`,
      );
    } catch (err) {
      sections.push(`=== ${path.basename(repoPath)} === (error: ${err.message})`);
    }
  }

  // Evolution history — last 5 entries
  const ledgerPath = path.join(os.homedir(), '.ohwow', 'evolution-reports', 'evolution-ledger.jsonl');
  if (fs.existsSync(ledgerPath)) {
    const recent = fs.readFileSync(ledgerPath, 'utf8')
      .split('\n').filter(Boolean).slice(-5).join('\n');
    if (recent) sections.push(`=== RECENT EVOLUTION LEDGER ===\n${recent}`);
  }

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Smart-pick: call GLM-5.1 to propose a new task
// ---------------------------------------------------------------------------

/**
 * Resolve an Anthropic client from the available credentials.
 * Resolution order (mirrors implement.mjs):
 *   1. anthropicApiKey arg — direct Anthropic key
 *   2. ANTHROPIC_API_KEY env var
 *   3. openRouterApiKey from ~/.ohwow/config.json (via OpenRouter)
 *   4. anthropicApiKey from ~/.ohwow/config.json
 *
 * @returns {{ client: Anthropic, model: string }}
 */
function resolveClientAndModel(anthropicApiKey) {
  if (anthropicApiKey && anthropicApiKey.startsWith('sk-ant-')) {
    return { client: new Anthropic({ apiKey: anthropicApiKey }), model: 'z-ai/glm-5.1' };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), model: 'z-ai/glm-5.1' };
  }
  const configPath = path.join(os.homedir(), '.ohwow', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cfg.openRouterApiKey) {
        return {
          client: new Anthropic({
            apiKey: cfg.openRouterApiKey,
            baseURL: 'https://openrouter.ai/api',
            defaultHeaders: {
              'HTTP-Referer': 'https://ohwow.fun',
              'X-Title': 'ohwow self-evolution',
            },
          }),
          model: 'z-ai/glm-5.1',
        };
      }
      if (cfg.anthropicApiKey) {
        return { client: new Anthropic({ apiKey: cfg.anthropicApiKey }), model: 'z-ai/glm-5.1' };
      }
    } catch { /* non-fatal */ }
  }
  throw new Error('No API key found for smart task picker. Set ANTHROPIC_API_KEY or configure openRouterApiKey in ~/.ohwow/config.json');
}

async function generateSmartTask({ completedTaskIds, anthropicApiKey, repos }) {
  const { client, model } = resolveClientAndModel(anthropicApiKey);

  const context = await gatherSmartContext({ repos });

  const systemPrompt = `You are the autonomous engineering arm of ohwow — an AI business OS. You read the workspace business state, CRM pipeline, market signals, and codebase to decide what to build next.

PRIORITY FRAMEWORK — always pick the highest tier with available work:

TIER 1 — MONEY (highest priority):
  - Anything that directly enables revenue collection or unblocks a deal from progressing
  - Payment flows, billing endpoints, invoice generation, pricing pages
  - Outreach sending (email/SMS/WhatsApp) that is blocked by a missing integration
  - Conversion-blocking bugs in onboarding, signup, or checkout
  - Deal automation: auto-advance stages, follow-up triggers, CRM → outreach pipeline
  - Market intel signals (buyer_intent) → actionable outreach tasks

TIER 2 — RELATIONS (second priority):
  - Features that strengthen or automate prospect/customer relationships
  - CRM integrations: contact enrichment, interaction logging, lead scoring
  - Communication channels: Gmail auth, WhatsApp business, calendar scheduling
  - Follow-up automation: sequence triggers, reminder scheduling, reply detection
  - Onboarding flows that are incomplete or returning empty state

TIER 3 — PLUMBING (lowest priority):
  - Infrastructure that directly unblocks Tier 1 or Tier 2 work
  - Missing API endpoints that the dashboard calls but don't exist
  - Half-built features: stubs returning [], {}, or null where real data is expected
  - Type errors in hot paths (deals, contacts, tasks, outreach routes)
  - Config-driven model/URL constants replacing hardcoded values

NEVER pick:
  - JSDoc, comments, or documentation-only tasks
  - Test files unless they test a Tier 1/2 feature AND no higher-priority work exists
  - Renaming, refactoring, or extracting constants for non-critical code
  - Tasks with no path to revenue or relationship impact

TASK SHAPE RULES (critical for the implementing agent):
  - The description MUST name the EXACT file(s) to change and the EXACT code to write
  - Do NOT write "Steps: 1. grep... 2. read... 3. understand..." — the agent will loop 20 times and write nothing
  - DO write "Create file X with this exact content: [code]" or "Edit file X, replace line Y with [code]"
  - The description should be self-contained: no exploration required before implementing
  - validationCmd must exit 0 when the task is done correctly

Return ONLY valid JSON (no markdown fences, no prose) in exactly this shape:
{
  "taskId": "unique-kebab-case-id",
  "title": "Short imperative title (under 80 chars)",
  "targetRepo": "/absolute/path/to/repo",
  "validationCmd": "npm run typecheck 2>&1 | tail -30",
  "description": "Concrete implementation instructions with exact file paths and exact code to write. 4-8 sentences.",
  "acceptanceCriteria": ["criterion 1", "criterion 2", "criterion 3"]
}`;

  const baseUserPrompt = `CONTEXT:\n${context}\n\nCOMPLETED TASK IDs (do not repeat): ${completedTaskIds.join(', ') || '(none)'}\n\nREPO PATHS AVAILABLE: ${repos.join(' | ')}\n\nLook at the workspace business state first. What deals are stuck? What outreach is blocked? What market signals need actioning? Then look at the code to find the shortest path to unblocking revenue or strengthening customer relationships. Pick the single highest-value task now — money > relations > plumbing.`;

  const MAX_ATTEMPTS = 3;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const userPrompt = attempt === 1
      ? baseUserPrompt
      : baseUserPrompt + '\n\nIMPORTANT: only reference files that actually exist in the listed repos. Do not invent class names or file paths.';

    let text = '';
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });
      text = response.content[0]?.text ?? '';
    } catch (err) {
      throw new Error(`Smart task picker LLM call failed: ${err.message}`);
    }

    // Strip optional markdown fences before extracting JSON
    const stripped = text.replace(/```(?:json)?/g, '').replace(/```/g, '');
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      lastError = new Error(`Smart task picker returned no JSON. Raw response:\n${text.slice(0, 500)}`);
      continue;
    }

    let task;
    try {
      task = JSON.parse(jsonMatch[0]);
    } catch (err) {
      lastError = new Error(`Smart task picker returned invalid JSON: ${err.message}\nRaw: ${jsonMatch[0].slice(0, 500)}`);
      continue;
    }

    // Apply sensible defaults for any missing fields rather than crashing
    const repoFallback = repos[0] ?? '';
    task.taskId = task.taskId
      ? `${task.taskId}-${Date.now().toString(36)}`
      : `smart-task-${Date.now().toString(36)}`;
    task.title = task.title ?? 'Untitled smart task';
    task.targetRepo = task.targetRepo ?? repoFallback;
    task.validationCmd = task.validationCmd ?? 'npm run typecheck 2>&1 | tail -20';
    task.description = task.description ?? '(no description provided)';
    if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0) {
      task.acceptanceCriteria = ['Validation command exits 0'];
    }

    // Ensure targetRepo is one of the declared repos (guard against hallucinated paths)
    if (!repos.includes(task.targetRepo)) {
      console.warn(`[pick-task] targetRepo "${task.targetRepo}" not in repos list — defaulting to ${repoFallback}`);
      task.targetRepo = repoFallback;
    }

    // Verify any src/-relative file paths mentioned in the task actually exist
    if (!verifyTask(task, repos)) {
      lastError = new Error(`Smart task references non-existent paths (attempt ${attempt})`);
      continue;
    }

    console.log(`[pick-task] smart pick generated task: ${task.taskId}`);
    return task;
  }

  throw lastError ?? new Error('Smart task picker failed after max attempts');
}

// ---------------------------------------------------------------------------
// Path verification — guard against hallucinated file/class references
// ---------------------------------------------------------------------------

function verifyTask(task, repos) {
  // If description or acceptanceCriteria mentions a src/-relative path, verify it exists
  const text = (task.description ?? '') + ' ' + (task.acceptanceCriteria ?? []).join(' ');
  const pathRefs = text.match(/src\/[\w/.-]+\.tsx?/g) ?? [];

  for (const ref of pathRefs) {
    const found = repos.some(r => fs.existsSync(path.join(r, ref)));
    if (!found) {
      console.warn(`[pick-task] smart task references non-existent path: ${ref} — regenerating`);
      return false;
    }
  }
  return true;
}
