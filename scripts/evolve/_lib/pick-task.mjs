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
 * Gather rich context across all repos for the task-picker LLM prompt.
 */
async function gatherSmartContext({ repos }) {
  const sections = [];

  for (const repoPath of repos) {
    try {
      const repoName = path.basename(repoPath);

      // Recent commits (14 days — wider than the old 7-day window)
      const gitLog = safeExec('git log --oneline --since="14 days ago"', repoPath).slice(0, 800);

      // TODOs and FIXMEs
      const todos = safeExec(
        'grep -rn "TODO\\|FIXME" src --include="*.ts" --include="*.tsx" | grep -v node_modules | head -15',
        repoPath,
      ).slice(0, 600);

      // Test vs source file ratio
      const testCount = safeExec(
        'find src -name "*.test.ts" -o -name "*.test.tsx" | wc -l',
        repoPath,
      ).trim();
      const sourceCount = safeExec(
        'find src -name "*.ts" -o -name "*.tsx" | grep -v "\\.test\\." | grep -v "node_modules" | wc -l',
        repoPath,
      ).trim();

      // Source files that have no corresponding test file (up to 10 samples)
      const untestedFiles = safeExec(
        `find src -name "*.ts" ! -name "*.test.ts" ! -name "*.d.ts" | grep -v node_modules | while read f; do
          base=$(basename "$f" .ts);
          dir=$(dirname "$f");
          if ! find src -path "*__tests__*/${base}.test.ts" -o -path "*__tests__*/${base}.test.tsx" 2>/dev/null | grep -q .; then
            echo "$f";
          fi;
        done | head -10`,
        repoPath,
        20_000,
      ).trim();

      // Files untouched for 30+ days (stale code likely lacking coverage)
      const staleFiles = safeExec(
        `git log --name-only --format="" --since="30 days ago" -- 'src/**/*.ts' | sort -u > /tmp/_touched.txt 2>/dev/null; ` +
        `find src -name "*.ts" ! -name "*.test.ts" ! -name "*.d.ts" | grep -v node_modules | while read f; do ` +
        `grep -qF "$f" /tmp/_touched.txt 2>/dev/null || echo "$f"; done | head -8`,
        repoPath,
        20_000,
      ).trim();

      sections.push(
        `=== ${repoName} ===\n` +
        `GIT LOG (14d):\n${gitLog || '(none)'}\n\n` +
        `TODOs/FIXMEs:\n${todos || '(none)'}\n\n` +
        `Test files: ${testCount} / Source files: ${sourceCount}\n\n` +
        `Source files with no test counterpart (sample):\n${untestedFiles || '(all covered or check failed)'}\n\n` +
        `Source files untouched 30+ days:\n${staleFiles || '(all recently touched or check failed)'}`,
      );
    } catch (err) {
      sections.push(`=== ${path.basename(repoPath)} === (error gathering context: ${err.message})`);
    }
  }

  // Evolution history summary
  const summaryPath = path.join(os.homedir(), '.ohwow', 'evolution-reports', 'SUMMARY.md');
  if (fs.existsSync(summaryPath)) {
    const summary = fs.readFileSync(summaryPath, 'utf8').slice(0, 800);
    sections.push(`=== EVOLUTION HISTORY SUMMARY ===\n${summary}`);
  }

  // Ledger: last 5 entries (for avoiding exact repeats)
  const ledgerPath = path.join(os.homedir(), '.ohwow', 'evolution-reports', 'evolution-ledger.jsonl');
  if (fs.existsSync(ledgerPath)) {
    const recent = fs.readFileSync(ledgerPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-5)
      .join('\n');
    if (recent) sections.push(`=== RECENT LEDGER ENTRIES ===\n${recent}`);
  }

  // Market intel brief (buyer_intent + competitor_move items, latest day)
  const intelDir = path.join(os.homedir(), '.ohwow', 'workspaces', 'default', 'intel');
  try {
    if (fs.existsSync(intelDir)) {
      const latestDay = fs.readdirSync(intelDir)
        .filter(d => /^\d{4}-\d{2}-\d{2}/.test(d))
        .sort()
        .pop();
      if (latestDay) {
        const briefPath = path.join(intelDir, latestDay, 'briefs.json');
        if (fs.existsSync(briefPath)) {
          const briefs = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
          const intelLines = (Array.isArray(briefs) ? briefs : [])
            .filter(b => b.bucket === 'buyer_intent' || b.bucket === 'competitor_move')
            .slice(0, 3)
            .map(b => `[${b.bucket}] ${b.headline}`);
          if (intelLines.length) {
            sections.push(`=== MARKET INTEL (${latestDay}) ===\n${intelLines.join('\n')}`);
          }
        }
      }
    }
  } catch { /* non-fatal */ }

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

  const systemPrompt = `You are a senior engineer and product lead on the ohwow AI business OS platform.
Your job: read the codebase context below and propose ONE high-leverage product task that a Claude Code agent can complete autonomously in a single session.

PRIORITY ORDER — pick the highest-priority category that has available work:
1. Features that are half-built (TODOs in working code, stubs that return nothing, commented-out integrations)
2. Integrations between systems that exist but aren't connected (e.g., market intel exists but nothing reads it)
3. New API endpoints or routes that are clearly missing (the frontend references them but they don't exist)
4. Performance or reliability improvements to core paths (concurrency, error handling, retry logic)
5. Hardcoded values that should be config-driven (model names, URLs, magic numbers in hot paths)
6. Tests for critical business logic — ONLY if no higher-priority work exists

Do NOT pick:
- JSDoc / documentation-only tasks
- Renaming things or extracting constants from non-critical code
- Tasks that only add comments
- Anything that is purely cosmetic

Rules:
- The task MUST be VERIFIABLE within 5 minutes using a single shell command
- Each task MUST include a specific acceptanceCriteria list and a validationCmd
- No package.json changes
- No new npm dependencies
- No external service calls required during validation
- The targetRepo MUST be one of the repos listed in the context
- Do NOT repeat any task from the completed list
- Pick tasks that ship real value to the product

Return ONLY valid JSON (no markdown fences, no prose) in exactly this shape:
{
  "taskId": "unique-kebab-case-id",
  "title": "Short imperative title (under 80 chars)",
  "targetRepo": "/absolute/path/to/repo",
  "validationCmd": "npm run typecheck 2>&1 | tail -30",
  "description": "3-6 sentences: what problem this solves, which files to change, what to implement, and why it matters for the product.",
  "acceptanceCriteria": ["criterion 1", "criterion 2", "criterion 3"]
}`;

  const baseUserPrompt = `CONTEXT:\n${context}\n\nCOMPLETED TASK IDs (do not repeat): ${completedTaskIds.join(', ') || '(none)'}\n\nREPO PATHS AVAILABLE: ${repos.join(' | ')}\n\nPick the single highest-value task now.`;

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
