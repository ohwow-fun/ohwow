/**
 * Repo state assessment for the self-evolution system.
 * Reads git log, test status, and context for task picking.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Assess the current state of a repo.
 * Returns a structured object with git log, status, and basic metrics.
 * All sub-operations use try/catch — failures return partial data, not crashes.
 */
export async function assessRepo(repoPath) {
  const assessment = {
    repoPath,
    timestamp: new Date().toISOString(),
    gitLog: [],
    gitStatus: '',
    todoCount: 0,
    fixmeCount: 0,
    latestIntelBrief: null,
    errors: [],
  };

  // Git log — last 7 days
  try {
    const raw = execSync('git log --oneline --since="7 days ago"', {
      cwd: repoPath,
      timeout: 15_000,
      encoding: 'utf8',
    });
    assessment.gitLog = raw.trim().split('\n').filter(Boolean);
  } catch (err) {
    assessment.errors.push(`git log failed: ${err.message}`);
  }

  // Git status
  try {
    const raw = execSync('git status --short', {
      cwd: repoPath,
      timeout: 10_000,
      encoding: 'utf8',
    });
    assessment.gitStatus = raw.trim();
  } catch (err) {
    assessment.errors.push(`git status failed: ${err.message}`);
  }

  // Count TODO/FIXME occurrences in tracked files
  try {
    const todoRaw = execSync(
      'git grep -c "TODO\\|FIXME" -- "*.ts" "*.tsx" "*.mjs" "*.js" 2>/dev/null | wc -l',
      { cwd: repoPath, timeout: 20_000, encoding: 'utf8', shell: true },
    );
    assessment.todoCount = parseInt(todoRaw.trim(), 10) || 0;
  } catch {
    // non-fatal — grep exits non-zero when no matches
    assessment.todoCount = 0;
  }

  // Read latest intel brief if available (ohwow repo only)
  try {
    const intelBase = path.join(
      os.homedir(), '.ohwow', 'workspaces', 'default', 'intel',
    );
    if (fs.existsSync(intelBase)) {
      const today = new Date().toISOString().slice(0, 10);
      const briefPath = path.join(intelBase, today, 'briefs.json');
      if (fs.existsSync(briefPath)) {
        const raw = fs.readFileSync(briefPath, 'utf8');
        const parsed = JSON.parse(raw);
        // Summarize to a small footprint
        assessment.latestIntelBrief = {
          date: today,
          bucketCounts: Object.fromEntries(
            Object.entries(parsed).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]),
          ),
        };
      }
    }
  } catch {
    // non-fatal
  }

  return assessment;
}

/**
 * Load the evolution history ledger.
 * Returns an array of past run records (parsed JSONL).
 */
export async function loadEvolutionHistory(reportsDir) {
  const ledgerPath = path.join(reportsDir, 'evolution-ledger.jsonl');
  if (!fs.existsSync(ledgerPath)) return [];

  const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
  return lines.map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}
