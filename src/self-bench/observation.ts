/**
 * Deterministic auto-observation of the autonomous loop.
 *
 * This is the library that both `scripts/self-observe.ts` (CLI) and
 * `ObservationProbeExperiment` (in-daemon) call into. All DB-touching
 * reads are parameterised on caller input — the library itself is pure
 * over (git, filesystem, pre-fetched DB rows). The caller owns the
 * adapter/sqlite handle and feeds rows in.
 *
 * Stability contract
 * ------------------
 * - `Anomaly.code` values are enumerated constants (the downstream
 *   loop keys on these). Renaming a code is a breaking change.
 * - `Verdict` values are fixed: 'healthy' | 'quiet' | 'thrashing' |
 *   'degraded'.
 * - Adding a new anomaly code, verdict, or field on Observation is
 *   safe. Removing/renaming is not.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const ANOMALY_CODES = [
  'DAEMON_UNHEALTHY',
  'NO_AUTONOMOUS_COMMITS',
  'HIGH_REVERT_RATE',
  'CITES_SALES_SIGNAL_ABSENT',
  'ATTRIBUTION_FINDINGS_MISSING',
  'RUNTIME_CONFIG_PRODUCER_STALE',
  'PATCH_AUTHOR_TOP_PICK_NULL',
  'PATCH_AUTHOR_NOVELTY_REPEAT',
  'EXPERIMENT_FINDING_FLOOD',
  'NO_ACTIVE_PRIORITIES',
  'PRIORITY_WORK_LOG_STALE',
  'PATCHES_ATTEMPTED_TABLE_EMPTY',
  'SESSION_MARKER_PRESENT',
  // Tier-2 info codes — celebrate first-of-kind integration milestones
  // so operators see the research-ingest loop actually closing.
  'RESEARCH_CITED_IN_COMMIT',
] as const;

export type AnomalyCode = (typeof ANOMALY_CODES)[number];
export type Severity = 'info' | 'warn' | 'error';
export type Verdict = 'healthy' | 'quiet' | 'thrashing' | 'degraded';

export interface Anomaly {
  code: AnomalyCode;
  severity: Severity;
  detail: string;
}

export const THRESHOLDS = {
  HIGH_REVERT_RATE: 2,
  PATCH_AUTHOR_NOVELTY_REPEAT: 50,
  EXPERIMENT_FINDING_FLOOD: 1000,
} as const;

/**
 * A runtime_config_overrides key the anomaly detector expects to find
 * populated by a specific producer experiment on a known cadence.
 * Absent → emits `absence_anomaly_code` (so the historical
 * ATTRIBUTION_FINDINGS_MISSING code keeps its exact semantics for
 * external consumers). Present but last set longer ago than
 * `max_staleness_ms` → emits `RUNTIME_CONFIG_PRODUCER_STALE` with the
 * key + producer named in the detail so operators don't have to guess
 * which experiment regressed. Motivation: the 2026-04-16 incident
 * where attribution-observer was registered with runOnBoot=false and
 * the ranker's `strategy.attribution_findings` key stayed empty for
 * up to 6h after every daemon restart — no runtime_config_keys check
 * alone caught "key is present but the producer died." Fix commit
 * 0679030 unblocked that specific key; this registry is the general
 * machinery so the next runOnBoot-false regression isn't a surprise.
 */
export interface ConfigProducer {
  key: string;
  producer_experiment: string;
  max_staleness_ms: number;
  absence_anomaly_code: AnomalyCode;
}

export const PRODUCER_REGISTRY: readonly ConfigProducer[] = [
  {
    key: 'strategy.attribution_findings',
    producer_experiment: 'attribution-observer',
    // Producer cadence is 6h; allow a 1h grace window for a tick
    // that lands inside the sample (the detector itself runs at a
    // different, faster cadence). 7h without a write = producer is
    // wedged or unregistered.
    max_staleness_ms: 7 * 60 * 60 * 1000,
    absence_anomaly_code: 'ATTRIBUTION_FINDINGS_MISSING',
  },
];

/** One row from the runtime_config_overrides table, trimmed to the fields the detector reads. */
export interface RuntimeConfigEntry {
  set_by: string | null;
  set_at: string;
}

export interface CommitEntry {
  sha: string;
  subject: string;
  committed_at: string;
  experiment: string | null;
  trailers: Record<string, string>;
}

export interface CommitsReport {
  total: number;
  autonomous: number;
  by_trailer: Record<string, number>;
  entries: CommitEntry[];
}

export interface PatchesAttemptedReport {
  total: number;
  by_outcome: Record<string, number>;
}

export interface FindingsReport {
  total: number;
  by_experiment: Record<string, number>;
  flooding_experiments: Array<{ experiment: string; count: number }>;
}

export interface PrioritiesReport {
  active_slugs: string[];
  pending_slugs: string[];
  work_log_entries_added: number;
}

export interface RankerReport {
  last_ran_at: string | null;
  top_pick: unknown;
  novelty: { score: number; reason: string; repeat_count: number } | null;
  breakdown: Record<string, number> | null;
  rationale: string[] | null;
}

export interface DaemonReport {
  running: boolean;
  healthy: boolean;
  uptime_s: number | null;
  port: number;
}

export interface Observation {
  schema_version: 1;
  workspace: string;
  generated_at: string;
  window: { start: string; end: string; duration_s: number };
  daemon: DaemonReport;
  commits: CommitsReport;
  patches_attempted: PatchesAttemptedReport;
  findings: FindingsReport;
  priorities: PrioritiesReport;
  ranker: RankerReport;
  anomalies: Anomaly[];
  verdict: Verdict;
}

const TRAILER_CODES = [
  'Fixes-Finding-Id',
  'Cites-Sales-Signal',
  'Cites-Research-Paper',
  'Auto-Reverts',
  'Self-Authored-By',
  'Co-Authored-By',
] as const;

/** Parse trailers block in `Key: value` form. One key per line. */
export function parseTrailers(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z-]+):\s*(.+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * `git log --since=sinceIso` in the repo. `subject` matches the
 * conventional `Self-authored by experiment: <id>` prefix so the
 * experiment slug gets lifted out as a typed field. Autonomous count
 * unions that signal with the `ohwow-self-bench` co-author trailer —
 * either is enough to flag the commit as autonomous.
 *
 * Safe to call in an empty repo (returns a zero report). Timeouts and
 * buffer caps match roadmap-observer's conventions so a very active
 * loop can't stall the observation.
 */
export function probeCommits(repoRoot: string, sinceIso: string): CommitsReport {
  const SEP = '--OHWOW-SEP--';
  const FIELD = '--OHWOW-FIELD--';
  const format = `%H${FIELD}%ci${FIELD}%s${FIELD}%(trailers:unfold,separator=\n)`;
  let raw = '';
  try {
    raw = execFileSync(
      'git',
      ['log', `--since=${sinceIso}`, `--format=${format}${SEP}`, '--no-color'],
      { cwd: repoRoot, encoding: 'utf8', timeout: 15_000, maxBuffer: 10 * 1024 * 1024 },
    );
  } catch {
    return { total: 0, autonomous: 0, by_trailer: {}, entries: [] };
  }
  const entries: CommitEntry[] = [];
  const byTrailer: Record<string, number> = Object.fromEntries(TRAILER_CODES.map((k) => [k, 0]));
  let autonomous = 0;
  for (const chunk of raw.split(SEP)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const [sha, committed_at, subject, trailersRaw = ''] = trimmed.split(FIELD);
    const trailers = parseTrailers(trailersRaw);
    const coAuthor = trailers['Co-Authored-By'] ?? '';
    const isAutonomous = /ohwow-self-bench|self@ohwow\.local/.test(coAuthor);
    const experimentMatch = subject.match(/^Self-authored by experiment: ([a-z0-9-]+)/i);
    if (isAutonomous || experimentMatch) autonomous += 1;
    for (const code of TRAILER_CODES) {
      if (trailers[code]) byTrailer[code] += 1;
    }
    entries.push({
      sha: sha.slice(0, 7),
      subject,
      committed_at,
      experiment: experimentMatch ? experimentMatch[1] : null,
      trailers,
    });
  }
  return { total: entries.length, autonomous, by_trailer: byTrailer, entries };
}

/**
 * Read markdown priorities from `<dataDir>/priorities/`. Active and
 * pending slugs are split on frontmatter `status:`. `work_log_entries_added`
 * counts `### <iso>` headings under `## Work Log` dated at or after
 * sinceIso — the patch-author appends these when a commit matches a
 * priority's tags.
 */
export function probePriorities(dataDir: string | null, sinceIso: string): PrioritiesReport {
  const empty: PrioritiesReport = { active_slugs: [], pending_slugs: [], work_log_entries_added: 0 };
  if (!dataDir) return empty;
  const dir = path.join(dataDir, 'priorities');
  if (!fs.existsSync(dir)) return empty;
  const since = new Date(sinceIso).getTime();
  const active: string[] = [];
  const pending: string[] = [];
  let workLogAdded = 0;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md') || file === 'README.md') continue;
    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    const fm = body.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue;
    const status = (fm[1].match(/^status:\s*(\S+)/m) ?? [])[1];
    const slug = file.replace(/\.md$/, '');
    if (status === 'active') active.push(slug);
    else if (status === 'pending') pending.push(slug);
    const workLog = body.split(/^## Work Log/m)[1];
    if (workLog) {
      for (const m of workLog.matchAll(/^### (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z?)/gm)) {
        if (new Date(m[1]).getTime() >= since) workLogAdded += 1;
      }
    }
  }
  return { active_slugs: active, pending_slugs: pending, work_log_entries_added: workLogAdded };
}

/**
 * Pull top_pick.breakdown + __novelty out of the raw evidence JSON
 * string from the most recent patch-author finding. Tolerates malformed
 * JSON (returns empty report) because probe evidence is user-extensible
 * and we don't want one bad row to crash observation.
 */
export function parseRankerEvidence(ranAt: string | null, evidenceJson: string | null): RankerReport {
  if (!ranAt || !evidenceJson) {
    return { last_ran_at: null, top_pick: null, novelty: null, breakdown: null, rationale: null };
  }
  let ev: Record<string, unknown> = {};
  try {
    ev = JSON.parse(evidenceJson);
  } catch {
    // fall through — probe evidence may be non-JSON for some row shapes
  }
  const topPick = (ev as { top_pick?: unknown }).top_pick ?? null;
  const breakdown = (topPick && typeof topPick === 'object' && 'breakdown' in topPick)
    ? ((topPick as { breakdown: unknown }).breakdown as Record<string, number> | null)
    : null;
  const rationale = (topPick && typeof topPick === 'object' && 'rationale' in topPick)
    ? ((topPick as { rationale: unknown }).rationale as string[] | null)
    : null;
  const noveltyRaw = (ev as { __novelty?: { score?: number; reason?: string; repeat_count?: number } }).__novelty;
  const novelty = noveltyRaw
    ? {
        score: noveltyRaw.score ?? 0,
        reason: noveltyRaw.reason ?? '',
        repeat_count: noveltyRaw.repeat_count ?? 0,
      }
    : null;
  return { last_ran_at: ranAt, top_pick: topPick, novelty, breakdown, rationale };
}

export interface AnomalyInputs {
  daemon: DaemonReport;
  commits: CommitsReport;
  patches_attempted: PatchesAttemptedReport;
  findings: FindingsReport;
  priorities: PrioritiesReport;
  ranker: RankerReport;
  /**
   * Every key present in `runtime_config_overrides`, with the producer
   * experiment that last wrote it and the ISO timestamp of that write.
   * Callers that don't yet carry the full entry can pass a Set<string>
   * of keys — the detector treats those as "present but staleness
   * unknown" which preserves the pre-registry behavior.
   */
  runtime_config_entries: Map<string, RuntimeConfigEntry> | Set<string>;
  session_marker_exists: boolean;
  window_duration_s: number;
  /** When observation runs in-daemon, daemon health is trivially true — skip the probe. */
  skip_daemon_probe?: boolean;
  /** Epoch ms, injected by tests to make staleness deterministic. */
  now?: number;
}

export function detectAnomalies(inputs: AnomalyInputs): Anomaly[] {
  const out: Anomaly[] = [];
  if (!inputs.skip_daemon_probe && !inputs.daemon.healthy) {
    out.push({ code: 'DAEMON_UNHEALTHY', severity: 'error', detail: `port=${inputs.daemon.port}` });
  }
  if (inputs.commits.autonomous === 0) {
    out.push({
      code: 'NO_AUTONOMOUS_COMMITS',
      severity: 'warn',
      detail: `window=${inputs.window_duration_s}s`,
    });
  }
  const reverts = inputs.commits.by_trailer['Auto-Reverts'] ?? 0;
  if (reverts > THRESHOLDS.HIGH_REVERT_RATE) {
    out.push({ code: 'HIGH_REVERT_RATE', severity: 'error', detail: `reverts=${reverts}` });
  }
  const cites = inputs.commits.by_trailer['Cites-Sales-Signal'] ?? 0;
  if (inputs.commits.autonomous > 0 && cites === 0) {
    out.push({
      code: 'CITES_SALES_SIGNAL_ABSENT',
      severity: 'warn',
      detail: `autonomous=${inputs.commits.autonomous} cites=0`,
    });
  }
  const now = inputs.now ?? Date.now();
  const entries = inputs.runtime_config_entries;
  const entryFor = (key: string): RuntimeConfigEntry | 'present-unknown' | null => {
    if (entries instanceof Map) {
      return entries.get(key) ?? null;
    }
    // Legacy Set<string> callers: key presence only. Treat any hit as
    // "present but staleness unknown" so we can't falsely flag
    // RUNTIME_CONFIG_PRODUCER_STALE without real timestamp data.
    return entries.has(key) ? 'present-unknown' : null;
  };
  for (const producer of PRODUCER_REGISTRY) {
    const entry = entryFor(producer.key);
    if (entry === null) {
      out.push({
        code: producer.absence_anomaly_code,
        severity: 'warn',
        detail: `${producer.key} absent; expected producer=${producer.producer_experiment}`,
      });
      continue;
    }
    if (entry === 'present-unknown') continue;
    const ageMs = now - Date.parse(entry.set_at);
    if (Number.isFinite(ageMs) && ageMs > producer.max_staleness_ms) {
      const ageMin = Math.round(ageMs / 60000);
      const wroteBy = entry.set_by ?? 'unknown';
      out.push({
        code: 'RUNTIME_CONFIG_PRODUCER_STALE',
        severity: 'warn',
        detail: `${producer.key} last set ${ageMin}m ago by ${wroteBy}; expected producer=${producer.producer_experiment} every ${Math.round(producer.max_staleness_ms / 60000)}m`,
      });
    }
  }
  if (inputs.ranker.last_ran_at && inputs.ranker.top_pick === null) {
    out.push({
      code: 'PATCH_AUTHOR_TOP_PICK_NULL',
      severity: 'warn',
      detail: `last_ran_at=${inputs.ranker.last_ran_at}`,
    });
  }
  if (inputs.ranker.novelty && inputs.ranker.novelty.repeat_count > THRESHOLDS.PATCH_AUTHOR_NOVELTY_REPEAT) {
    out.push({
      code: 'PATCH_AUTHOR_NOVELTY_REPEAT',
      severity: 'warn',
      detail: `repeat_count=${inputs.ranker.novelty.repeat_count}`,
    });
  }
  for (const f of inputs.findings.flooding_experiments) {
    out.push({
      code: 'EXPERIMENT_FINDING_FLOOD',
      severity: 'warn',
      detail: `${f.experiment}=${f.count}`,
    });
  }
  if (inputs.priorities.active_slugs.length === 0) {
    out.push({ code: 'NO_ACTIVE_PRIORITIES', severity: 'info', detail: '' });
  } else if (inputs.priorities.work_log_entries_added === 0) {
    out.push({
      code: 'PRIORITY_WORK_LOG_STALE',
      severity: 'warn',
      detail: `active=${inputs.priorities.active_slugs.join(',')}`,
    });
  }
  if (inputs.patches_attempted.total === 0) {
    out.push({ code: 'PATCHES_ATTEMPTED_TABLE_EMPTY', severity: 'info', detail: '' });
  }
  if (inputs.session_marker_exists) {
    out.push({
      code: 'SESSION_MARKER_PRESENT',
      severity: 'info',
      detail: 'loop may defer autonomous commits',
    });
  }
  const researchCites = inputs.commits.by_trailer['Cites-Research-Paper'] ?? 0;
  if (researchCites > 0) {
    out.push({
      code: 'RESEARCH_CITED_IN_COMMIT',
      severity: 'info',
      detail: `cites=${researchCites}`,
    });
  }
  return out;
}

export interface VerdictInputs {
  daemon: DaemonReport;
  commits: CommitsReport;
  patches_attempted: PatchesAttemptedReport;
  anomalies: Anomaly[];
  skip_daemon_probe?: boolean;
}

export function computeVerdict(inputs: VerdictInputs): Verdict {
  if (!inputs.skip_daemon_probe && !inputs.daemon.healthy) return 'degraded';
  if (inputs.anomalies.some((a) => a.severity === 'error')) {
    const hasRevert = inputs.anomalies.some((a) => a.code === 'HIGH_REVERT_RATE');
    return hasRevert ? 'thrashing' : 'degraded';
  }
  if (inputs.commits.autonomous === 0 && inputs.patches_attempted.total === 0) return 'quiet';
  return 'healthy';
}

export interface AssembleObservationInput {
  workspace: string;
  generated_at: string;
  window: { start: string; end: string; duration_s: number };
  daemon: DaemonReport;
  commits: CommitsReport;
  patches_attempted: PatchesAttemptedReport;
  findings: FindingsReport;
  priorities: PrioritiesReport;
  ranker: RankerReport;
  runtime_config_entries: Map<string, RuntimeConfigEntry> | Set<string>;
  session_marker_exists: boolean;
  skip_daemon_probe?: boolean;
  now?: number;
}

export function assembleObservation(inputs: AssembleObservationInput): Observation {
  const anomalies = detectAnomalies({
    daemon: inputs.daemon,
    commits: inputs.commits,
    patches_attempted: inputs.patches_attempted,
    findings: inputs.findings,
    priorities: inputs.priorities,
    ranker: inputs.ranker,
    runtime_config_entries: inputs.runtime_config_entries,
    session_marker_exists: inputs.session_marker_exists,
    window_duration_s: inputs.window.duration_s,
    skip_daemon_probe: inputs.skip_daemon_probe,
    now: inputs.now,
  });
  const verdict = computeVerdict({
    daemon: inputs.daemon,
    commits: inputs.commits,
    patches_attempted: inputs.patches_attempted,
    anomalies,
    skip_daemon_probe: inputs.skip_daemon_probe,
  });
  return {
    schema_version: 1,
    workspace: inputs.workspace,
    generated_at: inputs.generated_at,
    window: inputs.window,
    daemon: inputs.daemon,
    commits: inputs.commits,
    patches_attempted: inputs.patches_attempted,
    findings: inputs.findings,
    priorities: inputs.priorities,
    ranker: inputs.ranker,
    anomalies,
    verdict,
  };
}
