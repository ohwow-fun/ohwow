/**
 * RoadmapShapeProbeExperiment — structural invariants for the roadmap suite.
 *
 * The roadmap is now three hand-split files:
 *   - AUTONOMY_ROADMAP.md         (index; Active Focus + Next Steps)
 *   - roadmap/gaps.md             (## Known Gaps)
 *   - roadmap/iteration-log.md    (## Recent Iterations, newest first)
 *
 * RoadmapUpdaterExperiment rewrites these files autonomously. This probe is the
 * observable contract that stops shape drift from accumulating silently: every
 * tick it re-asserts the invariants and fires a fail finding when something
 * slipped. Once wired into safeSelfCommit's gate chain (Item 4), a failing
 * shape probe triggers auto-revert of the patch that broke it.
 *
 * Invariants (any failing → verdict=fail):
 *   1. All three files exist and are non-empty.
 *   2. roadmap/gaps.md has a line starting with `## Known Gaps`.
 *   3. roadmap/iteration-log.md has a line starting with `## Recent Iterations`.
 *   4. Entries in iteration-log.md (H3 headers starting with an ISO date)
 *      are ordered newest-first.
 *   5. Every markdown link that targets a sibling roadmap file resolves.
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { getSelfCommitStatus } from '../self-commit.js';

export const ROADMAP_INDEX_REL = 'AUTONOMY_ROADMAP.md';
export const ROADMAP_GAPS_REL = 'roadmap/gaps.md';
export const ROADMAP_LOG_REL = 'roadmap/iteration-log.md';
export const ROADMAP_FILES: readonly string[] = [
  ROADMAP_INDEX_REL,
  ROADMAP_GAPS_REL,
  ROADMAP_LOG_REL,
];

export interface RoadmapShapeViolation {
  rule: string;
  file: string;
  detail: string;
}

export interface RoadmapShapeEvidence extends Record<string, unknown> {
  affected_files: string[];
  violations: RoadmapShapeViolation[];
}

export interface RoadmapShapeInput {
  index: string | null;
  gaps: string | null;
  log: string | null;
}

export class RoadmapShapeProbeExperiment implements Experiment {
  readonly id = 'roadmap-shape-probe';
  readonly name = 'Roadmap structural invariants';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    'Autonomous roadmap rewrites must preserve the three-file layout, the ' +
    'anchor H2 headers, newest-first iteration ordering, and intra-suite links.';
  readonly cadence = { everyMs: 5 * 60 * 1000, runOnBoot: true };

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    const { repoRoot } = getSelfCommitStatus();
    if (!repoRoot) {
      return {
        subject: 'meta:roadmap-shape',
        summary: 'no repo root configured',
        evidence: emptyEvidence(),
      };
    }
    const input: RoadmapShapeInput = {
      index: safeRead(path.join(repoRoot, ROADMAP_INDEX_REL)),
      gaps: safeRead(path.join(repoRoot, ROADMAP_GAPS_REL)),
      log: safeRead(path.join(repoRoot, ROADMAP_LOG_REL)),
    };
    const violations = checkRoadmapShape(input);
    const summary =
      violations.length === 0
        ? 'roadmap shape ok'
        : `${violations.length} shape violation(s)`;
    return {
      subject: 'meta:roadmap-shape',
      summary,
      evidence: {
        affected_files: [...ROADMAP_FILES],
        violations,
      } satisfies RoadmapShapeEvidence,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as RoadmapShapeEvidence;
    return ev.violations.length === 0 ? 'pass' : 'fail';
  }
}

export function checkRoadmapShape(input: RoadmapShapeInput): RoadmapShapeViolation[] {
  const violations: RoadmapShapeViolation[] = [];

  const existence: Array<[string, string | null]> = [
    [ROADMAP_INDEX_REL, input.index],
    [ROADMAP_GAPS_REL, input.gaps],
    [ROADMAP_LOG_REL, input.log],
  ];
  for (const [rel, content] of existence) {
    if (content === null) {
      violations.push({ rule: 'file-missing', file: rel, detail: 'file is absent or unreadable' });
    } else if (content.trim().length === 0) {
      violations.push({ rule: 'file-empty', file: rel, detail: 'file is empty' });
    }
  }

  if (input.gaps && !hasH2(input.gaps, 'Known Gaps')) {
    violations.push({
      rule: 'missing-h2',
      file: ROADMAP_GAPS_REL,
      detail: 'expected a line starting with "## Known Gaps"',
    });
  }

  if (input.log) {
    if (!hasH2(input.log, 'Recent Iterations')) {
      violations.push({
        rule: 'missing-h2',
        file: ROADMAP_LOG_REL,
        detail: 'expected a line starting with "## Recent Iterations"',
      });
    }
    const orderViolation = checkIterationOrder(input.log);
    if (orderViolation) {
      violations.push({
        rule: 'iteration-order',
        file: ROADMAP_LOG_REL,
        detail: orderViolation,
      });
    }
  }

  const filesPresent = new Map<string, string>();
  for (const [rel, content] of existence) {
    if (content !== null) filesPresent.set(rel, content);
  }
  for (const [rel, content] of filesPresent) {
    for (const link of extractRelativeLinks(content)) {
      const target = resolveLink(rel, link);
      if (target === null) continue;
      if (!filesPresent.has(target) && !fileExistsRelativeToSuite(target)) {
        violations.push({
          rule: 'dangling-link',
          file: rel,
          detail: `link target "${link}" does not resolve`,
        });
      }
    }
  }

  return violations;
}

function hasH2(text: string, title: string): boolean {
  const re = new RegExp(`^##\\s+${escapeRegex(title)}\\b`, 'm');
  return re.test(text);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkIterationOrder(log: string): string | null {
  const iso = /^###\s+(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?)/gm;
  const dates: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = iso.exec(log)) !== null) dates.push(m[1]);
  for (let i = 1; i < dates.length; i++) {
    if (Date.parse(dates[i - 1]) < Date.parse(dates[i])) {
      return `entry ${i} (${dates[i]}) is newer than entry ${i - 1} (${dates[i - 1]})`;
    }
  }
  return null;
}

function extractRelativeLinks(markdown: string): string[] {
  const links: string[] = [];
  const re = /\[[^\]]*\]\(([^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) links.push(m[1]);
  return links;
}

function resolveLink(fromRel: string, href: string): string | null {
  if (/^[a-z]+:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return null;
  const clean = href.split('#')[0];
  if (!clean) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), clean));
  return resolved;
}

function fileExistsRelativeToSuite(target: string): boolean {
  const { repoRoot } = getSelfCommitStatus();
  if (!repoRoot) return false;
  try {
    return fs.existsSync(path.join(repoRoot, target));
  } catch {
    return false;
  }
}

function safeRead(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

function emptyEvidence(): RoadmapShapeEvidence {
  return {
    affected_files: [...ROADMAP_FILES],
    violations: [],
  };
}
