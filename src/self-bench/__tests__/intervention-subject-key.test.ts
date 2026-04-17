/**
 * Regression: intervention-validation findings used to be stamped with
 * `subject: intervention:${uuid}` where ${uuid} was a fresh per-intervention
 * id. The insight distiller keys baselines by (experiment_id, subject),
 * so every validation was a baseline miss → novelty scorer stamped
 * 'first_seen' on every validation → validations crowned the feed and
 * hid real stuck loops. This test pins the replacement: shape-derived
 * subject keys collapse repeated same-shape interventions onto one
 * cluster.
 */

import { describe, it, expect, vi } from 'vitest';
import { deriveInterventionSubjectKey } from '../experiment-runner.js';
import { listDistilledInsights } from '../insight-distiller.js';

describe('deriveInterventionSubjectKey', () => {
  it('keys config-change interventions on the sorted config_keys', () => {
    const a = deriveInterventionSubjectKey('intervention', 'exp-x', {
      config_keys: ['strategy.revenue_gap_priorities', 'strategy.revenue_gap_focus'],
      focus_text: 'first run',
    });
    const b = deriveInterventionSubjectKey('intervention', 'exp-x', {
      config_keys: ['strategy.revenue_gap_focus', 'strategy.revenue_gap_priorities'],
      focus_text: 'different focus, same knobs',
    });
    expect(a).toBe(b);
    expect(a).toBe('intervention:config:strategy.revenue_gap_focus,strategy.revenue_gap_priorities');
  });

  it('keys authoring-gate interventions on brief_slug', () => {
    const a = deriveInterventionSubjectKey('intervention', 'experiment-author', {
      brief_slug: 'outreach-reply-rate-classifier-stability',
      stage: 'stagnation_gate',
      consecutive_failures: 3,
    });
    const b = deriveInterventionSubjectKey('intervention', 'experiment-author', {
      brief_slug: 'outreach-reply-rate-classifier-stability',
      stage: 'model',
      consecutive_failures: 5,
    });
    expect(a).toBe(b);
    expect(a).toBe('intervention:brief:outreach-reply-rate-classifier-stability');
  });

  it('falls back to experiment:shape-unknown when neither config_keys nor brief_slug is present', () => {
    const a = deriveInterventionSubjectKey('intervention', 'intervention-audit', {
      performative: ['revenue-pipeline-observer'],
      unmeasurable: ['intervention-audit'],
      overall_hold_rate: 0.35,
    });
    expect(a).toBe('intervention:intervention-audit:shape-unknown');
  });

  it('keeps rollback and intervention on distinct clusters for same baseline', () => {
    const baseline = { config_keys: ['k1'] };
    expect(deriveInterventionSubjectKey('intervention', 'exp', baseline))
      .toBe('intervention:config:k1');
    expect(deriveInterventionSubjectKey('rollback', 'exp', baseline))
      .toBe('rollback:config:k1');
  });

  it('ignores empty or non-string entries in config_keys before joining', () => {
    const a = deriveInterventionSubjectKey('intervention', 'exp', {
      config_keys: ['', 'real.key', null, 42, 'other.key'] as unknown[],
    });
    expect(a).toBe('intervention:config:other.key,real.key');
  });

  it('falls back when config_keys is present but empty after filtering', () => {
    const a = deriveInterventionSubjectKey('intervention', 'exp', {
      config_keys: ['', null] as unknown[],
    });
    expect(a).toBe('intervention:exp:shape-unknown');
  });

  it('falls back when brief_slug is the empty string', () => {
    const a = deriveInterventionSubjectKey('intervention', 'exp', { brief_slug: '' });
    expect(a).toBe('intervention:exp:shape-unknown');
  });
});

/**
 * End-to-end proof that the writer-side fix collapses same-shape
 * validations in the distiller's output. Before the fix, two validations
 * of the same-knob intervention produced two clusters — both scored
 * 'first_seen' at 1.0 and outranked actually-stuck loops. After the fix
 * they dedupe to a single cluster keyed on the shape.
 */
describe('listDistilledInsights × shape-keyed intervention subjects', () => {
  interface Row {
    id: string;
    experiment_id: string;
    subject: string;
    verdict: string;
    summary: string;
    evidence: string;
    ran_at: string;
    status: string;
  }

  function buildDb(findings: Row[]) {
    function makeBuilder(table: string) {
      const filters: Array<{ col: string; val: unknown }> = [];
      let orderCol: string | null = null;
      let orderAsc = true;
      let limitN = 2000;

      const apply = () => {
        let out: unknown[] = [];
        if (table === 'self_findings') {
          out = findings.filter((r) =>
            filters.every((f) => (r as unknown as Record<string, unknown>)[f.col] === f.val),
          );
        }
        if (orderCol) {
          const key = orderCol;
          out = [...out].sort((a, b) => {
            const av = String((a as Record<string, unknown>)[key] ?? '');
            const bv = String((b as Record<string, unknown>)[key] ?? '');
            return orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
          });
        }
        return out.slice(0, limitN);
      };

      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = (col: string, val: unknown) => { filters.push({ col, val }); return builder; };
      builder.order = (col: string, opts?: { ascending?: boolean }) => {
        orderCol = col;
        orderAsc = opts?.ascending !== false;
        return builder;
      };
      builder.limit = (n: number) => {
        limitN = n;
        return Promise.resolve({ data: apply(), error: null });
      };
      return builder;
    }

    return { db: { from: vi.fn().mockImplementation((t: string) => makeBuilder(t)) } };
  }

  it('collapses two same-shape intervention validations into one cluster', async () => {
    // Both findings describe the same intervention shape (same config_keys),
    // dispatched as two separate intervention UUIDs over two hours. The
    // writer stamps subject from the shape, so these share a subject and
    // the distiller returns a single cluster with only the latest.
    const subject = deriveInterventionSubjectKey('intervention', 'intervention-audit', {
      config_keys: ['strategy.revenue_gap_focus', 'strategy.revenue_gap_priorities'],
    });
    const ev = (score: number) => JSON.stringify({ __novelty: { score, reason: 'first_seen' } });
    const env = buildDb([
      {
        id: 'latest',
        experiment_id: 'intervention-audit',
        subject,
        verdict: 'warning',
        summary: 'second run — same knobs',
        evidence: ev(1),
        ran_at: '2026-04-17T01:00:00Z',
        status: 'active',
      },
      {
        id: 'earlier',
        experiment_id: 'intervention-audit',
        subject,
        verdict: 'warning',
        summary: 'first run — same knobs',
        evidence: ev(1),
        ran_at: '2026-04-17T00:00:00Z',
        status: 'active',
      },
    ]);

    const out = await listDistilledInsights(env.db as never);
    expect(out).toHaveLength(1);
    expect(out[0].latest_finding_id).toBe('latest');
    expect(out[0].subject).toBe(subject);
  });
});
