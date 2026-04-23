/**
 * Smart task picker for the self-evolution system.
 *
 * Priority:
 *   1. Seed tasks (SEED_TASKS) — returns the first uncompleted seed.
 *   2. Smart pick — when all seeds are done, calls Claude (haiku, cheap) to
 *      generate a fresh bounded task based on recent git history, TODOs, and
 *      the last few evolution-ledger entries.
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

  // 2. Smart pick: call Claude to generate a new task
  if (!anthropicApiKey) {
    console.warn('[pick-task] no Anthropic API key — cannot generate smart task');
    return null;
  }
  return await generateSmartTask({ completedTaskIds, anthropicApiKey, repos });
}

// ---------------------------------------------------------------------------
// Smart-pick: call Claude haiku to propose a new task
// ---------------------------------------------------------------------------

async function generateSmartTask({ completedTaskIds, anthropicApiKey, repos }) {
  const client = new Anthropic({ apiKey: anthropicApiKey });

  // Gather per-repo context (git log + TODOs)
  const contexts = [];
  for (const repoPath of repos) {
    try {
      const gitLog = execSync('git log --oneline --since="7 days ago"', {
        cwd: repoPath,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
      }).toString().slice(0, 1200);

      let todos = '';
      try {
        todos = execSync(
          'grep -rn "TODO\\|FIXME" src --include="*.ts" --include="*.tsx" | grep -v node_modules | head -20',
          { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'], shell: true, timeout: 10_000 },
        ).toString().slice(0, 1000);
      } catch { /* grep exits 1 when nothing found */ }

      contexts.push(`REPO: ${repoPath}\nRECENT COMMITS:\n${gitLog}\nTODOs:\n${todos}`);
    } catch (err) {
      contexts.push(`REPO: ${repoPath}\n(could not gather context: ${err.message})`);
    }
  }

  // Read recent evolution history (last 5 ledger entries)
  const ledgerPath = path.join(os.homedir(), '.ohwow', 'evolution-reports', 'evolution-ledger.jsonl');
  let history = '(none yet)';
  if (fs.existsSync(ledgerPath)) {
    const recent = fs.readFileSync(ledgerPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-5)
      .join('\n');
    if (recent) history = recent;
  }

  const prompt = `You are a senior engineer reviewing two repos and picking the next small, high-value improvement to make autonomously.

REPOS:
${contexts.join('\n\n')}

RECENT EVOLUTION HISTORY (last 5 ledger entries):
${history}

COMPLETED TASK IDs (do not repeat these): ${completedTaskIds.join(', ') || '(none)'}

Pick ONE concrete task. Return ONLY valid JSON (no markdown fences, no explanation) in this exact shape:
{
  "taskId": "unique-kebab-case-id",
  "title": "Short imperative title (under 80 chars)",
  "targetRepo": "/absolute/path/to/repo",
  "validationCmd": "npm run typecheck 2>&1 | tail -20",
  "description": "2-4 sentences explaining exactly what file(s) to change, what to change, and why.",
  "acceptanceCriteria": ["criterion 1", "criterion 2", "criterion 3"]
}

Rules for picking:
- Max 5 files changed
- Must be completable in under 100 lines of code
- No package.json changes
- No deletions of existing tests
- No new npm dependencies
- Prefer: fixing concrete TODOs, adding tests for untested pure functions, removing hardcoded values, adding JSDoc to public APIs
- The targetRepo MUST be one of: ${repos.join(' | ')}`;

  let text = '';
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    text = response.content[0]?.text ?? '';
  } catch (err) {
    throw new Error(`Smart task picker LLM call failed: ${err.message}`);
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Smart task picker returned no JSON. Raw response:\n${text.slice(0, 500)}`);
  }

  let task;
  try {
    task = JSON.parse(jsonMatch[0]);
  } catch (err) {
    throw new Error(`Smart task picker returned invalid JSON: ${err.message}\nRaw: ${jsonMatch[0].slice(0, 500)}`);
  }

  // Validate required fields
  const required = ['taskId', 'title', 'targetRepo', 'validationCmd', 'description', 'acceptanceCriteria'];
  for (const field of required) {
    if (!task[field]) throw new Error(`Smart task missing required field: ${field}`);
  }

  console.log(`[pick-task] smart pick generated task: ${task.taskId}`);
  return task;
}
