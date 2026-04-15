/**
 * RoadmapUpdaterExperiment — closes the loop on AUTONOMY_ROADMAP.md.
 *
 * The loop now narrates its own state. Probe reads live loop health
 * (via scripts/self-bench/loop-status.sh) plus roadmap mtime and the
 * experiments directory. Judge fires a warning when the roadmap is
 * older than 2h AND at least one noteworthy signal is present.
 * Intervene asks an LLM to rewrite sections 3 (Active Focus) and 5
 * (Next Steps) and commits via safeSelfCommit.
 *
 * Commit linkage (tier-2 + Fixes-Finding-Id)
 * ------------------------------------------
 * AUTONOMY_ROADMAP.md is a tier-2 path, which requires the commit to
 * carry a Fixes-Finding-Id trailer pointing at a prior warning finding
 * whose affected_files intersects the patched file. The experiment
 * writes those findings itself on warning verdicts
 * (evidence.affected_files = ['AUTONOMY_ROADMAP.md']); on subsequent
 * ticks, intervene reads its own recent findings (via
 * ctx.recentFindings) and picks the most recent warning that is not
 * already referenced by an autonomous commit trailer.
 *
 * First-tick-after-stale behavior: probe → warning finding written,
 * intervene has no prior warning yet → returns null. The next tick
 * (30 min later) picks up the prior warning and lands the patch.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { getSelfCommitStatus, safeSelfCommit, type FindingLookup } from '../self-commit.js';
import { runLlmCall } from '../../execution/llm-organ.js';
import { logger } from '../../lib/logger.js';
import { collectFindingIdsAlreadyPatched } from './patch-author.js';

const execFileP = promisify(execFile);

const ROADMAP_REL = 'AUTONOMY_ROADMAP.md';
const ROADMAP_STALENESS_MS = 2 * 60 * 60 * 1000;
const NOTEWORTHY_VIOLATION_POOL = 50;
const FINDING_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

interface LoopStatusJson {
  roadmap_last_modified?: string;
  loop_health?: { verdict?: string; hold_rate?: number | null; patches_landed?: number; patches_reverted?: number; violation_pool_today?: number };
  violations?: { total_violations?: number };
  recent_patches?: unknown[];
  proposals?: { summary?: string };
  patch_author?: { summary?: string };
}

export interface RoadmapUpdaterEvidence extends Record<string, unknown> {
  affected_files: string[];
  roadmap_age_ms: number;
  roadmap_mtime_iso: string | null;
  loop_verdict: string | null;
  hold_rate: number | null;
  violation_pool_today: number;
  patches_landed: number;
  patches_reverted: number;
  experiment_files_total: number;
  experiment_files_missing_from_roadmap: string[];
  noteworthy_signals: string[];
  loop_status_error?: string;
}

export class RoadmapUpdaterExperiment implements Experiment {
  readonly id = 'roadmap-updater';
  readonly name = 'Autonomous roadmap updater';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    'When the live loop state drifts from AUTONOMY_ROADMAP.md, an LLM ' +
    'rewrite of sections 3 and 5 keeps the doc legible without human edits, ' +
    'gated by the tier-2 Fixes-Finding-Id trailer.';
  readonly cadence = { everyMs: 30 * 60 * 1000, runOnBoot: false };

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    const { repoRoot } = getSelfCommitStatus();
    if (!repoRoot) {
      const evidence: RoadmapUpdaterEvidence = emptyEvidence('no repo root');
      return { subject: 'meta:roadmap', summary: 'no repo root configured', evidence };
    }
    const roadmapAbs = path.join(repoRoot, ROADMAP_REL);

    let mtimeMs = 0;
    let mtimeIso: string | null = null;
    try {
      const st = fs.statSync(roadmapAbs);
      mtimeMs = st.mtimeMs;
      mtimeIso = new Date(mtimeMs).toISOString();
    } catch {
      const evidence: RoadmapUpdaterEvidence = emptyEvidence('roadmap not found');
      return { subject: 'meta:roadmap', summary: 'AUTONOMY_ROADMAP.md not found', evidence };
    }
    const ageMs = Date.now() - mtimeMs;

    const status = await readLoopStatus(repoRoot);
    const loopVerdict = status.json?.loop_health?.verdict ?? null;
    const holdRate = status.json?.loop_health?.hold_rate ?? null;
    const poolToday = status.json?.loop_health?.violation_pool_today ?? 0;
    const landed = status.json?.loop_health?.patches_landed ?? 0;
    const reverted = status.json?.loop_health?.patches_reverted ?? 0;

    const experimentFiles = listExperimentBasenames(repoRoot);
    const roadmapText = safeRead(roadmapAbs) ?? '';
    const missing = experimentFiles.filter((f) => !roadmapText.includes(f));

    const signals: string[] = [];
    if (poolToday >= NOTEWORTHY_VIOLATION_POOL) signals.push(`violation_pool_today>=${NOTEWORTHY_VIOLATION_POOL}`);
    if (loopVerdict === 'fail') signals.push('loop_health_fail');
    if (missing.length >= 1) signals.push(`missing_experiments:${missing.length}`);

    const evidence: RoadmapUpdaterEvidence = {
      affected_files: [ROADMAP_REL],
      roadmap_age_ms: ageMs,
      roadmap_mtime_iso: mtimeIso,
      loop_verdict: typeof loopVerdict === 'string' ? loopVerdict : null,
      hold_rate: typeof holdRate === 'number' ? holdRate : null,
      violation_pool_today: typeof poolToday === 'number' ? poolToday : 0,
      patches_landed: typeof landed === 'number' ? landed : 0,
      patches_reverted: typeof reverted === 'number' ? reverted : 0,
      experiment_files_total: experimentFiles.length,
      experiment_files_missing_from_roadmap: missing,
      noteworthy_signals: signals,
    };
    if (status.error) evidence.loop_status_error = status.error;

    const ageH = (ageMs / 3600_000).toFixed(1);
    const summary =
      signals.length === 0
        ? `roadmap ${ageH}h old; no noteworthy signals`
        : `roadmap ${ageH}h old; signals: ${signals.join(', ')}`;
    return { subject: 'meta:roadmap', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as RoadmapUpdaterEvidence;
    if (ev.roadmap_age_ms <= ROADMAP_STALENESS_MS) return 'pass';
    if (ev.noteworthy_signals.length === 0) return 'pass';
    return 'warning';
  }

  async intervene(
    verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    if (verdict !== 'warning') return null;
    const ev = result.evidence as RoadmapUpdaterEvidence;

    const { repoRoot } = getSelfCommitStatus();
    if (!repoRoot) return { description: 'no repo root', details: { stage: 'repo-root' } };
    if (!ctx.engine?.modelRouter) {
      return { description: 'no model router on engine', details: { stage: 'model-router' } };
    }

    const roadmapAbs = path.join(repoRoot, ROADMAP_REL);
    const current = safeRead(roadmapAbs);
    if (!current) return { description: 'could not read roadmap', details: { stage: 'read' } };

    const finding = await pickJustifyingFinding(ctx, repoRoot);
    if (!finding) {
      return {
        description: 'no prior warning finding to justify a patch yet — will retry next tick',
        details: { stage: 'await-finding' },
      };
    }

    const sections = splitSections(current);
    const focus = sections.find((s) => /^## \d+\.\s*Active Focus/i.test(s.header));
    const nextSteps = sections.find((s) => /^## \d+\.\s*Next Steps/i.test(s.header));
    if (!focus || !nextSteps) {
      return {
        description: 'roadmap missing expected section headers',
        details: { stage: 'split', headers: sections.map((s) => s.header) },
      };
    }

    const llm = await runLlmCall(
      {
        modelRouter: ctx.engine.modelRouter,
        db: ctx.db,
        workspaceId: ctx.workspaceId,
      },
      {
        purpose: 'reasoning',
        system: SYSTEM_PROMPT,
        prompt: buildPrompt(ev, focus, nextSteps),
        max_tokens: 4096,
        temperature: 0,
      },
    );
    if (!llm.ok) return { description: `model call failed: ${llm.error}`, details: { stage: 'model' } };

    const parsed = parseSectionsResponse(llm.data.text);
    if (!parsed) {
      return {
        description: 'model response did not parse into section_3/section_5 blocks',
        details: { stage: 'parse', raw: llm.data.text.slice(0, 500) },
      };
    }

    const rewritten = reassembleRoadmap(sections, focus.header, parsed.section3, nextSteps.header, parsed.section5);
    if (rewritten.trim() === current.trim()) {
      return { description: 'LLM rewrite was a no-op; skipping commit', details: { stage: 'no-op' } };
    }

    const findingResolver = async (id: string): Promise<FindingLookup | null> => {
      if (id !== finding.id) return null;
      return {
        id: finding.id,
        verdict: 'warning',
        ranAt: finding.ranAt,
        affectedFiles: [ROADMAP_REL],
      };
    };

    const commit = await safeSelfCommit({
      files: [{ path: ROADMAP_REL, content: rewritten }],
      commitMessage:
        `feat(self-bench): refresh AUTONOMY_ROADMAP.md sections 3 and 5 from live loop state\n\n` +
        `Autonomous rewrite triggered by finding ${finding.id.slice(0, 8)} ` +
        `(roadmap ${(ev.roadmap_age_ms / 3600_000).toFixed(1)}h old; signals: ${ev.noteworthy_signals.join(', ')}).\n`,
      experimentId: this.id,
      extendsExperimentId: null,
      whyNotEditExisting:
        `Tier-2 patch path: this commit rewrites AUTONOMY_ROADMAP.md (the intervention) in response to finding ${finding.id}.`,
      fixesFindingId: finding.id,
      findingResolver,
    });
    if (!commit.ok) {
      logger.info({ reason: commit.reason }, '[roadmap-updater] safeSelfCommit refused');
      return { description: `safeSelfCommit refused: ${commit.reason}`, details: { stage: 'commit', reason: commit.reason } };
    }
    return {
      description: `landed roadmap refresh ${commit.commitSha?.slice(0, 12)}`,
      details: {
        stage: 'committed',
        commitSha: commit.commitSha,
        findingId: finding.id,
        model: llm.data.model_used,
        provider: llm.data.provider,
        cost_cents: llm.data.cost_cents,
      },
    };
  }
}

const SYSTEM_PROMPT =
  'You maintain AUTONOMY_ROADMAP.md for an autonomous self-improvement loop. ' +
  'The operator shows you (a) a JSON snapshot of live loop state and ' +
  '(b) the CURRENT text of sections "Active Focus" and "Next Steps". ' +
  'Rewrite only those two sections so they match the live state. ' +
  'Preserve markdown style: heading format stays identical, keep bulleted lists, ' +
  'keep concrete references to experiment ids and file paths. Be specific, not generic. ' +
  'Output format: one fenced block per section, language tag "section_3" then "section_5". ' +
  'Each block contains the full new BODY of that section (everything AFTER the "## N. Title" line, ' +
  'up to but NOT including the next section). Do not output the header line itself. ' +
  'No commentary outside the two fenced blocks.';

function buildPrompt(
  ev: RoadmapUpdaterEvidence,
  focus: Section,
  nextSteps: Section,
): string {
  return (
    '<live-loop-state>\n' +
    JSON.stringify(
      {
        loop_verdict: ev.loop_verdict,
        hold_rate: ev.hold_rate,
        patches_landed: ev.patches_landed,
        patches_reverted: ev.patches_reverted,
        violation_pool_today: ev.violation_pool_today,
        experiment_files_total: ev.experiment_files_total,
        experiment_files_missing_from_roadmap: ev.experiment_files_missing_from_roadmap,
        noteworthy_signals: ev.noteworthy_signals,
      },
      null,
      2,
    ) +
    '\n</live-loop-state>\n\n' +
    '<current-section-3 header="' + focus.header + '">\n' +
    focus.body +
    '\n</current-section-3>\n\n' +
    '<current-section-5 header="' + nextSteps.header + '">\n' +
    nextSteps.body +
    '\n</current-section-5>'
  );
}

export interface Section {
  header: string;
  body: string;
}

/**
 * Split roadmap into ordered sections. Each section starts at a line
 * matching /^## / and runs until the next such line (exclusive). Any
 * preamble before the first ## header is attached as a section with
 * an empty header so it round-trips verbatim.
 */
export function splitSections(text: string): Section[] {
  const lines = text.split('\n');
  const out: Section[] = [];
  let header = '';
  let buf: string[] = [];
  for (const line of lines) {
    if (/^## /.test(line)) {
      out.push({ header, body: buf.join('\n') });
      header = line;
      buf = [];
    } else {
      buf.push(line);
    }
  }
  out.push({ header, body: buf.join('\n') });
  return out;
}

export function reassembleRoadmap(
  sections: readonly Section[],
  focusHeader: string,
  newFocusBody: string,
  nextHeader: string,
  newNextBody: string,
): string {
  return sections
    .map((s, i) => {
      const body =
        s.header === focusHeader
          ? newFocusBody
          : s.header === nextHeader
            ? newNextBody
            : s.body;
      if (s.header === '' && i === 0) return body;
      return `${s.header}\n${body}`;
    })
    .join('\n');
}

export function parseSectionsResponse(
  raw: string,
): { section3: string; section5: string } | null {
  const re = /```section_(3|5)\s*\n([\s\S]*?)\n```/g;
  let s3: string | null = null;
  let s5: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m[1] === '3') s3 = m[2];
    else if (m[1] === '5') s5 = m[2];
  }
  if (s3 === null || s5 === null) return null;
  return { section3: ensureTrailingNewline(s3), section5: ensureTrailingNewline(s5) };
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : s + '\n';
}

async function readLoopStatus(
  repoRoot: string,
): Promise<{ json: LoopStatusJson | null; error?: string }> {
  const script = path.join(repoRoot, 'scripts/self-bench/loop-status.sh');
  try {
    const { stdout } = await execFileP('bash', [script], {
      cwd: repoRoot,
      timeout: 15_000,
      env: { ...process.env },
    });
    return { json: JSON.parse(stdout) as LoopStatusJson };
  } catch (err) {
    return { json: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function listExperimentBasenames(repoRoot: string): string[] {
  const dir = path.join(repoRoot, 'src/self-bench/experiments');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => f.replace(/\.ts$/, ''))
      .sort();
  } catch {
    return [];
  }
}

function safeRead(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

interface JustifyingFinding {
  id: string;
  ranAt: string;
}

async function pickJustifyingFinding(
  ctx: ExperimentContext,
  repoRoot: string,
): Promise<JustifyingFinding | null> {
  const already = collectFindingIdsAlreadyPatched(repoRoot, FINDING_LOOKBACK_MS);
  const history = await ctx.recentFindings('roadmap-updater', 20);
  for (const f of history) {
    if (f.verdict !== 'warning') continue;
    if (already.has(f.id)) continue;
    return { id: f.id, ranAt: f.ranAt };
  }
  return null;
}

function emptyEvidence(reason: string): RoadmapUpdaterEvidence {
  return {
    affected_files: [ROADMAP_REL],
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
    loop_status_error: reason,
  };
}
