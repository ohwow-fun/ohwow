import { describe, it, expect } from 'vitest';
import {
  RoadmapUpdaterExperiment,
  splitSections,
  reassembleRoadmap,
  parseSectionsResponse,
  type RoadmapUpdaterEvidence,
} from '../experiments/roadmap-updater.js';
import type { ProbeResult } from '../experiment-types.js';

function evidence(over: Partial<RoadmapUpdaterEvidence> = {}): RoadmapUpdaterEvidence {
  return {
    affected_files: ['AUTONOMY_ROADMAP.md'],
    roadmap_age_ms: 0,
    roadmap_mtime_iso: null,
    loop_verdict: null,
    hold_rate: null,
    violation_pool_today: 0,
    patches_landed: 0,
    patches_reverted: 0,
    experiment_files_total: 0,
    experiment_files_missing_from_roadmap: [],
    noteworthy_signals: [],
    ...over,
  };
}

function probe(ev: RoadmapUpdaterEvidence): ProbeResult {
  return { subject: 'meta:roadmap', summary: '', evidence: ev };
}

describe('RoadmapUpdaterExperiment.judge', () => {
  const exp = new RoadmapUpdaterExperiment();

  it('passes when roadmap is fresh', () => {
    expect(exp.judge(probe(evidence({ roadmap_age_ms: 60_000, noteworthy_signals: ['loop_health_fail'] })), [])).toBe('pass');
  });

  it('passes when stale but no signals', () => {
    expect(exp.judge(probe(evidence({ roadmap_age_ms: 3 * 3600_000, noteworthy_signals: [] })), [])).toBe('pass');
  });

  it('warns when stale and at least one signal', () => {
    expect(
      exp.judge(probe(evidence({ roadmap_age_ms: 3 * 3600_000, noteworthy_signals: ['missing_experiments:2'] })), []),
    ).toBe('warning');
  });
});

describe('splitSections / reassembleRoadmap', () => {
  const sample = [
    '# Title',
    '',
    'preamble paragraph',
    '',
    '## 1. First',
    'first body',
    '',
    '## 2. Second',
    'second body',
    '',
    '## 3. Active Focus',
    'focus body',
    '',
    '## 4. Fourth',
    'fourth body',
    '',
    '## 5. Next Steps',
    'next steps body',
    '',
  ].join('\n');

  it('splits into preamble + one section per ##', () => {
    const s = splitSections(sample);
    expect(s[0].header).toBe('');
    expect(s[0].body).toContain('preamble paragraph');
    const headers = s.slice(1).map((x) => x.header);
    expect(headers).toEqual([
      '## 1. First',
      '## 2. Second',
      '## 3. Active Focus',
      '## 4. Fourth',
      '## 5. Next Steps',
    ]);
  });

  it('round-trips verbatim when no sections are rewritten', () => {
    const s = splitSections(sample);
    const rebuilt = reassembleRoadmap(s, '__unused_focus__', '', '__unused_next__', '');
    expect(rebuilt).toBe(sample);
  });

  it('mutates only sections 3 and 5 when rewriting', () => {
    const s = splitSections(sample);
    const rebuilt = reassembleRoadmap(
      s,
      '## 3. Active Focus',
      'NEW FOCUS\n',
      '## 5. Next Steps',
      'NEW NEXT\n',
    );
    expect(rebuilt).toContain('first body');
    expect(rebuilt).toContain('second body');
    expect(rebuilt).toContain('fourth body');
    expect(rebuilt).toContain('NEW FOCUS');
    expect(rebuilt).toContain('NEW NEXT');
    expect(rebuilt).not.toContain('focus body');
    expect(rebuilt).not.toContain('next steps body');
  });
});

describe('parseSectionsResponse', () => {
  it('returns null when either fenced block is missing', () => {
    expect(parseSectionsResponse('```section_3\nbody\n```')).toBeNull();
    expect(parseSectionsResponse('no fences at all')).toBeNull();
  });

  it('extracts both fenced bodies', () => {
    const raw = [
      'prelude ignored',
      '```section_3',
      'focus line a',
      'focus line b',
      '```',
      'interstitial ignored',
      '```section_5',
      'next line a',
      '```',
      'tail ignored',
    ].join('\n');
    const parsed = parseSectionsResponse(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.section3).toContain('focus line a');
    expect(parsed!.section3).toContain('focus line b');
    expect(parsed!.section5).toContain('next line a');
  });
});
