import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  assembleObservation,
  computeVerdict,
  detectAnomalies,
  parseRankerEvidence,
  parseTrailers,
  probeCommits,
  probePriorities,
  THRESHOLDS,
  type CommitsReport,
  type DaemonReport,
  type FindingsReport,
  type PatchesAttemptedReport,
  type PrioritiesReport,
  type RankerReport,
} from '../observation.js';

let tempRoot: string;

function initRepo(root: string) {
  execSync('git init -b main', { cwd: root, stdio: 'pipe' });
  execSync('git config user.email "t@t.local"', { cwd: root, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: root, stdio: 'pipe' });
  execSync('git config commit.gpgsign false', { cwd: root, stdio: 'pipe' });
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n');
  execSync('git add seed.txt', { cwd: root, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: root, stdio: 'pipe' });
}

function commitWith(subject: string, body?: string) {
  fs.writeFileSync(path.join(tempRoot, 'f-' + Math.random().toString(36).slice(2) + '.txt'), 'x');
  execSync('git add .', { cwd: tempRoot, stdio: 'pipe' });
  const msg = body ? `${subject}\n\n${body}\n` : subject;
  const msgPath = path.join(tempRoot, '.commit-msg');
  fs.writeFileSync(msgPath, msg);
  execSync(`git commit -F ${JSON.stringify(msgPath)}`, { cwd: tempRoot, stdio: 'pipe' });
  fs.unlinkSync(msgPath);
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-'));
  initRepo(tempRoot);
});

afterEach(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('parseTrailers', () => {
  it('parses Key: value per line and trims', () => {
    const t = parseTrailers('Fixes-Finding-Id: abc-123\nCo-Authored-By: ohwow-self-bench <x>');
    expect(t['Fixes-Finding-Id']).toBe('abc-123');
    expect(t['Co-Authored-By']).toContain('ohwow-self-bench');
  });

  it('ignores malformed lines', () => {
    const t = parseTrailers('not a trailer\nFoo: bar');
    expect(Object.keys(t)).toEqual(['Foo']);
  });
});

describe('probeCommits', () => {
  it('flags autonomous commits via the ohwow-self-bench co-author trailer', () => {
    commitWith(
      'feat(self-bench): patch AUTONOMY_ROADMAP.md for finding abc',
      'Co-Authored-By: ohwow-self-bench <self@ohwow.local>\nFixes-Finding-Id: abc-def',
    );
    commitWith('chore: human commit');
    const r: CommitsReport = probeCommits(tempRoot, '1970-01-01T00:00:00Z');
    // init + 2 commits = 3
    expect(r.total).toBe(3);
    expect(r.autonomous).toBe(1);
    expect(r.by_trailer['Fixes-Finding-Id']).toBe(1);
    expect(r.by_trailer['Auto-Reverts']).toBe(0);
  });

  it('lifts experiment slug from "Self-authored by experiment: <slug>" subjects', () => {
    commitWith('Self-authored by experiment: patch-author rewrite AUTONOMY_ROADMAP.md');
    const r = probeCommits(tempRoot, '1970-01-01T00:00:00Z');
    const auto = r.entries.find((e) => e.experiment === 'patch-author');
    expect(auto).toBeDefined();
    expect(r.autonomous).toBe(1);
  });

  it('windows by since-iso — past-window commits are excluded', () => {
    // Seed commit happened during initRepo, which ran just now. An iso in
    // the far future should yield zero commits.
    const future = new Date(Date.now() + 60_000).toISOString();
    const r = probeCommits(tempRoot, future);
    expect(r.total).toBe(0);
  });
});

describe('probePriorities', () => {
  it('splits active and pending by frontmatter status', () => {
    const dir = path.join(tempRoot, 'priorities');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'alpha.md'),
      '---\ntitle: Alpha\nstatus: active\n---\n\n## Work Log\n',
    );
    fs.writeFileSync(
      path.join(dir, 'beta.md'),
      '---\ntitle: Beta\nstatus: pending\n---\n',
    );
    fs.writeFileSync(path.join(dir, 'README.md'), '# ignore me\n');
    const r: PrioritiesReport = probePriorities(tempRoot, '1970-01-01T00:00:00Z');
    expect(r.active_slugs).toEqual(['alpha']);
    expect(r.pending_slugs).toEqual(['beta']);
  });

  it('counts dated work-log entries at or after sinceIso', () => {
    const dir = path.join(tempRoot, 'priorities');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'alpha.md'),
      [
        '---',
        'status: active',
        '---',
        '',
        '## Work Log',
        '',
        '### 2025-01-01T00:00:00Z',
        'old entry',
        '',
        '### 2026-04-16T19:00:00Z',
        'newer',
        '',
        '### 2026-04-16T19:20:00Z',
        'newest',
      ].join('\n'),
    );
    const r = probePriorities(tempRoot, '2026-04-16T19:00:00Z');
    // sinceIso inclusive — both 19:00 and 19:20 count, old entry excluded
    expect(r.work_log_entries_added).toBe(2);
  });

  it('returns empty when dataDir is null or priorities dir is missing', () => {
    expect(probePriorities(null, '1970-01-01T00:00:00Z').active_slugs).toEqual([]);
    expect(probePriorities(tempRoot, '1970-01-01T00:00:00Z').active_slugs).toEqual([]);
  });
});

describe('parseRankerEvidence', () => {
  it('extracts top_pick.breakdown + rationale and __novelty', () => {
    const ev = JSON.stringify({
      top_pick: {
        breakdown: { revenue_proximity: 0, evidence_strength: 1, blast_radius: 0.75, recency: 0.99, priority_match: 0 },
        rationale: ['+2.00 evidence strength', '-0.75 blast radius'],
      },
      __novelty: { score: 0, reason: 'normal', repeat_count: 116 },
    });
    const r: RankerReport = parseRankerEvidence('2026-04-16T19:15:28Z', ev);
    expect(r.last_ran_at).toBe('2026-04-16T19:15:28Z');
    expect(r.breakdown?.evidence_strength).toBe(1);
    expect(r.rationale?.[0]).toContain('evidence strength');
    expect(r.novelty?.repeat_count).toBe(116);
  });

  it('returns zero state on malformed JSON', () => {
    const r = parseRankerEvidence('2026-04-16T19:15:28Z', '{not json');
    expect(r.breakdown).toBeNull();
    expect(r.novelty).toBeNull();
  });

  it('returns empty state when no findings exist', () => {
    const r = parseRankerEvidence(null, null);
    expect(r.last_ran_at).toBeNull();
  });
});

// Shared fixture builder — keeps per-test Anomaly/Verdict inputs concise.
function fixtureInputs(overrides: {
  daemon?: Partial<DaemonReport>;
  commits?: Partial<CommitsReport>;
  patches?: Partial<PatchesAttemptedReport>;
  findings?: Partial<FindingsReport>;
  priorities?: Partial<PrioritiesReport>;
  ranker?: Partial<RankerReport>;
  runtime_keys?: string[];
  session_marker?: boolean;
  skip_daemon?: boolean;
}) {
  const daemon: DaemonReport = {
    running: true,
    healthy: true,
    uptime_s: 100,
    port: 7700,
    ...overrides.daemon,
  };
  const commits: CommitsReport = {
    total: 1,
    autonomous: 1,
    by_trailer: { 'Fixes-Finding-Id': 1, 'Cites-Sales-Signal': 0, 'Auto-Reverts': 0 },
    entries: [],
    ...overrides.commits,
  };
  const patches_attempted: PatchesAttemptedReport = {
    total: 1,
    by_outcome: { pending: 1, held: 0, reverted: 0 },
    ...overrides.patches,
  };
  const findings: FindingsReport = {
    total: 0,
    by_experiment: {},
    flooding_experiments: [],
    ...overrides.findings,
  };
  const priorities: PrioritiesReport = {
    active_slugs: ['p1'],
    pending_slugs: [],
    work_log_entries_added: 1,
    ...overrides.priorities,
  };
  const ranker: RankerReport = {
    last_ran_at: '2026-04-16T19:15:28Z',
    top_pick: {},
    novelty: { score: 0, reason: 'normal', repeat_count: 5 },
    breakdown: { evidence_strength: 1 },
    rationale: null,
    ...overrides.ranker,
  };
  return {
    daemon,
    commits,
    patches_attempted,
    findings,
    priorities,
    ranker,
    runtime_config_keys: new Set([
      'strategy.attribution_findings',
      ...(overrides.runtime_keys ?? []),
    ]),
    session_marker_exists: overrides.session_marker ?? false,
    window_duration_s: 1800,
    skip_daemon_probe: overrides.skip_daemon ?? false,
  };
}

describe('detectAnomalies', () => {
  it('emits zero anomalies on a clean healthy window', () => {
    const inputs = fixtureInputs({
      commits: {
        total: 2,
        autonomous: 1,
        by_trailer: { 'Fixes-Finding-Id': 1, 'Cites-Sales-Signal': 1, 'Auto-Reverts': 0 },
        entries: [],
      },
    });
    const a = detectAnomalies(inputs);
    expect(a).toEqual([]);
  });

  it('flags HIGH_REVERT_RATE at severity=error when reverts > threshold', () => {
    const reverts = THRESHOLDS.HIGH_REVERT_RATE + 1;
    const inputs = fixtureInputs({
      commits: {
        total: 5,
        autonomous: 5,
        by_trailer: { 'Fixes-Finding-Id': 0, 'Cites-Sales-Signal': 1, 'Auto-Reverts': reverts },
        entries: [],
      },
    });
    const a = detectAnomalies(inputs);
    const revert = a.find((x) => x.code === 'HIGH_REVERT_RATE');
    expect(revert?.severity).toBe('error');
  });

  it('flags ATTRIBUTION_FINDINGS_MISSING when the runtime-config key is absent', () => {
    const inputs = fixtureInputs({ runtime_keys: [] }); // also removes the default
    // Need to override the default — build manually
    const customInputs = { ...inputs, runtime_config_keys: new Set<string>() };
    const a = detectAnomalies(customInputs);
    expect(a.some((x) => x.code === 'ATTRIBUTION_FINDINGS_MISSING')).toBe(true);
  });

  it('flags PATCH_AUTHOR_NOVELTY_REPEAT above threshold', () => {
    const inputs = fixtureInputs({
      ranker: {
        last_ran_at: '2026-04-16T19:15:28Z',
        top_pick: {},
        novelty: { score: 0, reason: 'normal', repeat_count: THRESHOLDS.PATCH_AUTHOR_NOVELTY_REPEAT + 1 },
        breakdown: null,
        rationale: null,
      },
    });
    const a = detectAnomalies(inputs);
    expect(a.some((x) => x.code === 'PATCH_AUTHOR_NOVELTY_REPEAT')).toBe(true);
  });

  it('skips DAEMON_UNHEALTHY when skip_daemon_probe is true', () => {
    const inputs = fixtureInputs({
      daemon: { healthy: false },
      skip_daemon: true,
    });
    const a = detectAnomalies(inputs);
    expect(a.some((x) => x.code === 'DAEMON_UNHEALTHY')).toBe(false);
  });

  it('flags PRIORITY_WORK_LOG_STALE only when there is an active priority with no entries', () => {
    const inputs = fixtureInputs({
      priorities: {
        active_slugs: ['alpha'],
        pending_slugs: [],
        work_log_entries_added: 0,
      },
    });
    const a = detectAnomalies(inputs);
    expect(a.some((x) => x.code === 'PRIORITY_WORK_LOG_STALE')).toBe(true);
    expect(a.some((x) => x.code === 'NO_ACTIVE_PRIORITIES')).toBe(false);
  });
});

describe('computeVerdict', () => {
  const base = {
    daemon: { running: true, healthy: true, uptime_s: 10, port: 7700 } as DaemonReport,
    commits: {
      total: 1,
      autonomous: 1,
      by_trailer: {},
      entries: [],
    } as CommitsReport,
    patches_attempted: { total: 0, by_outcome: {} } as PatchesAttemptedReport,
  };

  it('healthy when commits present and no error anomalies', () => {
    expect(computeVerdict({ ...base, anomalies: [] })).toBe('healthy');
  });

  it('quiet when no commits and no patches, regardless of info anomalies', () => {
    expect(
      computeVerdict({
        ...base,
        commits: { ...base.commits, total: 0, autonomous: 0 },
        anomalies: [{ code: 'NO_ACTIVE_PRIORITIES', severity: 'info', detail: '' }],
      }),
    ).toBe('quiet');
  });

  it('thrashing when HIGH_REVERT_RATE fires', () => {
    expect(
      computeVerdict({
        ...base,
        anomalies: [{ code: 'HIGH_REVERT_RATE', severity: 'error', detail: 'reverts=5' }],
      }),
    ).toBe('thrashing');
  });

  it('degraded when an error anomaly fires that is not revert-rate', () => {
    expect(
      computeVerdict({
        ...base,
        anomalies: [{ code: 'DAEMON_UNHEALTHY', severity: 'error', detail: '' }],
      }),
    ).toBe('degraded');
  });

  it('degraded when daemon is unhealthy and skip_daemon_probe is false', () => {
    expect(
      computeVerdict({
        ...base,
        daemon: { ...base.daemon, healthy: false },
        anomalies: [],
      }),
    ).toBe('degraded');
  });
});

describe('assembleObservation', () => {
  it('stamps schema_version=1 and integrates anomalies + verdict', () => {
    const inputs = fixtureInputs({
      commits: {
        total: 3,
        autonomous: 2,
        by_trailer: { 'Fixes-Finding-Id': 2, 'Cites-Sales-Signal': 1, 'Auto-Reverts': 0 },
        entries: [],
      },
    });
    const obs = assembleObservation({
      workspace: 'default',
      generated_at: '2026-04-16T19:30:00Z',
      window: { start: '2026-04-16T19:00:00Z', end: '2026-04-16T19:30:00Z', duration_s: 1800 },
      ...inputs,
    });
    expect(obs.schema_version).toBe(1);
    expect(obs.verdict).toBe('healthy');
    expect(Array.isArray(obs.anomalies)).toBe(true);
  });
});
