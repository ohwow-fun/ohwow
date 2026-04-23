/**
 * Conductor pulse-aware ranker (Phase 5; Phase 6.5 sharpens regression).
 *
 * Mirrors the spec's "Conductor ranking" pseudo-code:
 *   - Tier 1 REVENUE: approvals (100+age_h), rotting deals (80+idle*2),
 *     qualified-no-outreach (60).
 *   - Tier 2 POLISH: dashboard-smoke red (50).
 *   - Tier 3 PLUMBING: failing triggers (40+failure_count), finding-class
 *     candidates (35).
 *   - Tier 4 TOOLING: friction tripped >=2 times (20).
 *
 * Per-candidate adjustments:
 *   noveltyBonus              +10 if (mode, source) never appeared in the
 *                             recent phase reports window.
 *   recentRegressionPenalty   Scans the last REGRESSION_LOOKBACK_REPORTS
 *                             phase reports matching this candidate's key
 *                             and returns the WORST-status penalty:
 *                               any phase-aborted            -> -30
 *                               else any phase-partial       -> -15
 *                               else any phase-blocked-on-founder -> -5
 *                               else (clean / all-closed)    ->   0
 *                             (Pre-Phase-6.5 it stopped at the first key
 *                             match, which let a stale phase-closed mask
 *                             a recent phase-aborted; see Phase 6.5
 *                             report Bug #3.)
 *   cadencePenalty            -50 if (mode, source) was touched within 4h.
 *
 * Newly-answered founder questions get a hard +200 bias and source
 * `'founder-answer'` so they always rise to the top — the picker passes
 * `newly_answered` directly so we don't have to re-read the inbox here.
 *
 * Tie-breaking (after score sort):
 *   approval > rotting-deal > qualified-no-outreach > dashboard-red >
 *   failing-trigger > finding-class > tooling-friction > novelty >
 *   founder-answer
 *   ...then by source_id ascending (stable, deterministic).
 *
 * Output: ranked list, descending. Empty list if nothing scored above 0.
 */
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { Mode } from './types.js';
import type {
  FullPulseSnapshot,
  PulseApprovalRef,
  PulseRottingDeal,
  PulseQualifiedNoOutreach,
  PulseDashboardRed,
  PulseFailingTrigger,
  PulseToolingFriction,
} from './pulse.js';
import { getLens, LENSES } from './lenses/index.js';
import {
  type FounderInboxRecord,
  type PhaseReportRecord,
} from './director-persistence.js';
import {
  MODE_BUDGETS,
  DEMOTION_MULTIPLIER,
  DEMOTION_LOOKBACK_ARCS,
  DEMOTION_OVERAGE_RATIO,
} from './budgets.js';
import { logger } from '../lib/logger.js';

export type RankSource =
  | 'approval'
  | 'rotting-deal'
  | 'qualified-no-outreach'
  | 'dashboard-red'
  | 'failing-trigger'
  | 'finding-class'
  | 'tooling-friction'
  | 'novelty'
  | 'founder-answer';

export interface RankedPhase {
  mode: Mode;
  /** One sentence; goes into PickerOutput.goal */
  goal: string;
  /** Lens preamble + concrete subject; goes into PickerOutput.initial_plan_brief */
  initial_plan_brief: string;
  score: number;
  source: RankSource;
  source_id?: string;
}

export interface SelfFindingLite {
  id: string;
  category: string | null;
  subject: string | null;
  verdict: string;
  created_at: string;
}

export interface LedgerSnapshot {
  recent_phase_reports: PhaseReportRecord[];
  recent_findings: SelfFindingLite[];
}

interface SelfFindingRow {
  id: string;
  category: string | null;
  subject: string | null;
  verdict: string;
  created_at: string;
  status: string;
}

interface PhaseReportRow {
  id: string;
  arc_id: string;
  workspace_id: string;
  phase_id: string;
  mode: string;
  goal: string;
  status: string;
  trios_run: number;
  runtime_sha_start: string | null;
  runtime_sha_end: string | null;
  cloud_sha_start: string | null;
  cloud_sha_end: string | null;
  delta_pulse_json: string | null;
  delta_ledger_json: string | null;
  inbox_added_json: string | null;
  remaining_scope: string | null;
  next_phase_recommendation: string | null;
  cost_trios: number | null;
  cost_minutes: number | null;
  cost_llm_cents: number | null;
  raw_report: string | null;
  started_at: string;
  ended_at: string | null;
}

const DEFAULT_PHASE_LIMIT = 50;
const DEFAULT_FINDING_LIMIT = 100;

const NOVELTY_LOOKBACK_HOURS = 72;
const CADENCE_WINDOW_HOURS = 4;
const REGRESSION_LOOKBACK_HOURS = 72;
/**
 * Bug #3 (Phase 6.5): scan up to this many recent matching reports for
 * the worst status, instead of stopping at the first match (which let a
 * recent phase-closed mask an earlier phase-aborted on the same key).
 */
export const REGRESSION_LOOKBACK_REPORTS = 7;

const NOVELTY_BONUS = 10;
const REGRESSION_PENALTY_ABORTED = 30;
const REGRESSION_PENALTY_PARTIAL = 15;
const REGRESSION_PENALTY_BLOCKED = 5;
const CADENCE_PENALTY = 50;
const FOUNDER_ANSWER_BONUS = 200;

// Tie-break order (when scores match). Founder-answer claims the
// highest priority so a hand-resolved blocker outranks any pulse-driven
// candidate that happens to land on the same score.
const SOURCE_PRIORITY: Record<RankSource, number> = {
  'founder-answer': -1,
  approval: 0,
  'rotting-deal': 1,
  'qualified-no-outreach': 2,
  'dashboard-red': 3,
  'failing-trigger': 4,
  'finding-class': 5,
  'tooling-friction': 6,
  novelty: 7,
};

function nowMs(): number {
  return Date.now();
}

function parseTs(ts: string): number {
  const t = Date.parse(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
  return Number.isNaN(t) ? 0 : t;
}

function hoursSince(then: string, ref = nowMs()): number {
  const t = parseTs(then);
  if (!t) return Infinity;
  return Math.max(0, (ref - t) / 3_600_000);
}

// ---- ledger reader -----------------------------------------------------

export interface ReadLedgerSnapshotOpts {
  limit_phases?: number;
  limit_findings?: number;
}

export async function readLedgerSnapshot(
  db: DatabaseAdapter,
  workspace_id: string,
  opts: ReadLedgerSnapshotOpts = {},
): Promise<LedgerSnapshot> {
  const limit_phases = opts.limit_phases ?? DEFAULT_PHASE_LIMIT;
  const limit_findings = opts.limit_findings ?? DEFAULT_FINDING_LIMIT;

  let recent_phase_reports: PhaseReportRecord[] = [];
  try {
    const { data } = await db
      .from<PhaseReportRow>('director_phase_reports')
      .select()
      .eq('workspace_id', workspace_id)
      .order('started_at', { ascending: false })
      .limit(limit_phases);
    recent_phase_reports = (data ?? []).map((r): PhaseReportRecord => ({
      id: r.id,
      arc_id: r.arc_id,
      workspace_id: r.workspace_id,
      phase_id: r.phase_id,
      mode: r.mode as Mode,
      goal: r.goal,
      status: r.status as PhaseReportRecord['status'],
      trios_run: r.trios_run,
      runtime_sha_start: r.runtime_sha_start,
      runtime_sha_end: r.runtime_sha_end,
      cloud_sha_start: r.cloud_sha_start,
      cloud_sha_end: r.cloud_sha_end,
      delta_pulse_json: null,
      delta_ledger_json: (() => {
        try { return r.delta_ledger_json ? JSON.parse(r.delta_ledger_json) : null; } catch { return null; }
      })(),
      inbox_added_json: (() => {
        try { return r.inbox_added_json ? JSON.parse(r.inbox_added_json) : null; } catch { return null; }
      })(),
      remaining_scope: r.remaining_scope,
      next_phase_recommendation: r.next_phase_recommendation,
      cost_trios: r.cost_trios,
      cost_minutes: r.cost_minutes,
      cost_llm_cents: r.cost_llm_cents,
      raw_report: r.raw_report,
      started_at: r.started_at,
      ended_at: r.ended_at,
    }));
  } catch (err) {
    logger.warn(
      { workspace_id, err: (err as Error).message },
      'ranker.ledger.phase_reports.failed',
    );
  }

  let recent_findings: SelfFindingLite[] = [];
  try {
    const { data } = await db
      .from<SelfFindingRow>('self_findings')
      .select('id, category, subject, verdict, created_at, status')
      .order('created_at', { ascending: false })
      .limit(limit_findings);
    recent_findings = ((data ?? []) as SelfFindingRow[]).map((r) => ({
      id: r.id,
      category: r.category,
      subject: r.subject,
      verdict: r.verdict,
      created_at: r.created_at,
    }));
  } catch (err) {
    logger.warn(
      { workspace_id, err: (err as Error).message },
      'ranker.ledger.findings.failed',
    );
  }

  return { recent_phase_reports, recent_findings };
}

// ---- candidate construction --------------------------------------------

/**
 * Stable per-candidate key. Cadence, novelty, and regression checks all
 * key off (mode, source, source_id) so a second open approval is its own
 * candidate, not the same as the first.
 */
function candidateKey(c: RankedPhase): string {
  return `${c.mode}::${c.source}::${c.source_id ?? ''}`;
}

/**
 * Phase reports stash the candidate identity in `goal` (set by us) and
 * `mode`. We reconstruct the same key from a report so cadence /
 * regression / novelty can match against history.
 */
function reportKey(r: PhaseReportRecord): string {
  // We encode source + source_id into the goal as `<source>:<source_id>` when
  // the Conductor builds picks. Fall back gracefully when the goal text
  // is human-authored (founder-initiated arcs).
  const m = /\bsource=([a-z\-]+)(?:; id=([^;\]]+))?/.exec(r.goal);
  if (m) {
    const src = m[1];
    const id = m[2] ?? '';
    return `${r.mode}::${src}::${id}`;
  }
  return `${r.mode}::*::${r.goal}`;
}

function encodeGoalProvenance(
  text: string,
  source: RankSource,
  source_id?: string,
): string {
  const tail = source_id ? ` [source=${source}; id=${source_id}]` : ` [source=${source}]`;
  return `${text}${tail}`;
}

function buildPlanBrief(
  mode: Mode,
  source: RankSource,
  subjectLines: string[],
): string {
  const lens = getLens(mode);
  const header = [
    lens.plan_brief_preamble,
    '',
    `## Picked by Conductor`,
    `Source: ${source}`,
    ...subjectLines.map((l) => `- ${l}`),
  ];
  return header.join('\n');
}

function fromApproval(a: PulseApprovalRef): RankedPhase {
  const goal = encodeGoalProvenance(
    `fire approval ${a.id}`,
    'approval',
    a.id,
  );
  const brief = buildPlanBrief('revenue', 'approval', [
    `Approval id: ${a.id}`,
    `Subject: ${a.subject}`,
    `Age: ${Math.round(a.age_hours)}h`,
    'First action: ohwow_preview_approval(<id>) to read the draft, then approve / reject / refine.',
  ]);
  return {
    mode: 'revenue',
    goal,
    initial_plan_brief: brief,
    score: 100 + a.age_hours,
    source: 'approval',
    source_id: a.id,
  };
}

function fromRottingDeal(d: PulseRottingDeal): RankedPhase {
  const goal = encodeGoalProvenance(`move deal ${d.id}`, 'rotting-deal', d.id);
  const brief = buildPlanBrief('revenue', 'rotting-deal', [
    `Deal id: ${d.id}`,
    `Stage: ${d.stage}`,
    `Idle: ${d.idle_days}d`,
    d.expected_value_cents !== undefined
      ? `Expected value: ${d.expected_value_cents}c`
      : 'Expected value: unknown',
    'First action: ohwow_list_deals filtered to this id, decide a real stage change OR draft a queued nudge.',
  ]);
  return {
    mode: 'revenue',
    goal,
    initial_plan_brief: brief,
    score: 80 + d.idle_days * 2,
    source: 'rotting-deal',
    source_id: d.id,
  };
}

function fromQualified(q: PulseQualifiedNoOutreach): RankedPhase {
  const goal = encodeGoalProvenance(
    `outreach to qualified ${q.id}`,
    'qualified-no-outreach',
    q.id,
  );
  const brief = buildPlanBrief('revenue', 'qualified-no-outreach', [
    `Contact id: ${q.id}`,
    `Name: ${q.name ?? 'unknown'}`,
    `Qualified at: ${q.qualified_at}`,
    'First action: ohwow_get_contact(<id>) to read x_intent + public signal, then draft outreach via the approval queue.',
  ]);
  return {
    mode: 'revenue',
    goal,
    initial_plan_brief: brief,
    score: 60,
    source: 'qualified-no-outreach',
    source_id: q.id,
  };
}

function fromDashboardRed(d: PulseDashboardRed): RankedPhase {
  const goal = encodeGoalProvenance(
    `polish ${d.surface}`,
    'dashboard-red',
    d.surface,
  );
  const brief = buildPlanBrief('polish', 'dashboard-red', [
    `Surface: ${d.surface}`,
    `Failure class: ${d.failure_class}`,
    `Observed at: ${d.observed_at}`,
    'First action: snap.mjs <route> before.png against :9222, then state the bar and write the punch list.',
  ]);
  return {
    mode: 'polish',
    goal,
    initial_plan_brief: brief,
    score: 50,
    source: 'dashboard-red',
    source_id: d.surface,
  };
}

function fromFailingTrigger(t: PulseFailingTrigger): RankedPhase {
  const goal = encodeGoalProvenance(
    `unstick ${t.class}`,
    'failing-trigger',
    t.id,
  );
  const brief = buildPlanBrief('plumbing', 'failing-trigger', [
    `Trigger id: ${t.id}`,
    `Class: ${t.class}`,
    `Consecutive failures: ${t.failure_count}`,
    `Last failure: ${t.last_failure_at}`,
    'First action: reproduce the failure, capture raw error, then enumerate every caller in the class.',
  ]);
  return {
    mode: 'plumbing',
    goal,
    initial_plan_brief: brief,
    score: 40 + t.failure_count,
    source: 'failing-trigger',
    source_id: t.id,
  };
}

function fromFindingClass(category: string): RankedPhase {
  const goal = encodeGoalProvenance(
    `reconcile ${category}`,
    'finding-class',
    category,
  );
  const brief = buildPlanBrief('plumbing', 'finding-class', [
    `Finding category: ${category}`,
    'First action: read recent self_findings rows for this category, identify the class signature, enumerate callers.',
  ]);
  return {
    mode: 'plumbing',
    goal,
    initial_plan_brief: brief,
    score: 35,
    source: 'finding-class',
    source_id: category,
  };
}

function fromToolingFriction(v: PulseToolingFriction): RankedPhase {
  const goal = encodeGoalProvenance(`forge ${v.name}`, 'tooling-friction', v.name);
  const brief = buildPlanBrief('tooling', 'tooling-friction', [
    `Verb / helper: ${v.name}`,
    `Friction count (last 7d): ${v.count}`,
    'First action: quote the ledger lines that show this friction tripped >=2 times, then write the curl + MCP call you wish existed.',
  ]);
  return {
    mode: 'tooling',
    goal,
    initial_plan_brief: brief,
    score: 20,
    source: 'tooling-friction',
    source_id: v.name,
  };
}

// ---- adjustments -------------------------------------------------------

function noveltyBonus(
  ledger: LedgerSnapshot,
  c: RankedPhase,
  ref = nowMs(),
): number {
  const window = NOVELTY_LOOKBACK_HOURS;
  const seen = ledger.recent_phase_reports.some((r) => {
    if (hoursSince(r.started_at, ref) > window) return false;
    return reportKey(r) === candidateKey(c);
  });
  return seen ? 0 : NOVELTY_BONUS;
}

function recentRegressionPenalty(
  ledger: LedgerSnapshot,
  c: RankedPhase,
  ref = nowMs(),
): number {
  // Scan up to REGRESSION_LOOKBACK_REPORTS matching reports inside the
  // lookback window and take the WORST-status penalty. Pre-Phase-6.5
  // this broke on the first key match, so a recent phase-closed shadowed
  // an earlier phase-aborted on the same key.
  let sawAborted = false;
  let sawPartial = false;
  let sawBlocked = false;
  let scanned = 0;
  for (const r of ledger.recent_phase_reports) {
    if (hoursSince(r.started_at, ref) > REGRESSION_LOOKBACK_HOURS) continue;
    if (reportKey(r) !== candidateKey(c)) continue;
    scanned += 1;
    if (r.status === 'phase-aborted') sawAborted = true;
    else if (r.status === 'phase-partial') sawPartial = true;
    else if (r.status === 'phase-blocked-on-founder') sawBlocked = true;
    if (scanned >= REGRESSION_LOOKBACK_REPORTS) break;
  }
  if (sawAborted) return REGRESSION_PENALTY_ABORTED;
  if (sawPartial) return REGRESSION_PENALTY_PARTIAL;
  if (sawBlocked) return REGRESSION_PENALTY_BLOCKED;
  return 0;
}

// Approval-source candidates use a longer cadence window so a stale
// approval that was attempted in a prior arc (phase-closed) does not
// float back to the top after just 4h via the age_hours score term.
const APPROVAL_CADENCE_WINDOW_HOURS = 24;

function cadencePenalty(
  ledger: LedgerSnapshot,
  c: RankedPhase,
  ref = nowMs(),
): number {
  const window =
    c.source === 'approval' ? APPROVAL_CADENCE_WINDOW_HOURS : CADENCE_WINDOW_HOURS;
  for (const r of ledger.recent_phase_reports) {
    if (reportKey(r) !== candidateKey(c)) continue;
    const age = hoursSince(r.started_at, ref);
    if (age <= window) return CADENCE_PENALTY;
    break;
  }
  return 0;
}

/**
 * Per-mode budget demotion (gap 14.11b). Filters recent phase reports
 * down to the candidate's mode, takes up to DEMOTION_LOOKBACK_ARCS most
 * recent reports across DISTINCT arc_ids, averages their `cost_minutes`,
 * and returns `true` if the average exceeded the mode's wall-clock cap
 * times DEMOTION_OVERAGE_RATIO. The caller multiplies the score by
 * DEMOTION_MULTIPLIER when this returns true.
 *
 * Returns false (no demotion) if there are no matching reports — fresh
 * modes are not penalized.
 */
function modeBudgetOveragePenalty(
  ledger: LedgerSnapshot,
  c: RankedPhase,
): boolean {
  const cap = MODE_BUDGETS[c.mode];
  if (!cap) return false;
  const seenArcIds = new Set<string>();
  const costs: number[] = [];
  // recent_phase_reports is already most-recent-first.
  for (const r of ledger.recent_phase_reports) {
    if (r.mode !== c.mode) continue;
    if (seenArcIds.has(r.arc_id)) continue;
    seenArcIds.add(r.arc_id);
    costs.push(r.cost_minutes ?? 0);
    if (costs.length >= DEMOTION_LOOKBACK_ARCS) break;
  }
  if (costs.length === 0) return false;
  const avg = costs.reduce((s, n) => s + n, 0) / costs.length;
  return avg > cap.wall_minutes * DEMOTION_OVERAGE_RATIO;
}

// ---- ranker ------------------------------------------------------------

export interface RankInputs {
  pulse: FullPulseSnapshot;
  ledger: LedgerSnapshot;
  newly_answered?: FounderInboxRecord[];
  /** Allows tests to pin "now" so cadence / novelty windows are deterministic. */
  refTimeMs?: number;
}

export function rankNextPhase(inputs: RankInputs): RankedPhase[] {
  const { pulse, ledger } = inputs;
  const ref = inputs.refTimeMs ?? nowMs();
  const candidates: RankedPhase[] = [];

  for (const a of pulse.approvals_pending) candidates.push(fromApproval(a));
  for (const d of pulse.deals_rotting) candidates.push(fromRottingDeal(d));
  for (const q of pulse.qualified_no_outreach) candidates.push(fromQualified(q));
  for (const r of pulse.dashboard_smoke_red) candidates.push(fromDashboardRed(r));
  for (const t of pulse.failing_triggers) candidates.push(fromFailingTrigger(t));
  if (pulse.recent_finding_classes.includes('migration-drift')) {
    candidates.push(fromFindingClass('migration-drift'));
  }
  for (const v of pulse.tooling_friction_count_ge_2) candidates.push(fromToolingFriction(v));

  for (const c of candidates) {
    c.score += noveltyBonus(ledger, c, ref);
    c.score -= recentRegressionPenalty(ledger, c, ref);
    c.score -= cadencePenalty(ledger, c, ref);
    // Per-mode budget demotion (gap 14.11b): multiplicative, applied
    // AFTER the additive adjustments above so the penalty rides on top
    // of the post-adjustment score.
    if (modeBudgetOveragePenalty(ledger, c)) {
      c.score = c.score * DEMOTION_MULTIPLIER;
    }
  }

  // Founder-answer bias: emit one RankedPhase per newly-answered question
  // with score = (top current score) + FOUNDER_ANSWER_BONUS so it ALWAYS
  // ranks first regardless of pulse contents. Done here (after pulse
  // adjustments) so the bonus dominates any combination of approvals,
  // novelty, and finding-class candidates. Source gets max priority via
  // tie-break.
  const topPulseScore = candidates.reduce(
    (m, c) => (c.score > m ? c.score : m),
    0,
  );
  const founderFloor = Math.max(FOUNDER_ANSWER_BONUS, topPulseScore + FOUNDER_ANSWER_BONUS);
  for (const ans of inputs.newly_answered ?? []) {
    if (!ans.answer) continue;
    // External systems (e.g. eternal SLA watcher) write inbox items with
    // mode='outreach' which is not in the conductor's Mode union. Guard
    // before getLens to prevent a crash on unknown modes.
    const mode: Mode = ans.mode in LENSES ? (ans.mode as Mode) : 'plumbing';
    const lens = getLens(mode);
    const subject = ans.blocker.split('\n')[0].slice(0, 240);
    const briefBody = [
      lens.plan_brief_preamble,
      '',
      '## Resume after founder answer',
      `Original blocker: ${subject}`,
      ans.context ? `Context: ${ans.context}` : '',
      '',
      '## Founder answer',
      ans.answer,
    ]
      .filter(Boolean)
      .join('\n');
    candidates.push({
      mode,
      goal: encodeGoalProvenance(
        `resume after founder answer (${ans.id})`,
        'founder-answer',
        ans.id,
      ),
      initial_plan_brief: briefBody,
      score: founderFloor,
      source: 'founder-answer',
      source_id: ans.id,
    });
  }

  // Drop anything that fell to <= 0 (cadence-suppressed work).
  const live = candidates.filter((c) => c.score > 0);

  live.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const pa = SOURCE_PRIORITY[a.source];
    const pb = SOURCE_PRIORITY[b.source];
    if (pa !== pb) return pa - pb;
    const ida = a.source_id ?? '';
    const idb = b.source_id ?? '';
    return ida < idb ? -1 : ida > idb ? 1 : 0;
  });

  return live;
}
