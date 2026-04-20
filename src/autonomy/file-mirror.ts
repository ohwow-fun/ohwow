/**
 * Per-arc markdown file mirror.
 *
 * After an arc closes, the Director invokes `mirrorArcToDisk` to
 * regenerate a `cat`-able tree at:
 *
 *   ~/.ohwow/workspaces/<slug>/autonomy/arcs/<arc_id>/
 *     arc.md
 *     phase-NN-<mode>.md
 *     phase-NN/round-NN-{plan,impl,qa}.md
 *
 * The DB remains the source of truth — this mirror is a read-only
 * forensics surface for `cat`, `git grep`, and `rg`. Writes are atomic
 * (`writeFile(.tmp)` then `rename`). The mirror is safe to delete; the
 * next arc close (or `scripts/autonomy-tick --mirror-only`) will
 * recreate it.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { logger } from '../lib/logger.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { workspaceLayoutFor } from '../config.js';
import {
  loadArc,
  listPhaseReportsForArc,
  type ArcRecord,
  type PhaseReportRecord,
} from './director-persistence.js';
import {
  listRoundsForTrio,
  listTriosForPhase,
  type RoundRecord,
  type TrioRecord,
} from './persistence.js';
import type { RoundKind } from './types.js';

export interface MirrorArcInput {
  db: DatabaseAdapter;
  workspace_slug: string;
  arc_id: string;
}

export interface MirrorArcResult {
  written: string[];
}

export interface MirrorPaths {
  baseDir: string;
  arcMdPath: string;
}

/**
 * Compute the on-disk paths for the arc mirror without doing any I/O.
 * Useful for tests and for callers that want to log where the mirror
 * landed without re-deriving the path themselves.
 */
export function mirrorPaths(
  workspace_slug: string,
  arc_id: string,
): MirrorPaths {
  const layout = workspaceLayoutFor(workspace_slug);
  const baseDir = path.join(layout.dataDir, 'autonomy', 'arcs', arc_id);
  return {
    baseDir,
    arcMdPath: path.join(baseDir, 'arc.md'),
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function jsonBlock(label: string, value: unknown): string {
  return [
    `### ${label}`,
    '',
    '```json',
    JSON.stringify(value, null, 2),
    '```',
    '',
  ].join('\n');
}

function safeMode(report: PhaseReportRecord): string {
  return String(report.mode ?? 'unknown');
}

async function writeFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, filePath);
}

function renderArcMd(
  arc: ArcRecord,
  phases: PhaseReportRecord[],
): string {
  const lines: string[] = [];
  lines.push(`# Arc ${arc.id}`);
  lines.push('');
  lines.push(`- **status**: ${arc.status}`);
  lines.push(`- **mode_of_invocation**: ${arc.mode_of_invocation}`);
  lines.push(`- **opened_at**: ${arc.opened_at}`);
  lines.push(`- **closed_at**: ${arc.closed_at ?? '(open)'}`);
  lines.push(`- **exit_reason**: ${arc.exit_reason ?? '(none)'}`);
  lines.push(`- **workspace_id**: ${arc.workspace_id}`);
  lines.push('');
  lines.push('## Thesis');
  lines.push('');
  lines.push(arc.thesis || '(none)');
  lines.push('');
  lines.push('## Budgets');
  lines.push('');
  lines.push(`- **max_phases**: ${arc.budget_max_phases}`);
  lines.push(`- **max_minutes**: ${arc.budget_max_minutes}`);
  lines.push(`- **max_inbox_qs**: ${arc.budget_max_inbox_qs}`);
  lines.push(
    `- **kill_on_pulse_regression**: ${arc.kill_on_pulse_regression}`,
  );
  lines.push('');
  lines.push('## Pulse');
  lines.push('');
  lines.push(jsonBlock('pulse_at_entry', arc.pulse_at_entry_json));
  lines.push(jsonBlock('pulse_at_close', arc.pulse_at_close_json));
  lines.push('## Phases');
  lines.push('');
  if (phases.length === 0) {
    lines.push('_(no phase reports)_');
  } else {
    for (let i = 0; i < phases.length; i += 1) {
      const p = phases[i];
      const nn = pad2(i + 1);
      const file = `phase-${nn}-${safeMode(p)}.md`;
      lines.push(
        `- ${nn}. [${safeMode(p)} — ${p.status}](./${file}) — phase_id \`${p.phase_id}\` — trios_run ${p.trios_run}`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderPhaseMd(
  arc: ArcRecord,
  report: PhaseReportRecord,
  index: number,
  trios: TrioRecord[],
  roundsByTrio: Map<string, RoundRecord[]>,
): string {
  const nn = pad2(index + 1);
  const lines: string[] = [];
  lines.push(`# Phase ${nn} — ${safeMode(report)}`);
  lines.push('');
  lines.push(`- **arc**: [${arc.id}](./arc.md)`);
  lines.push(`- **phase_id**: \`${report.phase_id}\``);
  lines.push(`- **status**: ${report.status}`);
  lines.push(`- **trios_run**: ${report.trios_run}`);
  lines.push(
    `- **runtime_sha**: ${report.runtime_sha_start ?? '?'} → ${report.runtime_sha_end ?? '?'}`,
  );
  lines.push(
    `- **cloud_sha**: ${report.cloud_sha_start ?? '?'} → ${report.cloud_sha_end ?? '?'}`,
  );
  lines.push(`- **started_at**: ${report.started_at}`);
  lines.push(`- **ended_at**: ${report.ended_at ?? '(in-flight)'}`);
  lines.push('');
  lines.push('## Goal');
  lines.push('');
  lines.push(report.goal || '(none)');
  lines.push('');
  lines.push('## Cost');
  lines.push('');
  lines.push(`- **trios**: ${report.cost_trios ?? 0}`);
  lines.push(`- **minutes**: ${report.cost_minutes ?? 0}`);
  lines.push(`- **llm_cents**: ${report.cost_llm_cents ?? 0}`);
  lines.push('');
  lines.push('## Pulse delta');
  lines.push('');
  lines.push(jsonBlock('delta_pulse', report.delta_pulse_json ?? null));
  lines.push('## Inbox added');
  lines.push('');
  lines.push(report.inbox_added_json ?? '_(none)_');
  lines.push('');
  lines.push('## Remaining scope');
  lines.push('');
  lines.push(report.remaining_scope ?? '_(none)_');
  lines.push('');
  lines.push('## Next phase recommendation');
  lines.push('');
  lines.push(report.next_phase_recommendation ?? '_(none)_');
  lines.push('');
  lines.push('## Raw report');
  lines.push('');
  if (report.raw_report) {
    lines.push('```');
    lines.push(report.raw_report);
    lines.push('```');
  } else {
    lines.push('_(none)_');
  }
  lines.push('');
  lines.push('## Trios + rounds');
  lines.push('');
  if (trios.length === 0) {
    lines.push('_(no trios)_');
  } else {
    for (let ti = 0; ti < trios.length; ti += 1) {
      const trio = trios[ti];
      const trioNN = pad2(ti + 1);
      lines.push(
        `### Trio ${trioNN} — outcome \`${trio.outcome}\` — id \`${trio.id}\``,
      );
      lines.push('');
      const rounds = roundsByTrio.get(trio.id) ?? [];
      if (rounds.length === 0) {
        lines.push('_(no rounds)_');
        lines.push('');
        continue;
      }
      for (let ri = 0; ri < rounds.length; ri += 1) {
        const r = rounds[ri];
        const roundNN = pad2(ri + 1);
        const file = `phase-${nn}/round-${roundNN}-${r.kind}.md`;
        lines.push(
          `- ${roundNN}. [${r.kind} — ${r.status}](./${file}) — id \`${r.id}\``,
        );
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

function renderRoundMd(
  arc: ArcRecord,
  report: PhaseReportRecord,
  phaseIndex: number,
  trio: TrioRecord,
  trioIndex: number,
  round: RoundRecord,
  roundIndex: number,
): string {
  const nn = pad2(phaseIndex + 1);
  const trioNN = pad2(trioIndex + 1);
  const roundNN = pad2(roundIndex + 1);
  const phaseFile = `../phase-${nn}-${safeMode(report)}.md`;
  const lines: string[] = [];
  lines.push(`# Phase ${nn} / Trio ${trioNN} / Round ${roundNN} — ${round.kind}`);
  lines.push('');
  lines.push(`- **arc**: [${arc.id}](../arc.md)`);
  lines.push(`- **phase**: [${phaseFile.replace('../', '')}](${phaseFile})`);
  lines.push(`- **trio_id**: \`${trio.id}\` (outcome \`${trio.outcome}\`)`);
  lines.push(`- **round_id**: \`${round.id}\``);
  lines.push(`- **kind**: ${round.kind}`);
  lines.push(`- **status**: ${round.status}`);
  lines.push(`- **started_at**: ${round.started_at}`);
  lines.push(`- **ended_at**: ${round.ended_at ?? '(in-flight)'}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(round.summary || '_(empty)_');
  lines.push('');
  lines.push('## Commits');
  lines.push('');
  if (round.commits.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const c of round.commits) {
      lines.push(`- \`${c}\``);
    }
  }
  lines.push('');
  lines.push('## Findings written');
  lines.push('');
  if (round.findings_written.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const f of round.findings_written) {
      lines.push(`- \`${f}\``);
    }
  }
  lines.push('');
  if (round.evaluation) {
    lines.push('## Evaluation (QA)');
    lines.push('');
    lines.push(`- **verdict**: ${round.evaluation.verdict}`);
    lines.push(`- **test_commits**: ${round.evaluation.test_commits.join(', ') || '_(none)_'}`);
    lines.push(`- **fix_commits**: ${round.evaluation.fix_commits.join(', ') || '_(none)_'}`);
    lines.push('');
    lines.push('### Criteria');
    lines.push('');
    if (round.evaluation.criteria.length === 0) {
      lines.push('_(none)_');
    } else {
      for (const c of round.evaluation.criteria) {
        const note = c.note ? ` — ${c.note}` : '';
        lines.push(`- **${c.outcome}** \`${c.criterion}\`${note}`);
      }
    }
    lines.push('');
  }
  lines.push('## Raw return');
  lines.push('');
  lines.push(jsonBlock('raw_return', round.raw_return));
  return lines.join('\n');
}

/**
 * Pure-write fn — does not mutate the DB. Returns the absolute paths
 * written, in deterministic order (arc.md first, then per-phase, then
 * per-round). Throws on filesystem errors; callers (the Director arc-
 * close hook) should wrap in try/catch and demote to a `pino.warn`.
 */
export async function mirrorArcToDisk(
  args: MirrorArcInput,
): Promise<MirrorArcResult> {
  const { db, workspace_slug, arc_id } = args;
  const arc = await loadArc(db, arc_id);
  if (!arc) {
    throw new Error(`mirrorArcToDisk: arc not found: ${arc_id}`);
  }
  const reports = await listPhaseReportsForArc(db, arc_id);
  const { baseDir, arcMdPath } = mirrorPaths(workspace_slug, arc_id);

  await fsp.mkdir(baseDir, { recursive: true });

  const written: string[] = [];

  await writeFileAtomic(arcMdPath, renderArcMd(arc, reports));
  written.push(arcMdPath);

  for (let i = 0; i < reports.length; i += 1) {
    const report = reports[i];
    // `phase_trios.phase_id` carries the picker's logical phase id
    // (e.g. `phase_A`), NOT the phase-report row id. Director writes the
    // report row keyed by `genPhaseReportId(arc, idx)` and passes
    // `pick.phase_id` into the phase orchestrator; that's the value the
    // trios end up tagged with. Match on the right key or the round
    // tree comes out empty.
    const trios = await listTriosForPhase(db, report.phase_id);
    const roundsByTrio = new Map<string, RoundRecord[]>();
    for (const trio of trios) {
      const rounds = await listRoundsForTrio(db, trio.id);
      roundsByTrio.set(trio.id, rounds);
    }

    const nn = pad2(i + 1);
    const phaseFile = path.join(
      baseDir,
      `phase-${nn}-${safeMode(report)}.md`,
    );
    await writeFileAtomic(
      phaseFile,
      renderPhaseMd(arc, report, i, trios, roundsByTrio),
    );
    written.push(phaseFile);

    const phaseSubdir = path.join(baseDir, `phase-${nn}`);
    let needSubdir = false;
    for (const trio of trios) {
      if ((roundsByTrio.get(trio.id) ?? []).length > 0) {
        needSubdir = true;
        break;
      }
    }
    if (needSubdir) {
      await fsp.mkdir(phaseSubdir, { recursive: true });
    }

    for (let ti = 0; ti < trios.length; ti += 1) {
      const trio = trios[ti];
      const rounds = roundsByTrio.get(trio.id) ?? [];
      for (let ri = 0; ri < rounds.length; ri += 1) {
        const round = rounds[ri];
        const roundNN = pad2(ri + 1);
        const kind: RoundKind = round.kind;
        const roundFile = path.join(
          phaseSubdir,
          `round-${roundNN}-${kind}.md`,
        );
        await writeFileAtomic(
          roundFile,
          renderRoundMd(arc, report, i, trio, ti, round, ri),
        );
        written.push(roundFile);
      }
    }
  }

  logger.debug(
    { arc_id, workspace_slug, files: written.length },
    'autonomy.mirror.arc.write',
  );

  return { written };
}
