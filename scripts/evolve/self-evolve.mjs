#!/usr/bin/env node
/**
 * Self-evolving code improvement system.
 * Runs as an ohwow automation every 4 hours.
 * Picks the next bounded task, implements it via Claude, validates, commits, reports.
 *
 * Usage:
 *   node scripts/evolve/self-evolve.mjs
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/**
 * Try to resolve an Anthropic API key. If none found, returns null —
 * implementTask() will fall back to OpenRouter automatically.
 */
function resolveApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const configPath = path.join(os.homedir(), '.ohwow', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.anthropicApiKey) return config.anthropicApiKey;
      // Return the OpenRouter key so pickNextTask's credential guard passes;
      // both implementTask and generateSmartTask handle OpenRouter routing internally.
      if (config.openRouterApiKey) return config.openRouterApiKey;
    } catch {}
  }
  return null; // both implementTask and pick-task will use OpenRouter fallback
}

function resolveCompletedTasks() {
  const ledgerPath = path.join(os.homedir(), '.ohwow', 'evolution-reports', 'evolution-ledger.jsonl');
  if (!fs.existsSync(ledgerPath)) return [];

  return fs.readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter(e => e.status === 'success')
    .map(e => e.taskId);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

async function validate(repoPath, cmd) {
  // Clear stale incremental tsc cache to prevent false negatives after lint-staged revert
  if (repoPath.endsWith('/ohwow')) {
    const tsbuildinfo = path.join(repoPath, 'tsconfig.tsbuildinfo');
    try { fs.unlinkSync(tsbuildinfo); } catch {}
  }

  try {
    execSync(cmd, { cwd: repoPath, stdio: 'pipe', timeout: 120_000, shell: true });
    return { pass: true };
  } catch (err) {
    const stdout = err.stdout?.toString() || '';
    const stderr = err.stderr?.toString() || '';
    return { pass: false, output: (stdout + stderr).slice(0, 4000) };
  }
}

// ---------------------------------------------------------------------------
// Git commit — stage ONLY the files the LLM changed (not git add -A)
// ---------------------------------------------------------------------------

function gitCommit(repoPath, changedFiles, message) {
  if (changedFiles.length === 0) {
    throw new Error('No files to commit');
  }
  for (const f of changedFiles) {
    try {
      execSync(`git add "${f}"`, { cwd: repoPath, stdio: 'pipe' });
    } catch (err) {
      console.warn(`[self-evolve] git add failed for ${f}: ${err.message}`);
    }
  }
  // Write message to a temp file so newlines are preserved (avoids literal \n in subject)
  const msgFile = path.join(os.tmpdir(), `evolve-commit-msg-${Date.now()}.txt`);
  fs.writeFileSync(msgFile, message);
  try {
    execSync(`git commit -s -F "${msgFile}"`, { cwd: repoPath, stdio: 'pipe' });
  } finally {
    try { fs.unlinkSync(msgFile); } catch {}
  }
  return execSync('git rev-parse --short HEAD', { cwd: repoPath }).toString().trim();
}

function gitRevert(repoPath, changedFiles) {
  // Restore tracked files that were modified
  try {
    execSync('git checkout -- .', { cwd: repoPath, stdio: 'pipe' });
  } catch {}
  // Remove new untracked files that were created by the LLM
  if (Array.isArray(changedFiles)) {
    for (const f of changedFiles) {
      try {
        // Only remove if it's untracked (not in git index)
        const status = execSync(`git status --porcelain "${f}"`, { cwd: repoPath, encoding: 'utf8' }).trim();
        if (status.startsWith('??')) {
          fs.rmSync(f, { force: true });
          // Also remove empty parent dirs created for the file
          try { fs.rmdirSync(path.dirname(f)); } catch {}
        }
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`[self-evolve] starting cycle at ${new Date().toISOString()}`);

  const apiKey = resolveApiKey();

  const { SEED_TASKS } = await import('./_lib/task-definitions.mjs');
  const { implementTask } = await import('./_lib/implement.mjs');
  const { writeRunReport } = await import('./_lib/report.mjs');
  const { pickNextTask } = await import('./_lib/pick-task.mjs');

  const completedTaskIds = resolveCompletedTasks();
  console.log(`[self-evolve] completed tasks: ${completedTaskIds.join(', ') || '(none)'}`);

  const REPOS = [
    '/Users/jesus/Documents/ohwow/ohwow',
    '/Users/jesus/Documents/ohwow/ohwow.fun',
  ];

  const nextTask = await pickNextTask({
    completedTaskIds,
    seedTasks: SEED_TASKS,
    anthropicApiKey: apiKey,
    repos: REPOS,
  });

  if (!nextTask) {
    console.log('[self-evolve] no task available this cycle (seeds exhausted, smart-pick unavailable).');
    writeRunReport({ status: 'idle', task: null, filesChanged: [], summary: 'No task available' });
    return;
  }

  console.log(`[self-evolve] selected task: ${nextTask.taskId}`);
  console.log(`[self-evolve] title: ${nextTask.title}`);
  console.log(`[self-evolve] repo: ${nextTask.targetRepo}`);

  // Implement
  let implResult;
  try {
    implResult = await implementTask(nextTask, { anthropicApiKey: apiKey });
  } catch (err) {
    console.error(`[self-evolve] implementation error: ${err.message}`);
    writeRunReport({ status: 'error', task: nextTask, filesChanged: [], summary: err.message });
    process.exit(1);
  }

  console.log(`[self-evolve] implementation done:`);
  console.log(`  files changed: ${implResult.filesChanged.length} — ${implResult.filesChanged.join(', ') || '(none)'}`);
  console.log(`  iterations: ${implResult.iterations}`);

  if (implResult.filesChanged.length === 0) {
    console.warn('[self-evolve] no files were written — task may have been already complete or failed silently');
    writeRunReport({ status: 'noop', task: nextTask, filesChanged: [], summary: implResult.summary });
    return;
  }

  // Validate
  console.log(`[self-evolve] validating with: ${nextTask.validationCmd}`);
  const validation = await validate(nextTask.targetRepo, nextTask.validationCmd);

  if (!validation.pass) {
    console.warn('[self-evolve] validation FAILED — reverting changes');
    if (validation.output) console.warn(validation.output.slice(0, 1000));
    gitRevert(nextTask.targetRepo, implResult.filesChanged);
    writeRunReport({
      status: 'failed',
      task: nextTask,
      filesChanged: implResult.filesChanged,
      validation,
      summary: implResult.summary,
    });
    process.exit(1);
  }

  console.log('[self-evolve] validation passed');

  // Commit
  const commitMsg = `${nextTask.title}\n\n[self-evolution task ${nextTask.taskId}]`;
  let hash;
  try {
    hash = gitCommit(nextTask.targetRepo, implResult.filesChanged, commitMsg);
    console.log(`[self-evolve] committed: ${hash}`);
  } catch (err) {
    console.error(`[self-evolve] commit failed: ${err.message}`);
    writeRunReport({
      status: 'commit-failed',
      task: nextTask,
      filesChanged: implResult.filesChanged,
      validation,
      summary: implResult.summary,
    });
    process.exit(1);
  }

  writeRunReport({
    status: 'success',
    task: nextTask,
    filesChanged: implResult.filesChanged,
    validation,
    commit: { hash, message: commitMsg },
    summary: implResult.summary,
  });

  console.log(`[self-evolve] cycle complete. commit=${hash}`);
  console.log(`[self-evolve] report written to ~/.ohwow/evolution-reports/`);
}

main().catch(err => {
  console.error(`[self-evolve] fatal: ${err.message}`);
  process.exit(1);
});
