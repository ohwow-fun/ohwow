/**
 * SourceCopyLintExperiment — static complement to DashboardCopy.
 *
 * The runtime copy experiment can't distinguish chrome (hardcoded
 * strings in src/web/src) from data (row values, user-generated
 * content). This experiment runs the same copy-rule detectors over
 * SOURCE files directly, so a finding only fires when the phrase
 * actually lives in our codebase.
 *
 * Implementation is deliberately minimal: read *.tsx files under
 * src/web/src/pages, extract string-literal content (', ", `…`) and
 * JSX text, run lintCopy. Returns exact file + line offsets so a
 * future patch-author can target the literal directly without
 * scraping the DOM.
 *
 * Observe-only. Pairs with DashboardCopyExperiment: the intersection
 * of the two (rule fires in both DOM AND source) is high-confidence
 * patch fuel.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../lib/logger.js';
import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { getSelfCommitStatus } from '../self-commit.js';
import { lintCopy, type CopyViolation } from '../../lib/copy-rules-linter.js';

/** Root of the web app source tree we scan. */
const WEB_SRC = 'src/web/src';
/** Subdirs worth scanning — pages is highest density, components next. */
const SCAN_DIRS = ['pages', 'components'];
/** Cap per file so a single bloated page can't dominate evidence. */
const MAX_VIOLATIONS_PER_FILE = 30;

interface SourceViolation extends CopyViolation {
  /** Repo-relative path to the source file. */
  file: string;
  /** 1-based line number of the violation start. */
  line: number;
  /** 1-based column (characters from the start of the line). */
  column: number;
  /** Literal kind the match was found inside. */
  kind: 'string-literal' | 'template-literal' | 'jsx-text';
  /** The raw literal value (with quotes stripped) for context. */
  literal: string;
}

interface EvidenceShape extends Record<string, unknown> {
  repo_root: string | null;
  files_scanned: number;
  files_with_violations: number;
  total_violations: number;
  violations: SourceViolation[];
  affected_files: string[];
  reason?: string;
}

export class SourceCopyLintExperiment implements Experiment {
  readonly id = 'source-copy-lint';
  readonly name = 'Copy-rule lint over src/web/src sources';
  readonly category: ExperimentCategory = 'tool_reliability';
  readonly hypothesis =
    'No hardcoded string literal, template literal, or JSX text in the ' +
    'dashboard source tree violates the machine-checkable copy rules.';
  readonly cadence = { everyMs: 5 * 60 * 1000, runOnBoot: true };

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    const { repoRoot } = getSelfCommitStatus();
    if (!repoRoot) {
      const evidence: EvidenceShape = {
        repo_root: null,
        files_scanned: 0,
        files_with_violations: 0,
        total_violations: 0,
        violations: [],
        affected_files: [],
        reason: 'no_repo_root',
      };
      return {
        subject: 'meta:source-copy-lint',
        summary: 'repo root not configured — skipping',
        evidence,
      };
    }

    const files = collectTsxFiles(path.join(repoRoot, WEB_SRC), SCAN_DIRS);
    const violations: SourceViolation[] = [];
    for (const absPath of files) {
      const repoRel = path.relative(repoRoot, absPath).replace(/\\/g, '/');
      let source: string;
      try {
        source = fs.readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }
      const fileViolations = scanFile(repoRel, source);
      for (const v of fileViolations.slice(0, MAX_VIOLATIONS_PER_FILE)) {
        violations.push(v);
      }
    }

    const affectedFiles = unique(violations.map((v) => v.file));
    const evidence: EvidenceShape = {
      repo_root: repoRoot,
      files_scanned: files.length,
      files_with_violations: affectedFiles.length,
      total_violations: violations.length,
      violations,
      affected_files: affectedFiles,
    };
    const summary =
      violations.length === 0
        ? `${files.length} file(s) scanned, 0 source copy violations`
        : `${violations.length} source violation(s) across ${affectedFiles.length}/${files.length} file(s)`;
    return { subject: 'meta:source-copy-lint', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as EvidenceShape;
    if (ev.reason) return 'pass';
    return ev.total_violations === 0 ? 'pass' : 'warning';
  }

  async intervene(
    verdict: Verdict,
    result: ProbeResult,
    _ctx: ExperimentContext,
  ): Promise<null> {
    if (verdict !== 'warning') return null;
    const ev = result.evidence as EvidenceShape;
    logger.warn(
      {
        total: ev.total_violations,
        files: ev.files_with_violations,
        sample: ev.violations.slice(0, 5).map((v) => ({
          file: v.file,
          line: v.line,
          rule: v.ruleId,
          match: v.match,
          literal: v.literal.slice(0, 80),
        })),
      },
      '[source-copy-lint] source copy-rule violations observed',
    );
    return null;
  }
}

/** Recursively collect *.tsx and *.ts files under the given subdirs. */
export function collectTsxFiles(webSrcRoot: string, subdirs: string[]): string[] {
  const out: string[] = [];
  for (const sub of subdirs) {
    const start = path.join(webSrcRoot, sub);
    walk(start, out);
  }
  return out.sort();
}

function walk(dir: string, acc: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(full, acc);
    } else if (e.isFile() && (e.name.endsWith('.tsx') || e.name.endsWith('.ts'))) {
      if (e.name.endsWith('.test.ts') || e.name.endsWith('.test.tsx')) continue;
      acc.push(full);
    }
  }
}

/**
 * Scan one file. Extracts every string literal, template literal
 * chunk, and JSX text node using a tokenizer-style pass, then runs
 * lintCopy against each chunk. Doesn't pull in the TS compiler —
 * a bespoke scanner is two orders of magnitude cheaper and handles
 * the shapes we care about (plain strings + JSX text). It's strict
 * about comments and string escapes so it doesn't misread
 * // Failed to X as a literal.
 */
export function scanFile(file: string, source: string): SourceViolation[] {
  const literals = extractLiterals(source);
  const out: SourceViolation[] = [];
  for (const lit of literals) {
    const vs = lintCopy(lit.value);
    if (vs.length === 0) continue;
    for (const v of vs) {
      // Map the within-literal index back to a source-file location.
      const absIndex = lit.start + v.index + (lit.contentOffset ?? 0);
      const { line, column } = indexToLineColumn(source, absIndex);
      out.push({
        ...v,
        file,
        line,
        column,
        kind: lit.kind,
        literal: lit.value.slice(0, 200),
      });
    }
  }
  return out;
}

interface ExtractedLiteral {
  kind: 'string-literal' | 'template-literal' | 'jsx-text';
  start: number;
  end: number;
  /** Offset from `start` where the actual content begins (skips quote). */
  contentOffset: number;
  value: string;
}

/**
 * Lightweight scanner. Two passes:
 *   (a) one linear sweep that consumes comments, string literals,
 *       and template literals exactly and skips past ${…} expressions.
 *       This is the high-precision path and always terminates (every
 *       branch advances `i`).
 *   (b) a regex sweep for JSX text (text between `>` and `<`) over
 *       the SAME source, after masking out the already-consumed
 *       literal ranges. Approximate — it misses text that contains
 *       embedded expressions — but it never loops, and the rules
 *       we care about are short phrases so partial JSX text chunks
 *       are good enough.
 */
export function extractLiterals(src: string): ExtractedLiteral[] {
  const out: ExtractedLiteral[] = [];
  const n = src.length;
  // Tracks which indices were consumed by pass (a) so pass (b)
  // doesn't double-match inside a string literal's quoted content.
  const masked = new Uint8Array(n);

  let i = 0;
  while (i < n) {
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : '';

    // Line comment.
    if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end + 1;
      for (let k = i; k < stop; k++) masked[k] = 1;
      i = stop;
      continue;
    }
    // Block comment.
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) masked[k] = 1;
      i = stop;
      continue;
    }
    // String literal (single-line — a raw newline ends the literal).
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      let j = i + 1;
      let value = '';
      while (j < n) {
        const c = src[j];
        if (c === '\\' && j + 1 < n) {
          const esc = src[j + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
          j += 2;
          continue;
        }
        if (c === quote) { j++; break; }
        if (c === '\n') break;
        value += c;
        j++;
      }
      for (let k = start; k < j; k++) masked[k] = 1;
      out.push({ kind: 'string-literal', start, end: j, contentOffset: 1, value });
      i = j;
      continue;
    }
    // Template literal.
    if (ch === '`') {
      const start = i;
      let j = i + 1;
      let value = '';
      while (j < n) {
        const c = src[j];
        if (c === '\\' && j + 1 < n) {
          value += src[j + 1];
          j += 2;
          continue;
        }
        if (c === '$' && j + 1 < n && src[j + 1] === '{') {
          // Skip the expression; bookkeep brace depth so we don't
          // stop at a nested `}`.
          let depth = 1;
          j += 2;
          while (j < n && depth > 0) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            j++;
          }
          continue;
        }
        if (c === '`') { j++; break; }
        value += c;
        j++;
      }
      for (let k = start; k < j; k++) masked[k] = 1;
      out.push({ kind: 'template-literal', start, end: j, contentOffset: 1, value });
      i = j;
      continue;
    }
    i++;
  }

  // Pass (b): JSX text as the content of `>…<` pairs where neither
  // end is masked. Regex is simple and terminates; index matches the
  // start of the captured content group.
  const jsxTextRe = />([^<{}]+)</g;
  let m: RegExpExecArray | null;
  while ((m = jsxTextRe.exec(src)) !== null) {
    const contentStart = m.index + 1;
    const contentEnd = contentStart + m[1].length;
    // Skip if any masked char overlaps — indicates we're inside a
    // string, template, or comment that happened to contain `>…<`.
    let overlaps = false;
    for (let k = contentStart; k < contentEnd; k++) {
      if (masked[k]) { overlaps = true; break; }
    }
    if (overlaps) continue;
    const value = m[1].replace(/\s+/g, ' ').trim();
    if (value.length === 0) continue;
    // Heuristic: if the chunk contains `//` or `=>` it's probably
    // not JSX text but a code-level comparator. Skip to avoid
    // false positives on operators like `items > 0`.
    if (/\/\/|=>|==|!=|<=|>=/.test(m[1])) continue;
    out.push({
      kind: 'jsx-text',
      start: contentStart,
      end: contentEnd,
      contentOffset: 0,
      value,
    });
  }

  // Sort so callers get violations in source order.
  out.sort((a, b) => a.start - b.start);
  return out;
}

function indexToLineColumn(src: string, idx: number): { line: number; column: number } {
  if (idx < 0) return { line: 1, column: 1 };
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < idx && i < src.length; i++) {
    if (src[i] === '\n') {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: idx - lastNewline };
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
