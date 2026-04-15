import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RoadmapUpdaterExperiment,
  splitSections,
  reassembleRoadmap,
  parseSectionsResponse,
  computeInputFingerprint,
  type RoadmapUpdaterEvidence,
} from '../experiments/roadmap-updater.js';
import type { ExperimentContext, Finding, ProbeResult } from '../experiment-types.js';
import { setSelfCommitRepoRoot } from '../self-commit.js';
import * as llmOrgan from '../../execution/llm-organ.js';

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

describe('computeInputFingerprint', () => {
  it('returns identical hash for identical inputs', () => {
    const ev = evidence({ loop_verdict: 'fail', violation_pool_today: 10, patches_landed: 3 });
    expect(computeInputFingerprint(ev, ['a', 'b'])).toBe(computeInputFingerprint(ev, ['a', 'b']));
  });

  it('is insensitive to experiment file ordering', () => {
    const ev = evidence();
    expect(computeInputFingerprint(ev, ['a', 'b'])).toBe(computeInputFingerprint(ev, ['b', 'a']));
  });

  it('changes when inputs change', () => {
    const a = computeInputFingerprint(evidence({ violation_pool_today: 1 }), ['x']);
    const b = computeInputFingerprint(evidence({ violation_pool_today: 2 }), ['x']);
    expect(a).not.toBe(b);
  });
});

describe('RoadmapUpdaterExperiment.intervene short-circuit', () => {
  let tmp: string;
  let runSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-updater-'));
    fs.mkdirSync(path.join(tmp, 'src/self-bench/experiments'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'AUTONOMY_ROADMAP.md'),
      '# Roadmap\n\n## 3. Active Focus\nfocus\n\n## 5. Next Steps\nnext\n',
    );
    setSelfCommitRepoRoot(tmp);
    runSpy = vi.spyOn(llmOrgan, 'runLlmCall');
  });

  afterEach(() => {
    setSelfCommitRepoRoot(null);
    fs.rmSync(tmp, { recursive: true, force: true });
    runSpy.mockRestore();
  });

  it('returns no_change_since_last_run without calling runLlmCall when fingerprint matches prior finding', async () => {
    const exp = new RoadmapUpdaterExperiment();
    const ev = evidence({
      roadmap_age_ms: 3 * 3600_000,
      noteworthy_signals: ['loop_health_fail'],
      loop_verdict: 'fail',
      violation_pool_today: 75,
    });
    const expectedFp = computeInputFingerprint(ev, []);
    const priorFinding: Finding = {
      id: 'prior-finding-id',
      experimentId: 'roadmap-updater',
      category: 'other',
      subject: 'meta:roadmap',
      hypothesis: null,
      verdict: 'warning',
      summary: 'prior',
      evidence: {},
      interventionApplied: {
        description: 'landed roadmap refresh abc',
        details: { stage: 'committed', inputFingerprint: expectedFp },
      },
      ranAt: new Date().toISOString(),
      durationMs: 0,
      status: 'active',
      supersededBy: null,
      createdAt: new Date().toISOString(),
    };
    const ctx = {
      db: null,
      workspaceId: 'test',
      engine: { modelRouter: {} },
      recentFindings: async () => [priorFinding],
    } as unknown as ExperimentContext;

    const result = await exp.intervene('warning', probe(ev), ctx);
    expect(result?.description).toBe('no_change_since_last_run');
    expect(result?.details.inputFingerprint).toBe(expectedFp);
    expect(runSpy).not.toHaveBeenCalled();
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
