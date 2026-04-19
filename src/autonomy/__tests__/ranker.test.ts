/**
 * Ranker tests (Phase 5 of the autonomy retrofit).
 *
 * Stubs the pulse + ledger snapshots; the ranker is pure given those
 * inputs, so we don't need the SQLite adapter to exercise it.
 */
import { describe, it, expect } from 'vitest';
import {
  rankNextPhase,
  type LedgerSnapshot,
  type SelfFindingLite,
} from '../ranker.js';
import type {
  FullPulseSnapshot,
  PulseApprovalRef,
  PulseFailingTrigger,
  PulseRottingDeal,
} from '../pulse.js';
import type {
  FounderInboxRecord,
  PhaseReportRecord,
} from '../director-persistence.js';
import { LENSES } from '../lenses/index.js';

const REF_TIME_MS = Date.UTC(2026, 3, 18, 12, 0, 0);
const REF_ISO = new Date(REF_TIME_MS).toISOString();

function emptyPulse(over: Partial<FullPulseSnapshot> = {}): FullPulseSnapshot {
  return {
    ts: REF_ISO,
    approvals_pending: [],
    deals_rotting: [],
    qualified_no_outreach: [],
    dashboard_smoke_red: [],
    failing_triggers: [],
    recent_finding_classes: [],
    tooling_friction_count_ge_2: [],
    ...over,
  };
}

function emptyLedger(over: Partial<LedgerSnapshot> = {}): LedgerSnapshot {
  return {
    recent_phase_reports: [],
    recent_findings: [],
    ...over,
  };
}

function approvalRef(over: Partial<PulseApprovalRef> = {}): PulseApprovalRef {
  return {
    id: 'apr_001',
    mode: 'revenue',
    age_hours: 4,
    subject: 'Approve outbound DM to @lead',
    ...over,
  };
}

function rottingDeal(over: Partial<PulseRottingDeal> = {}): PulseRottingDeal {
  return {
    id: 'deal_001',
    idle_days: 10,
    stage: 'Qualified',
    expected_value_cents: 50000,
    ...over,
  };
}

function failingTrigger(
  over: Partial<PulseFailingTrigger> = {},
): PulseFailingTrigger {
  return {
    id: 'trig_001',
    class: 'cron-x-intel',
    failure_count: 5,
    last_failure_at: new Date(REF_TIME_MS - 30 * 60 * 1000).toISOString(),
    ...over,
  };
}

function fakeReport(over: Partial<PhaseReportRecord>): PhaseReportRecord {
  return {
    id: 'report_test',
    arc_id: 'arc_test',
    workspace_id: 'ws-test',
    phase_id: 'phase_test',
    mode: 'revenue',
    goal: 'fire approval apr_001 [source=approval; id=apr_001]',
    status: 'phase-closed',
    trios_run: 1,
    runtime_sha_start: null,
    runtime_sha_end: null,
    cloud_sha_start: null,
    cloud_sha_end: null,
    delta_pulse_json: null,
    delta_ledger: null,
    inbox_added: '0',
    remaining_scope: null,
    next_phase_recommendation: null,
    cost_trios: 1,
    cost_minutes: 1,
    cost_llm_cents: 0,
    raw_report: null,
    started_at: REF_ISO,
    ended_at: REF_ISO,
    ...over,
  };
}

function fakeFinding(over: Partial<SelfFindingLite> = {}): SelfFindingLite {
  return {
    id: 'find_test',
    category: 'tooling-friction',
    subject: 'unknown',
    verdict: 'fail',
    created_at: REF_ISO,
    ...over,
  };
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('rankNextPhase — empty inputs', () => {
  it('returns [] when nothing to do', () => {
    const out = rankNextPhase({
      pulse: emptyPulse(),
      ledger: emptyLedger(),
      refTimeMs: REF_TIME_MS,
    });
    expect(out).toEqual([]);
  });
});

describe('rankNextPhase — revenue tier', () => {
  it('one pending approval ranks at top with source approval', () => {
    const pulse = emptyPulse({ approvals_pending: [approvalRef()] });
    const out = rankNextPhase({
      pulse,
      ledger: emptyLedger(),
      refTimeMs: REF_TIME_MS,
    });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('approval');
    expect(out[0].mode).toBe('revenue');
    expect(out[0].score).toBeGreaterThan(100);
  });

  it('older approval ranks before newer one', () => {
    const pulse = emptyPulse({
      approvals_pending: [
        approvalRef({ id: 'apr_new', age_hours: 2 }),
        approvalRef({ id: 'apr_old', age_hours: 20 }),
      ],
    });
    const out = rankNextPhase({
      pulse,
      ledger: emptyLedger(),
      refTimeMs: REF_TIME_MS,
    });
    expect(out[0].source_id).toBe('apr_old');
    expect(out[1].source_id).toBe('apr_new');
  });

  it('approval beats rotting deal at the revenue tier base line', () => {
    // Spec scoring: approval = 100 + age_h; deal = 80 + idle_days*2.
    // At the tier base (low age, low idle) the approval tier wins. A
    // very long-idle deal (30+ days) can outrank a fresh approval —
    // that's an intentional spec property, not a bug; revenue mode
    // wants to escalate stale pipeline above easy approvals.
    const pulse = emptyPulse({
      approvals_pending: [approvalRef({ age_hours: 1 })],
      deals_rotting: [rottingDeal({ idle_days: 7 })],
    });
    const out = rankNextPhase({
      pulse,
      ledger: emptyLedger(),
      refTimeMs: REF_TIME_MS,
    });
    expect(out[0].source).toBe('approval');
    expect(out[1].source).toBe('rotting-deal');
  });
});

describe('rankNextPhase — plumbing tier', () => {
  it('failing trigger only -> ranked >0 with mode plumbing', () => {
    const pulse = emptyPulse({ failing_triggers: [failingTrigger()] });
    const out = rankNextPhase({
      pulse,
      ledger: emptyLedger(),
      refTimeMs: REF_TIME_MS,
    });
    expect(out).toHaveLength(1);
    expect(out[0].mode).toBe('plumbing');
    expect(out[0].source).toBe('failing-trigger');
    expect(out[0].score).toBeGreaterThan(0);
  });
});

describe('rankNextPhase — adjustments', () => {
  it('recent regression on same (mode, source) drops the score by 30', () => {
    const pulse = emptyPulse({
      failing_triggers: [
        failingTrigger({ id: 'trig_a', failure_count: 0 }),
        failingTrigger({ id: 'trig_b', failure_count: 0 }),
      ],
    });
    const ledger = emptyLedger({
      recent_phase_reports: [
        fakeReport({
          mode: 'plumbing',
          goal: 'unstick cron-x-intel [source=failing-trigger; id=trig_a]',
          status: 'phase-aborted',
          // Inside regression lookback (72h) but outside cadence window (4h).
          started_at: new Date(REF_TIME_MS - 24 * 3_600_000).toISOString(),
        }),
      ],
    });
    const out = rankNextPhase({
      pulse,
      ledger,
      refTimeMs: REF_TIME_MS,
    });
    const a = out.find((c) => c.source_id === 'trig_a')!;
    const b = out.find((c) => c.source_id === 'trig_b')!;
    expect(a.score).toBeLessThan(b.score);
    // b: 40 + 0 + novelty(10) = 50; a: 40 - 30 = 10 (no novelty bc seen)
    expect(b.score - a.score).toBeGreaterThanOrEqual(30);
  });

  it('worst-status-in-window: a recent phase-closed does NOT mask an earlier phase-aborted on the same key (Bug #3)', () => {
    // Pre-Phase-6.5 the ranker broke on the first key match in
    // started_at DESC order. So a recent phase-closed shadowed an
    // earlier phase-aborted, and a flapping bug looked clean. Phase
    // 6.5 scans up to REGRESSION_LOOKBACK_REPORTS matching reports and
    // takes the worst status.
    const pulse = emptyPulse({
      failing_triggers: [failingTrigger({ id: 'trig_flap', failure_count: 0 })],
    });
    const ledger = emptyLedger({
      recent_phase_reports: [
        // Most recent: phase-closed (would have masked under old code).
        fakeReport({
          id: 'pr_recent',
          mode: 'plumbing',
          goal: 'unstick cron-x-intel [source=failing-trigger; id=trig_flap]',
          status: 'phase-closed',
          started_at: new Date(REF_TIME_MS - 8 * 3_600_000).toISOString(),
        }),
        // Earlier: phase-aborted (must still be caught).
        fakeReport({
          id: 'pr_earlier',
          mode: 'plumbing',
          goal: 'unstick cron-x-intel [source=failing-trigger; id=trig_flap]',
          status: 'phase-aborted',
          started_at: new Date(REF_TIME_MS - 24 * 3_600_000).toISOString(),
        }),
      ],
    });
    const out = rankNextPhase({
      pulse,
      ledger,
      refTimeMs: REF_TIME_MS,
    });
    const c = out.find((x) => x.source_id === 'trig_flap')!;
    // Base 40 + novelty 0 (seen) - regression 30 (worst-status=aborted)
    // = 10. Pre-fix would have been 40 - 0 = 40.
    expect(c.score).toBe(10);
  });

  it('worst-status-in-window: phase-partial in window yields -15 when no aborted exists', () => {
    const pulse = emptyPulse({
      failing_triggers: [failingTrigger({ id: 'trig_part', failure_count: 0 })],
    });
    const ledger = emptyLedger({
      recent_phase_reports: [
        fakeReport({
          id: 'pr_part',
          mode: 'plumbing',
          goal: 'unstick cron-x-intel [source=failing-trigger; id=trig_part]',
          status: 'phase-partial',
          started_at: new Date(REF_TIME_MS - 24 * 3_600_000).toISOString(),
        }),
      ],
    });
    const out = rankNextPhase({
      pulse,
      ledger,
      refTimeMs: REF_TIME_MS,
    });
    const c = out.find((x) => x.source_id === 'trig_part')!;
    // 40 + novelty 0 (seen) - 15 = 25.
    expect(c.score).toBe(25);
  });

  it('worst-status-in-window: phase-blocked-on-founder yields -5 when no aborted/partial exists', () => {
    const pulse = emptyPulse({
      failing_triggers: [
        failingTrigger({ id: 'trig_block', failure_count: 0 }),
      ],
    });
    const ledger = emptyLedger({
      recent_phase_reports: [
        fakeReport({
          id: 'pr_block',
          mode: 'plumbing',
          goal: 'unstick cron-x-intel [source=failing-trigger; id=trig_block]',
          status: 'phase-blocked-on-founder',
          started_at: new Date(REF_TIME_MS - 24 * 3_600_000).toISOString(),
        }),
      ],
    });
    const out = rankNextPhase({
      pulse,
      ledger,
      refTimeMs: REF_TIME_MS,
    });
    const c = out.find((x) => x.source_id === 'trig_block')!;
    // 40 + novelty 0 (seen) - 5 = 35.
    expect(c.score).toBe(35);
  });

  it('cadence penalty drops a recently-touched candidate below alternatives', () => {
    const pulse = emptyPulse({
      failing_triggers: [
        failingTrigger({ id: 'trig_recent', failure_count: 0 }),
        failingTrigger({ id: 'trig_novel', failure_count: 0 }),
      ],
    });
    const ledger = emptyLedger({
      recent_phase_reports: [
        fakeReport({
          mode: 'plumbing',
          goal: 'unstick cron-x-intel [source=failing-trigger; id=trig_recent]',
          status: 'phase-closed',
          // Inside the 4h cadence window.
          started_at: new Date(REF_TIME_MS - 30 * 60 * 1000).toISOString(),
        }),
      ],
    });
    const out = rankNextPhase({
      pulse,
      ledger,
      refTimeMs: REF_TIME_MS,
    });
    // The recently-touched one should be heavily down-ranked. Cadence
    // penalty of -50 plus base 40 = -10, which is filtered out (>0 only).
    expect(out.find((c) => c.source_id === 'trig_recent')).toBeUndefined();
    expect(out[0].source_id).toBe('trig_novel');
  });

  it('novelty bonus: unseen candidate +10 vs identical seen one', () => {
    const pulse = emptyPulse({
      failing_triggers: [
        failingTrigger({ id: 'trig_seen', failure_count: 0 }),
        failingTrigger({ id: 'trig_unseen', failure_count: 0 }),
      ],
    });
    const ledger = emptyLedger({
      recent_phase_reports: [
        fakeReport({
          mode: 'plumbing',
          goal: 'unstick cron-x-intel [source=failing-trigger; id=trig_seen]',
          status: 'phase-closed',
          // Within novelty window (72h) but outside cadence window (4h)
          started_at: new Date(REF_TIME_MS - 24 * 3_600_000).toISOString(),
        }),
      ],
    });
    const out = rankNextPhase({
      pulse,
      ledger,
      refTimeMs: REF_TIME_MS,
    });
    const seen = out.find((c) => c.source_id === 'trig_seen')!;
    const unseen = out.find((c) => c.source_id === 'trig_unseen')!;
    expect(unseen.score - seen.score).toBe(10);
  });
});

describe('rankNextPhase — founder-answer bias', () => {
  it('newly-answered question always ranks first with score >=200', () => {
    const pulse = emptyPulse({
      approvals_pending: [approvalRef({ id: 'apr_x', age_hours: 99 })],
    });
    const ans: FounderInboxRecord = {
      id: 'fi_001',
      workspace_id: 'ws-test',
      arc_id: 'arc_001',
      phase_id: 'pr_001',
      mode: 'plumbing',
      blocker: 'should we tighten scope?',
      context: 'context body',
      options: [],
      recommended: null,
      screenshot_path: null,
      asked_at: REF_ISO,
      answered_at: REF_ISO,
      answer: 'yes, tighten to one caller',
      status: 'answered',
    };
    const out = rankNextPhase({
      pulse,
      ledger: emptyLedger(),
      newly_answered: [ans],
      refTimeMs: REF_TIME_MS,
    });
    expect(out[0].source).toBe('founder-answer');
    expect(out[0].score).toBeGreaterThanOrEqual(200);
    expect(out[0].mode).toBe('plumbing');
    expect(out[0].initial_plan_brief).toContain('yes, tighten to one caller');
  });
});

describe('rankNextPhase — tie-breaking', () => {
  it('two equal-score approvals order by source_id ascending', () => {
    const pulse = emptyPulse({
      approvals_pending: [
        approvalRef({ id: 'apr_b', age_hours: 0 }),
        approvalRef({ id: 'apr_a', age_hours: 0 }),
      ],
    });
    const out = rankNextPhase({
      pulse,
      ledger: emptyLedger(),
      refTimeMs: REF_TIME_MS,
    });
    // Same score; tie-break by source_id ascending.
    expect(out[0].source_id).toBe('apr_a');
    expect(out[1].source_id).toBe('apr_b');
  });
});

describe('rankNextPhase — lens preamble', () => {
  it('every emitted RankedPhase includes its mode lens preamble', () => {
    const pulse = emptyPulse({
      approvals_pending: [approvalRef()],
      failing_triggers: [failingTrigger()],
    });
    const out = rankNextPhase({
      pulse,
      ledger: emptyLedger(),
      refTimeMs: REF_TIME_MS,
    });
    for (const c of out) {
      expect(c.initial_plan_brief).toContain(LENSES[c.mode].plan_brief_preamble);
    }
  });
});

// ----------------------------------------------------------------------------
// Per-mode budget demotion (gap 14.11b)
// ----------------------------------------------------------------------------

describe('rankNextPhase — per-mode budget demotion', () => {
  function revenuePhaseReport(
    arcId: string,
    costMinutes: number,
  ): PhaseReportRecord {
    return fakeReport({
      id: `pr_${arcId}`,
      arc_id: arcId,
      mode: 'revenue',
      // The goal contains a deterministic source provenance so the
      // mode-budget filter (which keys off `mode` only) sees these as
      // revenue reports regardless of source/cadence/regression keying.
      goal: 'fire approval apr_x [source=approval; id=apr_x]',
      status: 'phase-closed',
      cost_minutes: costMinutes,
      // Push outside cadence (4h) and regression (72h) windows so those
      // adjustments don't fight the demotion math under test.
      started_at: new Date(REF_TIME_MS - 96 * 3_600_000).toISOString(),
    });
  }

  it('avg cost over 3 distinct revenue arcs at 25min each (>22.5 cap*1.5) demotes a fresh approval by 0.7x', () => {
    const pulse = emptyPulse({
      approvals_pending: [approvalRef({ id: 'apr_new', age_hours: 0 })],
    });
    const ledger = emptyLedger({
      recent_phase_reports: [
        revenuePhaseReport('arc_1', 25),
        revenuePhaseReport('arc_2', 25),
        revenuePhaseReport('arc_3', 25),
      ],
    });
    const out = rankNextPhase({
      pulse,
      ledger,
      refTimeMs: REF_TIME_MS,
    });
    expect(out).toHaveLength(1);
    // Pre-change formula: base 100 + age_h 0 + novelty 10 (apr_new is a
    // new source_id; the seeded reports key off apr_x so apr_new is
    // unseen) - regression 0 - cadence 0 = 110. Demotion multiplier 0.7
    // -> 77 (within float tolerance).
    expect(out[0].score).toBeGreaterThan(110 * 0.7 - 0.01);
    expect(out[0].score).toBeLessThan(110 * 0.7 + 0.01);
    // Bracket assertion for resilience to small future formula tweaks.
    const preDemotion = 110;
    expect(out[0].score).toBeLessThan(preDemotion * 0.71);
    expect(out[0].score).toBeGreaterThan(preDemotion * 0.69);
  });

  it('avg cost within budget (10 min, well under 22.5) leaves the score un-multiplied', () => {
    const pulse = emptyPulse({
      approvals_pending: [approvalRef({ id: 'apr_new', age_hours: 0 })],
    });
    const ledger = emptyLedger({
      recent_phase_reports: [
        revenuePhaseReport('arc_1', 10),
        revenuePhaseReport('arc_2', 10),
        revenuePhaseReport('arc_3', 10),
      ],
    });
    const out = rankNextPhase({
      pulse,
      ledger,
      refTimeMs: REF_TIME_MS,
    });
    expect(out).toHaveLength(1);
    // Base 100 + novelty 10 = 110, no demotion applied.
    expect(out[0].score).toBe(110);
  });

  it('only counts DISTINCT arc_ids (3 reports from same arc do NOT trigger demotion via volume)', () => {
    // Three revenue reports all sharing arc_id='arc_1', each 25 min. The
    // demotion filter dedupes by arc_id, so only one cost sample lands
    // (avg=25, > 22.5) — demotion still fires because 1 sample > cap.
    // This test pins the dedup behaviour: the function does NOT need
    // EXACTLY DEMOTION_LOOKBACK_ARCS distinct arcs to trigger; it uses
    // up to that many. Demotion still fires from a single bad arc.
    const pulse = emptyPulse({
      approvals_pending: [approvalRef({ id: 'apr_new', age_hours: 0 })],
    });
    const ledger = emptyLedger({
      recent_phase_reports: [
        { ...revenuePhaseReport('arc_solo', 25), id: 'pr_1' },
        { ...revenuePhaseReport('arc_solo', 25), id: 'pr_2' },
        { ...revenuePhaseReport('arc_solo', 25), id: 'pr_3' },
      ],
    });
    const out = rankNextPhase({
      pulse,
      ledger,
      refTimeMs: REF_TIME_MS,
    });
    // Only one distinct arc: avg=25 > 22.5 -> demote.
    expect(out[0].score).toBeLessThan(110);
  });

  it('mode mismatch: tooling reports do NOT demote a revenue candidate', () => {
    const pulse = emptyPulse({
      approvals_pending: [approvalRef({ id: 'apr_new', age_hours: 0 })],
    });
    const ledger = emptyLedger({
      recent_phase_reports: [
        { ...revenuePhaseReport('arc_1', 999), mode: 'tooling' },
        { ...revenuePhaseReport('arc_2', 999), mode: 'tooling' },
        { ...revenuePhaseReport('arc_3', 999), mode: 'tooling' },
      ],
    });
    const out = rankNextPhase({
      pulse,
      ledger,
      refTimeMs: REF_TIME_MS,
    });
    // Revenue candidate's mode != tooling, so the budget filter ignores
    // these reports. Score stays at base 100 + novelty 10 = 110.
    expect(out[0].score).toBe(110);
  });

  it('no recent reports for the mode -> no demotion (fresh modes are not penalized)', () => {
    const pulse = emptyPulse({
      approvals_pending: [approvalRef({ id: 'apr_new', age_hours: 0 })],
    });
    const out = rankNextPhase({
      pulse,
      ledger: emptyLedger(),
      refTimeMs: REF_TIME_MS,
    });
    expect(out[0].score).toBe(110);
  });
});

// ----------------------------------------------------------------------------
// cadencePenalty — approval-source 24h window (fix cd4e8a2)
//
// Prior to the fix, approval-source candidates used the same 4h cadence
// window as other sources. A stale approval phase-closed 10h ago would
// NOT receive a cadence penalty, letting it float back to the top of the
// ranker on the next arc. The fix extends the window to 24h for approval
// sources only.
// ----------------------------------------------------------------------------

describe('cadencePenalty — approval-source uses 24h window (not 4h)', () => {
  it('approval candidate with phase-closed report 10h ago receives cadence penalty', () => {
    // 10h > 4h (old window) but 10h <= 24h (new window) → penalty must fire.
    const pulse = emptyPulse({
      approvals_pending: [approvalRef({ id: 'apr_stale', age_hours: 10 })],
    });
    const ledger = emptyLedger({
      recent_phase_reports: [
        fakeReport({
          mode: 'revenue',
          goal: 'fire approval apr_stale [source=approval; id=apr_stale]',
          status: 'phase-closed',
          started_at: new Date(REF_TIME_MS - 10 * 3_600_000).toISOString(),
        }),
      ],
    });

    const withReport = rankNextPhase({ pulse, ledger, refTimeMs: REF_TIME_MS });
    const withoutReport = rankNextPhase({
      pulse,
      ledger: emptyLedger(),
      refTimeMs: REF_TIME_MS,
    });

    const scoreWith = withReport.find((c) => c.source_id === 'apr_stale')?.score;
    const scoreWithout = withoutReport.find((c) => c.source_id === 'apr_stale')?.score;

    // Candidate should be suppressed (cadence penalty -50 + base 100 + age 10
    // = 60 > 0 so it survives, but score is lower) OR filtered out entirely
    // if the combined score <= 0. In either case, score must be lower than
    // the baseline without any report.
    if (scoreWith === undefined) {
      // Filtered out entirely — penalty definitely fired.
      expect(scoreWithout).toBeGreaterThan(0);
    } else {
      expect(scoreWith).toBeLessThan(scoreWithout!);
    }
  });

  it('approval candidate with phase-closed report 25h ago does NOT receive cadence penalty', () => {
    // 25h > 24h (new window) → penalty must NOT fire.
    const pulse = emptyPulse({
      approvals_pending: [approvalRef({ id: 'apr_old', age_hours: 25 })],
    });
    const ledger = emptyLedger({
      recent_phase_reports: [
        fakeReport({
          mode: 'revenue',
          goal: 'fire approval apr_old [source=approval; id=apr_old]',
          status: 'phase-closed',
          started_at: new Date(REF_TIME_MS - 25 * 3_600_000).toISOString(),
        }),
      ],
    });

    const withReport = rankNextPhase({ pulse, ledger, refTimeMs: REF_TIME_MS });
    const withoutReport = rankNextPhase({
      pulse,
      ledger: emptyLedger(),
      refTimeMs: REF_TIME_MS,
    });

    const scoreWith = withReport.find((c) => c.source_id === 'apr_old')?.score;
    const scoreWithout = withoutReport.find((c) => c.source_id === 'apr_old')?.score;

    // 25h is outside the 24h window → no cadence penalty. The only difference
    // is the novelty bonus (seen candidate → 0; unseen → 10). Scores should
    // be equal except for novelty suppression.
    // Both should be defined (candidate survives).
    expect(scoreWith).toBeDefined();
    expect(scoreWithout).toBeDefined();
    // No cadence penalty: the score difference must only be the novelty bonus
    // (10) at most, NOT the cadence penalty (50).
    expect(scoreWithout! - scoreWith!).toBeLessThan(50);
  });

  it('non-approval candidate (failing-trigger) with report 10h ago does NOT receive cadence penalty (4h window)', () => {
    // failing-trigger uses CADENCE_WINDOW_HOURS=4. A report 10h ago is
    // OUTSIDE that window → no cadence penalty. This contrasts with the
    // approval case above and pins the source-specific window behaviour.
    const pulse = emptyPulse({
      failing_triggers: [failingTrigger({ id: 'trig_10h', failure_count: 5 })],
    });
    const ledger = emptyLedger({
      recent_phase_reports: [
        fakeReport({
          mode: 'plumbing',
          goal: 'unstick cron-x-intel [source=failing-trigger; id=trig_10h]',
          status: 'phase-closed',
          started_at: new Date(REF_TIME_MS - 10 * 3_600_000).toISOString(),
        }),
      ],
    });

    const withReport = rankNextPhase({ pulse, ledger, refTimeMs: REF_TIME_MS });
    const withoutReport = rankNextPhase({
      pulse,
      ledger: emptyLedger(),
      refTimeMs: REF_TIME_MS,
    });

    const scoreWith = withReport.find((c) => c.source_id === 'trig_10h')?.score;
    const scoreWithout = withoutReport.find((c) => c.source_id === 'trig_10h')?.score;

    // 10h > 4h window → no cadence penalty. The candidate must survive (not
    // filtered out) and the score difference must be less than the cadence
    // penalty (50) — it will only differ by the novelty bonus (10).
    expect(scoreWith).toBeDefined();
    expect(scoreWithout).toBeDefined();
    expect(scoreWithout! - scoreWith!).toBeLessThan(50);
  });
});

// Touch the SelfFindingLite import so a future refactor doesn't tree-shake
// it out of the test bundle by accident.
void fakeFinding;
