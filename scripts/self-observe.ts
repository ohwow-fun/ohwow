/**
 * Deterministic observation snapshot of the autonomous loop (CLI).
 *
 * Run:    npx tsx scripts/self-observe.ts
 *         npx tsx scripts/self-observe.ts --workspace=avenued
 *         npx tsx scripts/self-observe.ts --window-minutes=60 --json
 *         npx tsx scripts/self-observe.ts --since-iso=2026-04-16T19:16:57Z
 *
 * Thin shell over `src/self-bench/observation.ts`. The CLI owns:
 *   - argv parsing
 *   - opening better-sqlite3 readonly and running the DB-side probes
 *     (patches_attempted_log, self_findings, runtime_config_overrides)
 *   - the HTTP /health probe against the workspace daemon
 *   - rendering text or JSON
 *
 * The library owns the commit/priority probes, anomaly detection, and
 * verdict so the in-daemon ObservationProbeExperiment reuses the same
 * deterministic rules.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import Database from 'better-sqlite3';
import { workspaceLayoutFor, portForWorkspace } from '../src/config.js';
import {
  assembleObservation,
  parseRankerEvidence,
  probeCommits,
  probePriorities,
  type DaemonReport,
  type FindingsReport,
  type Observation,
  type PatchesAttemptedReport,
} from '../src/self-bench/observation.js';

// ---------- CLI args ----------

interface Args {
  workspace: string;
  windowMinutes: number;
  sinceIso: string | null;
  emitJson: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? null;
  return {
    workspace: get('workspace') ?? 'default',
    windowMinutes: Number(get('window-minutes') ?? 30),
    sinceIso: get('since-iso'),
    emitJson: argv.includes('--json'),
  };
}

// ---------- Daemon probe (CLI-only) ----------

function probeDaemonOnce(port: number, timeoutMs: number): Promise<DaemonReport> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve({
            running: true,
            healthy: j.status === 'healthy',
            uptime_s: typeof j.uptime === 'number' ? j.uptime : null,
            port,
          });
        } catch {
          resolve({ running: true, healthy: false, uptime_s: null, port });
        }
      });
    });
    req.on('error', () => resolve({ running: false, healthy: false, uptime_s: null, port }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ running: false, healthy: false, uptime_s: null, port });
    });
  });
}

async function probeDaemon(port: number): Promise<DaemonReport> {
  // Two attempts; the daemon is single-threaded Node and an experiment tick
  // can tie up the event loop briefly. Without a retry, identical state can
  // emit either healthy or unhealthy, breaking the determinism claim.
  const first = await probeDaemonOnce(port, 2500);
  if (first.healthy) return first;
  await new Promise((r) => setTimeout(r, 500));
  const second = await probeDaemonOnce(port, 5000);
  return second.healthy ? second : first;
}

// ---------- DB probes (CLI uses better-sqlite3 directly) ----------

function probePatchesAttempted(db: Database.Database, sinceIso: string): PatchesAttemptedReport {
  const rows = db
    .prepare(
      `SELECT outcome, COUNT(*) as c FROM patches_attempted_log
       WHERE proposed_at > ? GROUP BY outcome`,
    )
    .all(sinceIso) as Array<{ outcome: string; c: number }>;
  const byOutcome: Record<string, number> = { pending: 0, held: 0, reverted: 0 };
  let total = 0;
  for (const r of rows) {
    byOutcome[r.outcome] = r.c;
    total += r.c;
  }
  return { total, by_outcome: byOutcome };
}

function probeFindings(db: Database.Database, sinceIso: string): FindingsReport {
  const rows = db
    .prepare(
      `SELECT experiment_id as experiment, COUNT(*) as c FROM self_findings
       WHERE ran_at > ? GROUP BY experiment_id ORDER BY c DESC`,
    )
    .all(sinceIso) as Array<{ experiment: string; c: number }>;
  const byExperiment: Record<string, number> = {};
  let total = 0;
  const flooding: Array<{ experiment: string; count: number }> = [];
  for (const r of rows) {
    byExperiment[r.experiment] = r.c;
    total += r.c;
    if (r.c > 1000) flooding.push({ experiment: r.experiment, count: r.c });
  }
  return { total, by_experiment: byExperiment, flooding_experiments: flooding };
}

function readRanker(db: Database.Database): ReturnType<typeof parseRankerEvidence> {
  const row = db
    .prepare(
      `SELECT ran_at, evidence FROM self_findings
       WHERE experiment_id='patch-author' ORDER BY ran_at DESC LIMIT 1`,
    )
    .get() as { ran_at: string; evidence: string } | undefined;
  return parseRankerEvidence(row?.ran_at ?? null, row?.evidence ?? null);
}

function readRuntimeEntries(
  db: Database.Database,
): Map<string, { set_by: string | null; set_at: string }> {
  const rows = db
    .prepare(`SELECT key, set_by, set_at FROM runtime_config_overrides`)
    .all() as Array<{ key: string; set_by: string | null; set_at: string }>;
  const out = new Map<string, { set_by: string | null; set_at: string }>();
  for (const r of rows) {
    out.set(r.key, { set_by: r.set_by, set_at: r.set_at });
  }
  return out;
}

// ---------- Main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const layout = workspaceLayoutFor(args.workspace);
  const port = portForWorkspace(args.workspace);
  const now = new Date();
  const start = args.sinceIso
    ? new Date(args.sinceIso)
    : new Date(now.getTime() - args.windowMinutes * 60_000);
  const startIso = start.toISOString();
  const endIso = now.toISOString();

  const db = new Database(layout.dbPath, { readonly: true });
  try {
    const daemon = await probeDaemon(port);
    const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
    const commits = probeCommits(repoRoot, startIso);
    const patches = probePatchesAttempted(db, startIso);
    const findings = probeFindings(db, startIso);
    const priorities = probePriorities(layout.dataDir, startIso);
    const ranker = readRanker(db);
    const runtimeEntries = readRuntimeEntries(db);
    const sessionMarkerExists = fs.existsSync(path.join(repoRoot, '.git', 'ohwow-session-live'));

    const obs: Observation = assembleObservation({
      workspace: args.workspace,
      generated_at: endIso,
      window: {
        start: startIso,
        end: endIso,
        duration_s: Math.round((now.getTime() - start.getTime()) / 1000),
      },
      daemon,
      commits,
      patches_attempted: patches,
      findings,
      priorities,
      ranker,
      runtime_config_entries: runtimeEntries,
      session_marker_exists: sessionMarkerExists,
    });

    if (args.emitJson) {
      process.stdout.write(JSON.stringify(obs, null, 2) + '\n');
    } else {
      renderText(obs);
    }
  } finally {
    db.close();
  }
}

function renderText(obs: Observation): void {
  const lines: string[] = [];
  lines.push(`[self-observe] workspace=${obs.workspace} verdict=${obs.verdict}`);
  lines.push(`  window: ${obs.window.start} → ${obs.window.end} (${obs.window.duration_s}s)`);
  lines.push(
    `  daemon: running=${obs.daemon.running} healthy=${obs.daemon.healthy} uptime_s=${obs.daemon.uptime_s}`,
  );
  lines.push(
    `  commits: total=${obs.commits.total} autonomous=${obs.commits.autonomous}` +
      ` fixes=${obs.commits.by_trailer['Fixes-Finding-Id'] ?? 0}` +
      ` cites_sales=${obs.commits.by_trailer['Cites-Sales-Signal'] ?? 0}` +
      ` reverts=${obs.commits.by_trailer['Auto-Reverts'] ?? 0}`,
  );
  lines.push(
    `  patches_attempted: total=${obs.patches_attempted.total} ` +
      Object.entries(obs.patches_attempted.by_outcome)
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
  );
  const topFindings = Object.entries(obs.findings.by_experiment)
    .slice(0, 5)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  lines.push(`  findings: total=${obs.findings.total} top5: ${topFindings}`);
  lines.push(
    `  priorities: active=[${obs.priorities.active_slugs.join(',')}] ` +
      `pending=[${obs.priorities.pending_slugs.join(',')}] ` +
      `work_log_added=${obs.priorities.work_log_entries_added}`,
  );
  if (obs.ranker.last_ran_at) {
    lines.push(
      `  ranker: last=${obs.ranker.last_ran_at} top_pick=${
        obs.ranker.top_pick ? 'present' : 'null'
      } novelty_repeat=${obs.ranker.novelty?.repeat_count ?? 0}`,
    );
  } else {
    lines.push('  ranker: no patch-author findings yet');
  }
  lines.push(`  anomalies (${obs.anomalies.length}):`);
  for (const a of obs.anomalies) {
    lines.push(`    [${a.severity}] ${a.code} ${a.detail}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

main().catch((err) => {
  process.stderr.write(
    `[self-observe] failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
