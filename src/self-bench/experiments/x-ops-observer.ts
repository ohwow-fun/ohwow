/**
 * XOpsObserverExperiment — Layer 4 of the bench level-up plan.
 *
 * The richest business surface on a dogfood workspace — the X
 * (Twitter) intelligence + compose pipeline — writes all of its
 * activity to JSONL ledgers under the workspace data directory. Until
 * now, no experiment reads those files. The loop was blind to whether
 * posts dispatch at all, whether a shape is over- or under-represented,
 * whether the intel scheduler has stalled, or whether engagement on
 * recent posts is trending up or down.
 *
 * This experiment closes the blind spot as an observer. It reads:
 *   - x-approvals.jsonl     — every outbound proposal + its status
 *   - x-posts-<today>.jsonl — collected feed posts with likes/replies
 *   - x-intel-last-run.json — last x-intel scheduler tick metadata
 *
 * and emits a single finding per tick with structured evidence. No
 * intervene — that's Layer 5's job (x-shape-tuner). Think of this layer
 * as the `content-cadence-tuner` probe half, just for X shape/timing
 * signal, without yet touching a knob.
 *
 * Cadence 20 min. Reads are fs-only, no git, no DB — cheap enough to
 * run often. stale_since_hours flips to a warning when x-intel hasn't
 * produced a run in over 6 h on an active workspace.
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

const PROBE_EVERY_MS = 20 * 60 * 1000;
/** Anything older than this is ignored for freshness rollups. */
const APPROVALS_LOOKBACK_HOURS = 48;
/** Fail threshold — if x-intel hasn't ticked in this long, something is wrong. */
const INTEL_FAIL_STALE_HOURS = 24;
/** Warning threshold for x-intel staleness. */
const INTEL_WARN_STALE_HOURS = 6;
/** Minimum approvals to compute a dispatch_success_rate; below this we don't rate-limit. */
const MIN_APPROVALS_FOR_RATE = 5;
/** Warning floor for dispatch rate. */
const DISPATCH_SUCCESS_WARN = 0.9;
/** Fail floor for dispatch rate — below this something is structurally broken. */
const DISPATCH_SUCCESS_FAIL = 0.5;

interface Approval {
  id?: string;
  ts?: string;
  kind?: string;
  status?: string;
  payload?: {
    shape?: string;
    seed_bucket?: string;
    post_text?: string;
    draft?: string;
  };
  notes?: string;
}

interface PostRow {
  permalink?: string;
  bucket?: string;
  likes?: number;
  replies?: number;
  first_seen_ts?: string;
  score?: number;
}

interface IntelLastRun {
  ts?: string;
  exitCode?: number;
  durationMs?: number;
}

export interface XOpsObserverEvidence extends Record<string, unknown> {
  workspace_slug: string;
  ledger_dir: string;
  posts_24h: number;
  approvals_counted: number;
  approvals_by_status: Record<string, number>;
  approvals_by_kind: Record<string, number>;
  shape_distribution: Record<string, number>;
  dispatch_success_rate: number | null;
  approval_ratio: number | null;
  top_buckets: Array<{ bucket: string; count: number }>;
  engagement_median_likes: number | null;
  engagement_median_replies: number | null;
  intel_last_run_ts: string | null;
  intel_last_run_ok: boolean | null;
  intel_last_run_age_hours: number | null;
  stale_since_hours: number | null;
  notes: string[];
}

/** Read a jsonl file, tolerating missing files + broken lines. */
function readJsonl<T>(absPath: string): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      // Silently skip malformed rows; JSONL shouldn't die on one corrupt line.
    }
  }
  return out;
}

/** Median for a numeric array; null when empty. */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

/**
 * Best-effort shape extractor. Payloads vary by kind:
 *   - outbound post: payload.shape OR derived from payload.post_text
 *   - reply:         no shape (bucketed as 'reply')
 *   - knowledge_upload: no shape (bucketed as 'upload')
 * We don't re-derive shape from text here; if the payload doesn't say,
 * count under kind-based bucket so the distribution stays honest.
 */
function classifyApproval(a: Approval): { kind: string; shape: string } {
  const kind = a.kind ?? 'unknown';
  const payloadShape = a.payload?.shape;
  if (typeof payloadShape === 'string' && payloadShape.length > 0) {
    return { kind, shape: payloadShape };
  }
  if (kind === 'reply') return { kind, shape: 'reply' };
  if (kind === 'knowledge_upload') return { kind, shape: 'upload' };
  return { kind, shape: 'unknown' };
}

/**
 * Compute the observer's evidence from the ledger directory. Split out
 * so unit tests can feed a temp directory without spinning the daemon's
 * workspace resolver.
 */
export function computeEvidence(
  ledgerDir: string,
  workspaceSlug: string,
  nowMs: number = Date.now(),
): XOpsObserverEvidence {
  const notes: string[] = [];
  const approvalsPath = path.join(ledgerDir, 'x-approvals.jsonl');
  const intelLastPath = path.join(ledgerDir, 'x-intel-last-run.json');

  // Today's posts file, per x-intel naming convention
  // x-posts-YYYY-MM-DD.jsonl
  const d = new Date(nowMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const postsPath = path.join(ledgerDir, `x-posts-${yyyy}-${mm}-${dd}.jsonl`);

  const cutoffMs = nowMs - APPROVALS_LOOKBACK_HOURS * 3600 * 1000;
  const twentyFourHAgoMs = nowMs - 24 * 3600 * 1000;

  const allApprovals = readJsonl<Approval>(approvalsPath);
  const approvals = allApprovals.filter((a) => {
    if (typeof a.ts !== 'string') return false;
    const tsMs = Date.parse(a.ts);
    if (!Number.isFinite(tsMs)) return false;
    return tsMs >= cutoffMs;
  });

  const posts = readJsonl<PostRow>(postsPath);

  const approvalsByStatus: Record<string, number> = {};
  const approvalsByKind: Record<string, number> = {};
  const shapeDistribution: Record<string, number> = {};
  let applied = 0;
  let rejected = 0;
  let outboundTotal = 0;
  for (const a of approvals) {
    const status = a.status ?? 'unknown';
    approvalsByStatus[status] = (approvalsByStatus[status] ?? 0) + 1;
    const { kind, shape } = classifyApproval(a);
    approvalsByKind[kind] = (approvalsByKind[kind] ?? 0) + 1;
    shapeDistribution[shape] = (shapeDistribution[shape] ?? 0) + 1;
    if (kind === 'x_outbound_post' || kind === 'reply') {
      outboundTotal += 1;
      if (status === 'applied') applied += 1;
      if (status === 'rejected') rejected += 1;
    }
  }
  const dispatchResolved = applied + rejected;
  const dispatchSuccessRate = dispatchResolved >= MIN_APPROVALS_FOR_RATE
    ? applied / dispatchResolved
    : null;
  const approvalRatio = outboundTotal >= MIN_APPROVALS_FOR_RATE
    ? applied / outboundTotal
    : null;

  const posts24h = posts.filter((p) => {
    if (typeof p.first_seen_ts !== 'string') return true; // count liberally
    const tsMs = Date.parse(p.first_seen_ts);
    return !Number.isFinite(tsMs) || tsMs >= twentyFourHAgoMs;
  });
  const likes = posts24h
    .map((p) => (typeof p.likes === 'number' ? p.likes : null))
    .filter((x): x is number => x !== null);
  const replies = posts24h
    .map((p) => (typeof p.replies === 'number' ? p.replies : null))
    .filter((x): x is number => x !== null);

  const bucketCounts: Record<string, number> = {};
  for (const p of posts24h) {
    const b = p.bucket ?? 'unknown';
    bucketCounts[b] = (bucketCounts[b] ?? 0) + 1;
  }
  const topBuckets = Object.entries(bucketCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([bucket, count]) => ({ bucket, count }));

  let intelLastRun: IntelLastRun | null = null;
  try {
    intelLastRun = JSON.parse(fs.readFileSync(intelLastPath, 'utf-8')) as IntelLastRun;
  } catch {
    // x-intel may not have ticked yet; leave null.
  }
  const intelTsMs = intelLastRun?.ts ? Date.parse(intelLastRun.ts) : NaN;
  const intelAgeHours = Number.isFinite(intelTsMs)
    ? (nowMs - intelTsMs) / 3600_000
    : null;
  const intelOk = intelLastRun ? intelLastRun.exitCode === 0 : null;

  if (intelLastRun === null) notes.push('intel-last-run missing');
  if (posts24h.length === 0) notes.push('no posts collected in window');
  if (outboundTotal === 0) notes.push('no outbound proposals in window');

  return {
    workspace_slug: workspaceSlug,
    ledger_dir: ledgerDir,
    posts_24h: posts24h.length,
    approvals_counted: approvals.length,
    approvals_by_status: approvalsByStatus,
    approvals_by_kind: approvalsByKind,
    shape_distribution: shapeDistribution,
    dispatch_success_rate: dispatchSuccessRate,
    approval_ratio: approvalRatio,
    top_buckets: topBuckets,
    engagement_median_likes: median(likes),
    engagement_median_replies: median(replies),
    intel_last_run_ts: intelLastRun?.ts ?? null,
    intel_last_run_ok: intelOk,
    intel_last_run_age_hours: intelAgeHours,
    stale_since_hours: intelAgeHours,
    notes,
  };
}

export class XOpsObserverExperiment implements Experiment {
  readonly id = 'x-ops-observer';
  readonly name = 'X operations observer (Layer 4)';
  readonly category: ExperimentCategory = 'business_outcome';
  readonly hypothesis =
    'X dispatch success rate, shape mix, bucket distribution, and engagement proxy can be computed cheaply from the workspace JSONL ledgers; surfacing them as structured findings unlocks downstream tuning.';
  readonly cadence = { everyMs: PROBE_EVERY_MS, runOnBoot: true };

  /** Override data-dir resolution for tests. */
  constructor(private readonly dataDirOverride?: string) {}

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const slug = ctx.workspaceSlug ?? 'default';
    const ledgerDir = this.dataDirOverride ?? path.join(os.homedir(), '.ohwow', 'workspaces', slug);
    let evidence: XOpsObserverEvidence;
    try {
      evidence = computeEvidence(ledgerDir, slug);
    } catch (err) {
      logger.debug({ err }, '[x-ops-observer] computeEvidence failed');
      evidence = computeEvidence(ledgerDir, slug); // second shot; if still throws, let it propagate
    }
    return {
      subject: 'x-ops:summary',
      summary: `${evidence.posts_24h} posts/24h, ${evidence.approvals_counted} approvals/48h, dispatch=${evidence.dispatch_success_rate?.toFixed(2) ?? 'n/a'}, intel_age=${evidence.intel_last_run_age_hours?.toFixed(1) ?? 'n/a'}h`,
      evidence,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as XOpsObserverEvidence;
    // fail path: intel totally offline OR dispatch catastrophically bad
    if (ev.intel_last_run_age_hours !== null && ev.intel_last_run_age_hours > INTEL_FAIL_STALE_HOURS) {
      return 'fail';
    }
    if (ev.intel_last_run_ok === false) {
      return 'fail';
    }
    if (ev.dispatch_success_rate !== null && ev.dispatch_success_rate < DISPATCH_SUCCESS_FAIL) {
      return 'fail';
    }
    // warning path: partial degradation
    if (ev.intel_last_run_age_hours !== null && ev.intel_last_run_age_hours > INTEL_WARN_STALE_HOURS) {
      return 'warning';
    }
    if (ev.dispatch_success_rate !== null && ev.dispatch_success_rate < DISPATCH_SUCCESS_WARN) {
      return 'warning';
    }
    if (ev.intel_last_run_ts === null) {
      return 'warning';
    }
    return 'pass';
  }
}
