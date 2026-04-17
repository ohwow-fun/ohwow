/**
 * seed-lift-measurements — synthetic row generator for the Phase 5
 * credit-assignment ledger.
 *
 * Phase 5 wires outcome KPIs into the autonomous loop, but the ledger
 * only populates after an autonomous commit to a revenue-adjacent
 * tier-2 file closes its horizon (24h–168h). Until that happens, the
 * strategist's lift-health branch is dormant and Phase 5d's
 * ranker-weight-from-lift work has no distribution to validate
 * against. This script seeds plausible closed rows so the loop's
 * downstream consumers can be exercised end-to-end in minutes
 * instead of days.
 *
 * Rows are tagged `source_experiment_id='seed-synthetic'` and
 * `commit_sha='seed-<hex>'` so `clean` can drop them without touching
 * any real commit's measurements.
 *
 * Usage:
 *   npx tsx scripts/seed-lift-measurements.ts seed [--count N] [--mode MODE]
 *   npx tsx scripts/seed-lift-measurements.ts clean
 *   npx tsx scripts/seed-lift-measurements.ts status
 *
 *   --count N         how many rows to insert (default 8)
 *   --mode MODE       'healthy' (mostly moved_right, default),
 *                     'regression' (mostly moved_wrong — exercises the
 *                      strategist's demote branch),
 *                     'mixed' (balanced — strategist stays neutral)
 */

import crypto from 'node:crypto';
import { initDatabase } from '../src/db/init.js';
import { createSqliteAdapter } from '../src/db/sqlite-adapter.js';
import { loadConfig, resolveActiveWorkspace } from '../src/config.js';
import { signedLift } from '../src/self-bench/kpi-registry.js';
import {
  verdictForLift,
  type ExpectedDirection,
  type LiftVerdict,
} from '../src/self-bench/lift-measurements-store.js';

const SEED_MARKER = 'seed-synthetic';
const SEED_COMMIT_PREFIX = 'seed-';

type Mode = 'healthy' | 'regression' | 'mixed';

interface SeedPlan {
  moved_right: number;
  moved_wrong: number;
  flat: number;
}

function planFor(mode: Mode, count: number): SeedPlan {
  // Per-mode composition. All add up to `count`; rounding goes to
  // moved_right (healthy/mixed) or moved_wrong (regression) so the
  // sign of the net ratio matches the mode label even for odd counts.
  if (mode === 'regression') {
    const wrong = Math.ceil(count * 0.625); // 5/8 → net ratio ~-0.37
    const right = Math.floor(count * 0.25);
    const flat = count - wrong - right;
    return { moved_right: right, moved_wrong: wrong, flat };
  }
  if (mode === 'mixed') {
    const right = Math.round(count * 0.375);
    const wrong = Math.round(count * 0.375);
    const flat = count - right - wrong;
    return { moved_right: right, moved_wrong: wrong, flat };
  }
  // healthy
  const right = Math.ceil(count * 0.75);
  const wrong = Math.floor(count * 0.125);
  const flat = count - right - wrong;
  return { moved_right: right, moved_wrong: wrong, flat };
}

// ----------------------------------------------------------------------------
// Per-KPI value model. Kept coarse on purpose — the strategist reads
// verdict counts, not raw magnitudes. Each entry names a plausible
// baseline and per-verdict delta comfortably outside the verdict
// tolerance (cents=50, count=1, ratio=0.02) so the synthetic
// signed_lift matches the intended verdict.

interface KpiModel {
  kpiId: string;
  baseline: number;
  movedDelta: number; // |delta| when moved_right/moved_wrong
  flatDelta: number;  // |delta| when flat (below tolerance)
}

const KPI_MODELS: readonly KpiModel[] = [
  { kpiId: 'reply_ratio_24h', baseline: 0.15, movedDelta: 0.05, flatDelta: 0.005 },
  { kpiId: 'qualified_events_24h', baseline: 3, movedDelta: 3, flatDelta: 0 },
  { kpiId: 'active_leads', baseline: 10, movedDelta: 4, flatDelta: 0 },
  { kpiId: 'revenue_cents_24h', baseline: 5000, movedDelta: 600, flatDelta: 10 },
];

const HORIZONS = [1, 24, 168] as const;

// ----------------------------------------------------------------------------
// Args

function parseArgs(argv: string[]): {
  sub: 'seed' | 'clean' | 'status' | 'help';
  count: number;
  mode: Mode;
} {
  const first = argv[0] ?? 'help';
  if (first === '-h' || first === '--help') return { sub: 'help', count: 8, mode: 'healthy' };
  if (first !== 'seed' && first !== 'clean' && first !== 'status' && first !== 'help') {
    return { sub: 'help', count: 8, mode: 'healthy' };
  }
  const sub = first;
  let count = 8;
  let mode: Mode = 'healthy';
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--count' && argv[i + 1]) {
      count = Math.max(1, Math.floor(Number(argv[i + 1])));
      i += 1;
    } else if (a === '--mode' && argv[i + 1]) {
      const m = argv[i + 1];
      if (m !== 'healthy' && m !== 'regression' && m !== 'mixed') {
        throw new Error(`--mode must be healthy|regression|mixed (got ${m})`);
      }
      mode = m;
      i += 1;
    } else if (a === '-h' || a === '--help') {
      return { sub: 'help', count, mode };
    }
  }
  return { sub, count, mode };
}

function printHelp(): void {
  process.stdout.write(
    [
      'seed-lift-measurements — inject synthetic closed lift_measurements rows.',
      '',
      'Commands:',
      '  seed [--count N] [--mode healthy|regression|mixed]',
      '        Insert N closed rows. Default: 8 rows, healthy distribution.',
      '  clean',
      '        Delete every row with source_experiment_id=seed-synthetic.',
      '  status',
      '        Show synthetic vs real row counts for the active workspace.',
      '',
      'All synthetic rows land in the active workspace only. Use',
      '  ohwow workspace use <name>',
      'to switch focus before running.',
      '',
    ].join('\n'),
  );
}

// ----------------------------------------------------------------------------
// Build one row

interface BuiltRow {
  workspace_id: string;
  commit_sha: string;
  kpi_id: string;
  expected_direction: ExpectedDirection;
  horizon_hours: number;
  baseline_value: number;
  baseline_at: string;
  measure_at: string;
  post_value: number;
  post_at: string;
  signed_lift: number;
  verdict: LiftVerdict;
  source_experiment_id: string;
}

function pick<T>(xs: readonly T[], i: number): T {
  return xs[i % xs.length]!;
}

function buildRow(
  workspaceId: string,
  rowIdx: number,
  targetVerdict: 'moved_right' | 'moved_wrong' | 'flat',
  nowMs: number,
): BuiltRow {
  const model = pick(KPI_MODELS, rowIdx);
  const horizon = pick(HORIZONS, rowIdx);
  // Spread baseline_at / post_at across the last ~3 days so the 24h
  // rolling window (strategist reads 7d; lift-measurement emits 24h
  // rolling) sees a realistic distribution. Each row sits comfortably
  // inside its own horizon: baseline_at = now - horizon - slot_offset.
  const slotMinutes = rowIdx * 37; // coprime-ish spread
  const baselineMs = nowMs - horizon * 3600 * 1000 - slotMinutes * 60 * 1000;
  const measureMs = baselineMs + horizon * 3600 * 1000;
  const postMs = measureMs + 30 * 1000; // "closed 30s after due" — recent enough for 24h window

  // Higher_is_better model: "right" = post > baseline. All four KPIs
  // in KPI_MODELS are higher_is_better so the sign rules are direct.
  const delta =
    targetVerdict === 'moved_right'
      ? model.movedDelta
      : targetVerdict === 'moved_wrong'
        ? -model.movedDelta
        : model.flatDelta; // flat: small positive within tolerance
  const postValue = model.baseline + delta;

  const lift = signedLift(model.kpiId, model.baseline, postValue);
  const verdict = verdictForLift(model.kpiId, lift, 'up');

  return {
    workspace_id: workspaceId,
    commit_sha: `${SEED_COMMIT_PREFIX}${crypto.randomBytes(6).toString('hex')}`,
    kpi_id: model.kpiId,
    expected_direction: 'up',
    horizon_hours: horizon,
    baseline_value: model.baseline,
    baseline_at: new Date(baselineMs).toISOString(),
    measure_at: new Date(measureMs).toISOString(),
    post_value: postValue,
    post_at: new Date(postMs).toISOString(),
    signed_lift: lift ?? 0,
    verdict,
    source_experiment_id: SEED_MARKER,
  };
}

// ----------------------------------------------------------------------------
// Runners

async function runSeed(count: number, mode: Mode): Promise<void> {
  const plan = planFor(mode, count);
  const total = plan.moved_right + plan.moved_wrong + plan.flat;
  const config = loadConfig();
  const rawDb = initDatabase(config.dbPath);
  const db = createSqliteAdapter(rawDb);

  const wsRow = rawDb
    .prepare('SELECT id FROM agent_workforce_workspaces LIMIT 1')
    .get() as { id: string } | undefined;
  if (!wsRow?.id) {
    console.error('[seed] no workspace row found — run `ohwow` once to initialize.');
    process.exit(1);
  }
  const workspaceId = wsRow.id;
  console.log(
    `[seed] workspace=${resolveActiveWorkspace().name} id=${workspaceId} mode=${mode} count=${total} plan=${JSON.stringify(plan)}`,
  );

  const order: Array<'moved_right' | 'moved_wrong' | 'flat'> = [];
  for (let i = 0; i < plan.moved_right; i += 1) order.push('moved_right');
  for (let i = 0; i < plan.moved_wrong; i += 1) order.push('moved_wrong');
  for (let i = 0; i < plan.flat; i += 1) order.push('flat');

  const now = Date.now();
  let inserted = 0;
  const verdictCounts: Record<string, number> = {};
  for (let i = 0; i < order.length; i += 1) {
    const row = buildRow(workspaceId, i, order[i]!, now);
    verdictCounts[row.verdict] = (verdictCounts[row.verdict] ?? 0) + 1;
    const { error } = await db.from('lift_measurements').insert(row);
    if (error) {
      console.error(`[seed] insert failed at row ${i}: ${error.message}`);
      process.exit(1);
    }
    inserted += 1;
  }
  console.log(`[seed] inserted=${inserted} verdicts=${JSON.stringify(verdictCounts)}`);
  const netRatio =
    total > 0
      ? ((verdictCounts.moved_right ?? 0) - (verdictCounts.moved_wrong ?? 0)) / total
      : 0;
  console.log(
    `[seed] net_signed_ratio=${netRatio.toFixed(3)} (strategist demotes patch-author when ratio <= -0.2 with >=5 samples).`,
  );
}

async function runClean(): Promise<void> {
  const config = loadConfig();
  const rawDb = initDatabase(config.dbPath);
  const db = createSqliteAdapter(rawDb);

  const wsRow = rawDb
    .prepare('SELECT id FROM agent_workforce_workspaces LIMIT 1')
    .get() as { id: string } | undefined;
  if (!wsRow?.id) {
    console.error('[clean] no workspace row found.');
    process.exit(1);
  }
  const workspaceId = wsRow.id;
  const { error } = await db
    .from('lift_measurements')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('source_experiment_id', SEED_MARKER);
  if (error) {
    console.error(`[clean] failed: ${error.message}`);
    process.exit(1);
  }
  console.log(
    `[clean] deleted all source_experiment_id=${SEED_MARKER} rows for workspace ${workspaceId}`,
  );
}

async function runStatus(): Promise<void> {
  const config = loadConfig();
  const rawDb = initDatabase(config.dbPath);
  const db = createSqliteAdapter(rawDb);
  const wsRow = rawDb
    .prepare('SELECT id FROM agent_workforce_workspaces LIMIT 1')
    .get() as { id: string } | undefined;
  if (!wsRow?.id) {
    console.error('[status] no workspace row found.');
    process.exit(1);
  }
  const workspaceId = wsRow.id;

  const { data: all } = await db
    .from<{ verdict: LiftVerdict | null; source_experiment_id: string | null }>('lift_measurements')
    .select('verdict, source_experiment_id')
    .eq('workspace_id', workspaceId)
    .limit(10000);
  const rows = (all ?? []) as Array<{ verdict: LiftVerdict | null; source_experiment_id: string | null }>;
  const synthetic = rows.filter((r) => r.source_experiment_id === SEED_MARKER);
  const real = rows.filter((r) => r.source_experiment_id !== SEED_MARKER);
  const tally = (xs: typeof rows): Record<string, number> => {
    const t: Record<string, number> = { moved_right: 0, moved_wrong: 0, flat: 0, unmeasured: 0, pending: 0 };
    for (const r of xs) t[r.verdict ?? 'pending'] = (t[r.verdict ?? 'pending'] ?? 0) + 1;
    return t;
  };
  console.log(`[status] workspace=${workspaceId}`);
  console.log(`[status] synthetic rows=${synthetic.length} ${JSON.stringify(tally(synthetic))}`);
  console.log(`[status] real rows=${real.length} ${JSON.stringify(tally(real))}`);
}

// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.sub === 'help') {
    printHelp();
    return;
  }
  if (parsed.sub === 'seed') {
    await runSeed(parsed.count, parsed.mode);
    return;
  }
  if (parsed.sub === 'clean') {
    await runClean();
    return;
  }
  if (parsed.sub === 'status') {
    await runStatus();
    return;
  }
  console.error(`Unknown command: ${parsed.sub}`);
  printHelp();
  process.exit(1);
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error('[seed-lift-measurements] fatal:', err);
    process.exit(1);
  },
);
