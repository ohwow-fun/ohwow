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

// Touch the SelfFindingLite import so a future refactor doesn't tree-shake
// it out of the test bundle by accident.
void fakeFinding;
