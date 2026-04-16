/**
 * BrowserProfileGuardianExperiment — Piece 3 of the surprise-first bundle.
 *
 * Watches the chrome-profile-events.jsonl ledger that chrome-lifecycle
 * appends to on every Chrome attach/spawn. Counts how often the
 * resolved profile diverges from the requested one over the last 6h,
 * groups mismatches by (expected_profile, resolved_profile), and emits
 * a single finding per tick.
 *
 * Verdict logic:
 *   pass    — no mismatches in lookback window
 *   warning — at least one mismatch
 *   fail    — mismatch rate ≥ 50% of recent events (most launches
 *             land on the wrong profile — almost certainly a stale
 *             OHWOW_CHROME_PROFILE env or a missing chromeProfileAlias)
 *
 * Surfaces via the standard Piece 1 distiller: each finding carries a
 * tracked_field of `mismatch_rate_6h` so the surprise primitive can
 * z-score sudden spikes vs the rolling baseline. The first mismatch
 * after a long pass streak shows up as either verdict_flipped or
 * first_seen on the distilled view.
 *
 * The experiment is observer-only in v1. It does NOT auto-correct
 * the profile — that decision belongs to the operator, who may have
 * an intentional reason for the env override. The surprise signal is
 * the deliverable.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { logger } from '../../lib/logger.js';

const PROBE_EVERY_MS = 5 * 60 * 1000;
const LOOKBACK_HOURS = 6;
/** Mismatch rate above which we promote warning → fail. */
const FAIL_RATE = 0.5;
/** Minimum events in the window required to compute a meaningful rate. */
const MIN_SAMPLES = 3;

interface ChromeProfileEvent {
  ts?: string;
  source?: 'attach' | 'spawn' | 'route';
  port?: number;
  pid?: number | null;
  expected_profile?: string;
  resolved_profile?: string;
  mismatch?: boolean;
}

interface MismatchPair {
  expected: string;
  resolved: string;
  count: number;
}

export interface BrowserProfileGuardianEvidence extends Record<string, unknown> {
  events_in_window: number;
  mismatches_in_window: number;
  mismatch_rate_6h: number;
  pairs: MismatchPair[];
  ledger_present: boolean;
  __tracked_field: 'mismatch_rate_6h';
}

function ledgerPathFor(slug: string): string {
  return path.join(os.homedir(), '.ohwow', 'workspaces', slug, 'chrome-profile-events.jsonl');
}

function readEvents(slug: string, sinceMs: number): { events: ChromeProfileEvent[]; ledgerPresent: boolean } {
  const filePath = ledgerPathFor(slug);
  if (!fs.existsSync(filePath)) {
    return { events: [], ledgerPresent: false };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    logger.debug({ err, filePath }, '[browser-profile-guardian] read failed');
    return { events: [], ledgerPresent: true };
  }
  const events: ChromeProfileEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as ChromeProfileEvent;
      if (typeof ev.ts !== 'string') continue;
      const ts = Date.parse(ev.ts);
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
      events.push(ev);
    } catch {
      // Skip malformed lines silently — JSONL appenders can race.
    }
  }
  return { events, ledgerPresent: true };
}

function summarisePairs(events: ChromeProfileEvent[]): MismatchPair[] {
  const counts = new Map<string, number>();
  for (const ev of events) {
    if (!ev.mismatch) continue;
    const key = `${ev.expected_profile ?? '?'}→${ev.resolved_profile ?? '?'}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => {
      const [expected, resolved] = key.split('→');
      return { expected, resolved, count };
    })
    .sort((a, b) => b.count - a.count);
}

export class BrowserProfileGuardianExperiment implements Experiment {
  readonly id = 'browser-profile-guardian';
  readonly name = 'Browser profile guardian';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    'Chrome lifecycle launches always resolve to the requested profile. A mismatch (e.g. alice@example.com requested → Default opened) is a real-world surprise the operator should know about within minutes.';
  readonly cadence = { everyMs: PROBE_EVERY_MS, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const slug = ctx.workspaceSlug ?? 'default';
    const sinceMs = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
    const { events, ledgerPresent } = readEvents(slug, sinceMs);
    const mismatches = events.filter((e) => e.mismatch);
    const rate = events.length === 0 ? 0 : mismatches.length / events.length;
    const pairs = summarisePairs(events);

    const evidence: BrowserProfileGuardianEvidence = {
      events_in_window: events.length,
      mismatches_in_window: mismatches.length,
      mismatch_rate_6h: rate,
      pairs,
      ledger_present: ledgerPresent,
      __tracked_field: 'mismatch_rate_6h',
    };

    let summary: string;
    if (!ledgerPresent) {
      summary = 'no chrome-profile-events.jsonl yet (no Chrome activity)';
    } else if (events.length === 0) {
      summary = 'no Chrome launches in last 6h';
    } else if (mismatches.length === 0) {
      summary = `${events.length} Chrome launch(es), all on requested profile`;
    } else {
      const topPair = pairs[0];
      summary = `${mismatches.length}/${events.length} launches on wrong profile; top: ${topPair?.expected}→${topPair?.resolved} ×${topPair?.count}`;
    }

    return { subject: 'chrome-profile:summary', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as BrowserProfileGuardianEvidence;
    if (ev.events_in_window < MIN_SAMPLES) return 'pass';
    if (ev.mismatches_in_window === 0) return 'pass';
    if (ev.mismatch_rate_6h >= FAIL_RATE) return 'fail';
    return 'warning';
  }
}
