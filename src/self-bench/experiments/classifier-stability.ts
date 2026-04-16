/**
 * ClassifierStabilityExperiment — audits intra-handle consistency of
 * the x-authors-to-crm intent classifier.
 *
 * The intent classifier runs once per `x-authors-to-crm.mjs` pass
 * (hourly). For each author that passed the free gates, it emits one
 * row into `~/.ohwow/workspaces/<ws>/x-authors-classifier-log.jsonl`
 * with the verdict (intent, confidence, accepted). On the next pass,
 * that same author appears again if they haven't been promoted yet
 * (ledger.isQualified is false until a CRM contact is created), which
 * means the same handle can be classified multiple times over a few
 * hours.
 *
 * Observed surprise (2026-04-16): handle `analogdreamdev` was
 * classified `buyer_intent` conf 0.80 accepted=true at 19:54, then
 * `builder_curiosity` conf 0.75 accepted=false at 20:01. Same inputs,
 * seven minutes apart, two different fates. A qualified lead was
 * effectively dropped by classifier non-determinism.
 *
 * This experiment reads the log, groups by handle, and flags any
 * handle whose `accepted` boolean flipped across runs inside the
 * lookback window. A single flip is a warning — each flip is a
 * concrete qualified-lead risk, not a statistical ratio.
 *
 * Observer only. No intervention — the fix for flipping classifications
 * is a sticky-accept cache in `scripts/x-experiments/_qualify.mjs`, not
 * a runtime config knob this experiment can turn. This observer exists
 * to give the operator a visible "X handles are flipping this week"
 * signal so any regression after the cache lands shows up fast.
 *
 * Cadence 6h. The classifier runs hourly so 6h gives a 6-sample window;
 * more frequent probes just re-read the same JSONL lines.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../../lib/logger.js';
import {
  BusinessExperiment,
  type BusinessExperimentOptions,
} from '../business-experiment.js';
import type {
  ExperimentCadence,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';

const CADENCE: ExperimentCadence = { everyMs: 6 * 60 * 60 * 1000, runOnBoot: true };
const LOOKBACK_DAYS = 14;
/** Minimum multi-run handles needed before we call the signal meaningful. */
const MIN_MULTI_RUN_HANDLES_FOR_SIGNAL = 5;
/** Cap on top_offenders entries surfaced in evidence to keep the blob small. */
const TOP_OFFENDERS_CAP = 10;

interface ClassifierLogRow {
  ts?: string;
  workspace?: string;
  handle?: string;
  bucket?: string;
  score?: number;
  touches?: number;
  intent?: string;
  confidence?: number;
  accepted?: boolean;
  classify_error?: string | null;
}

interface HandleVerdict {
  ts: string;
  intent: string | null;
  confidence: number | null;
  accepted: boolean;
}

interface HandleSummary {
  handle: string;
  runs: number;
  intents_seen: string[];
  accepted_true_count: number;
  accepted_false_count: number;
  intent_flipped: boolean;
  accept_flipped: boolean;
  verdicts: HandleVerdict[];
}

export interface ClassifierStabilityEvidence extends Record<string, unknown> {
  affected_files: string[];
  window_days: number;
  log_rows_in_window: number;
  handles_total: number;
  handles_with_multi_runs: number;
  handles_intent_flipped: number;
  handles_accept_flipped: number;
  accept_flip_rate: number;
  top_offenders: HandleSummary[];
  __tracked_field: 'handles_accept_flipped';
}

function workspaceDir(slug: string): string {
  return path.join(os.homedir(), '.ohwow', 'workspaces', slug);
}

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    logger.debug({ err, filePath }, '[classifier-stability] read failed');
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function summariseHandle(handle: string, rows: ClassifierLogRow[]): HandleSummary {
  // classify_error rows don't carry a verdict — exclude from flip
  // detection so a transient LLM parse failure doesn't get counted as
  // "the model changed its mind." They still count as runs for
  // bookkeeping.
  const verdicts: HandleVerdict[] = rows
    .filter((r) => !r.classify_error)
    .map((r) => ({
      ts: r.ts ?? '',
      intent: r.intent ?? null,
      confidence: typeof r.confidence === 'number' ? r.confidence : null,
      accepted: r.accepted === true,
    }));
  const intentsSeen = Array.from(
    new Set(verdicts.map((v) => v.intent).filter((i): i is string => typeof i === 'string')),
  );
  const acceptedTrue = verdicts.filter((v) => v.accepted).length;
  const acceptedFalse = verdicts.filter((v) => !v.accepted).length;
  return {
    handle,
    runs: rows.length,
    intents_seen: intentsSeen,
    accepted_true_count: acceptedTrue,
    accepted_false_count: acceptedFalse,
    intent_flipped: intentsSeen.length >= 2,
    accept_flipped: acceptedTrue > 0 && acceptedFalse > 0,
    verdicts,
  };
}

export class ClassifierStabilityExperiment extends BusinessExperiment {
  readonly id = 'classifier-stability';
  readonly name = 'X authors classifier stability';
  readonly hypothesis =
    'The intent classifier in x-authors-to-crm is deterministic enough that a given author keeps the same `accepted` verdict across runs. Any handle that flips between accepted=true and accepted=false inside the lookback window is a concrete qualified-lead risk: the lucky run creates a CRM contact, the unlucky run silently drops them.';
  readonly cadence = CADENCE;

  constructor(opts: BusinessExperimentOptions = {}) {
    super(opts);
  }

  protected async businessProbe(ctx: ExperimentContext): Promise<ProbeResult> {
    const slug = ctx.workspaceSlug ?? this.allowedWorkspace;
    const logPath = path.join(workspaceDir(slug), 'x-authors-classifier-log.jsonl');
    const rows = readJsonl<ClassifierLogRow>(logPath);

    const sinceMs = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const inWindow = rows.filter((r) => {
      if (typeof r.handle !== 'string' || r.handle.length === 0) return false;
      const ts = r.ts ? Date.parse(r.ts) : NaN;
      return Number.isFinite(ts) && ts >= sinceMs;
    });

    const byHandle = new Map<string, ClassifierLogRow[]>();
    for (const row of inWindow) {
      const key = String(row.handle).toLowerCase();
      if (!byHandle.has(key)) byHandle.set(key, []);
      byHandle.get(key)!.push(row);
    }

    const summaries: HandleSummary[] = [];
    for (const [handle, handleRows] of byHandle) {
      summaries.push(summariseHandle(handle, handleRows));
    }
    const multiRun = summaries.filter((s) => s.runs >= 2);
    const intentFlipped = multiRun.filter((s) => s.intent_flipped);
    const acceptFlipped = multiRun.filter((s) => s.accept_flipped);

    // Rank offenders: accept-flip is strictly worse than intent-flip
    // (intent can shift between two non-accepted classes without
    // changing the lead-capture outcome), so sort accept-flipped
    // handles first, then by run count (more runs = more chances to
    // have flipped so more confident signal), then alphabetical for
    // stable ordering.
    const topOffenders = [...acceptFlipped, ...intentFlipped.filter((s) => !s.accept_flipped)]
      .sort((a, b) => b.runs - a.runs || a.handle.localeCompare(b.handle))
      .slice(0, TOP_OFFENDERS_CAP);

    const acceptFlipRate =
      multiRun.length === 0 ? 0 : acceptFlipped.length / multiRun.length;

    const evidence: ClassifierStabilityEvidence = {
      affected_files: ['scripts/x-experiments/_qualify.mjs'],
      window_days: LOOKBACK_DAYS,
      log_rows_in_window: inWindow.length,
      handles_total: summaries.length,
      handles_with_multi_runs: multiRun.length,
      handles_intent_flipped: intentFlipped.length,
      handles_accept_flipped: acceptFlipped.length,
      accept_flip_rate: Math.round(acceptFlipRate * 1000) / 1000,
      top_offenders: topOffenders,
      __tracked_field: 'handles_accept_flipped',
    };

    const summary =
      multiRun.length < MIN_MULTI_RUN_HANDLES_FOR_SIGNAL
        ? `${multiRun.length} multi-run handle(s) in ${LOOKBACK_DAYS}d (need ≥${MIN_MULTI_RUN_HANDLES_FOR_SIGNAL} for meaningful signal)`
        : acceptFlipped.length === 0
          ? `${multiRun.length} multi-run handle(s), 0 accept-flips — classifier stable`
          : `${acceptFlipped.length}/${multiRun.length} handle(s) flipped accept verdict (${(acceptFlipRate * 100).toFixed(0)}%); top=@${topOffenders[0]?.handle ?? ''}`;

    return { subject: 'classifier:stability', summary, evidence };
  }

  protected businessJudge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as ClassifierStabilityEvidence;
    if (ev.handles_with_multi_runs < MIN_MULTI_RUN_HANDLES_FOR_SIGNAL) return 'pass';
    if (ev.handles_accept_flipped > 0) return 'warning';
    return 'pass';
  }
}
