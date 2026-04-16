/**
 * Chrome profile event ledger — Piece 3 substrate.
 *
 * Append-only JSONL stream of "I asked Chrome for profile X and got
 * profile Y" events at every point chrome-lifecycle resolves a
 * profile. The browser-profile-guardian self-bench experiment reads
 * this ledger to spot mismatches the operator should know about
 * (typical case: a window for alice@example.com was requested but
 * Default kept winning because of a stale env var or a missing
 * alias).
 *
 * Filesystem layout matches the x-ops jsonl pattern so all per-
 * workspace observability streams live in one place:
 *   ~/.ohwow/workspaces/<slug>/chrome-profile-events.jsonl
 *
 * The file is fire-and-forget. Writes are best-effort — chrome
 * lifecycle is hot-path and must NOT fail because the disk is full
 * or the workspace dir is read-only. Errors are swallowed; the log
 * line at chrome-lifecycle's existing logger.info site stays as the
 * always-on signal.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../../lib/logger.js';

export interface ChromeProfileEvent {
  ts: string;
  source: 'attach' | 'spawn' | 'route';
  port: number;
  pid: number | null;
  expected_profile: string;
  resolved_profile: string;
  mismatch: boolean;
}

let resolvedSlug: string | null = null;

/** Override for tests. In production we read OHWOW_WORKSPACE / fall back. */
export function _setSlugForTests(slug: string | null): void {
  resolvedSlug = slug;
}

function resolveSlug(): string {
  if (resolvedSlug !== null) return resolvedSlug;
  return process.env.OHWOW_WORKSPACE || 'default';
}

function ledgerPathFor(slug: string): string {
  return path.join(os.homedir(), '.ohwow', 'workspaces', slug, 'chrome-profile-events.jsonl');
}

/**
 * Append one event row. Tolerant of missing directories — creates
 * the workspace ledger dir on demand. Tolerant of write errors —
 * never throws; logs at debug level on failure so production logs
 * stay clean.
 */
export async function appendChromeProfileEvent(event: Omit<ChromeProfileEvent, 'ts' | 'mismatch'>): Promise<void> {
  const slug = resolveSlug();
  const filePath = ledgerPathFor(slug);
  const row: ChromeProfileEvent = {
    ts: new Date().toISOString(),
    mismatch: event.expected_profile !== event.resolved_profile,
    ...event,
  };
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, JSON.stringify(row) + '\n', 'utf-8');
  } catch (err) {
    logger.debug({ err, filePath }, '[chrome-profile-ledger] append failed');
  }
}
