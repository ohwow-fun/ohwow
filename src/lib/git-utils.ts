/**
 * Git utilities for stale branch detection and git context injection.
 * All functions use execSync with short timeouts and graceful fallbacks.
 */

import { execSync } from 'child_process';

export interface GitContext {
  isGitRepo: boolean;
  branch: string;
  mainBranch: string;
  commitsBehindMain: number;
  uncommittedChanges: number;
  recentCommits: string[];
  remoteUrl?: string;
}

export interface StaleBranchResult {
  isStale: boolean;
  commitsBehind: number;
  mainBranch: string;
  currentBranch: string;
  recommendation: string;
}

const EXEC_OPTS = { timeout: 5000, stdio: 'pipe' as const, encoding: 'utf-8' as const };

function git(dir: string, args: string): string {
  return execSync(`git ${args}`, { ...EXEC_OPTS, cwd: dir }).trim();
}

/** Detect the primary branch name (main or master). */
export function detectMainBranch(dir: string): string {
  try {
    // Try symbolic-ref first (most reliable if remote is set)
    const ref = git(dir, 'symbolic-ref refs/remotes/origin/HEAD');
    const branch = ref.replace('refs/remotes/origin/', '');
    if (branch) return branch;
  } catch {
    // Fall through
  }

  // Check if 'main' or 'master' branch exists locally
  try {
    const branches = git(dir, 'branch --list main master');
    if (branches.includes('main')) return 'main';
    if (branches.includes('master')) return 'master';
  } catch {
    // Fall through
  }

  return 'main';
}

/** Get comprehensive git context for a directory. Returns null if not a git repo. */
export function getGitContext(dir: string): GitContext | null {
  try {
    git(dir, 'rev-parse --is-inside-work-tree');
  } catch {
    return null;
  }

  const mainBranch = detectMainBranch(dir);

  let branch = '';
  try {
    branch = git(dir, 'branch --show-current');
  } catch {
    branch = 'HEAD (detached)';
  }

  let uncommittedChanges = 0;
  try {
    const status = git(dir, 'status --porcelain');
    uncommittedChanges = status ? status.split('\n').filter(Boolean).length : 0;
  } catch {
    // Ignore
  }

  let commitsBehindMain = 0;
  try {
    if (branch && branch !== mainBranch) {
      const count = git(dir, `rev-list --count HEAD..origin/${mainBranch}`);
      commitsBehindMain = parseInt(count, 10) || 0;
    }
  } catch {
    // No remote tracking or fetch needed
  }

  let recentCommits: string[] = [];
  try {
    const log = git(dir, 'log --oneline -5 --no-decorate');
    recentCommits = log ? log.split('\n').filter(Boolean) : [];
  } catch {
    // Ignore
  }

  let remoteUrl: string | undefined;
  try {
    remoteUrl = git(dir, 'remote get-url origin') || undefined;
  } catch {
    // No remote
  }

  return {
    isGitRepo: true,
    branch,
    mainBranch,
    commitsBehindMain,
    uncommittedChanges,
    recentCommits,
    remoteUrl,
  };
}

/**
 * Check if the current branch is stale (behind main).
 * Returns null if not in a git repo or on the main branch.
 */
export function isStaleBranch(dir: string, threshold = 5): StaleBranchResult | null {
  const ctx = getGitContext(dir);
  if (!ctx || !ctx.isGitRepo) return null;
  if (ctx.branch === ctx.mainBranch || ctx.branch === 'HEAD (detached)') return null;

  const isStale = ctx.commitsBehindMain >= threshold;
  let recommendation = '';
  if (isStale) {
    recommendation = `Branch "${ctx.branch}" is ${ctx.commitsBehindMain} commits behind ${ctx.mainBranch}. Consider running "git rebase origin/${ctx.mainBranch}" or "git merge origin/${ctx.mainBranch}".`;
  }

  return {
    isStale,
    commitsBehind: ctx.commitsBehindMain,
    mainBranch: ctx.mainBranch,
    currentBranch: ctx.branch,
    recommendation,
  };
}
