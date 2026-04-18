/**
 * Wraps a `RoundExecutor` with the round-return contract:
 *   - validates required fields and shape,
 *   - re-prompts ONCE on bad shape (mirrors the spec's
 *     "Return only this block." retry policy),
 *   - asserts QA rounds carry an `evaluation` block,
 *   - normalises long summaries (truncate-with-warning, never throw),
 *   - logs round boundaries via the structured logger.
 *
 * Validation lives here so `trio.ts` stays pure control-flow.
 */

import { logger } from '../lib/logger.js';
import type {
  RoundBrief,
  RoundExecutor,
  RoundReturn,
  RoundEvaluation,
} from './types.js';

const MAX_SUMMARY_LINES = 5;

/**
 * Thrown when a round return cannot be validated even after the single
 * permitted re-prompt. The Trio runner converts this into an outcome of
 * `regressed` with the parse error as the reason; we throw a typed
 * subclass so callers can distinguish parse failures from executor I/O.
 */
export class RoundReturnParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoundReturnParseError';
  }
}

interface ValidationResult {
  ok: boolean;
  /** Joined human-readable reason; populated when !ok */
  reason?: string;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function validateEvaluation(ev: unknown): ValidationResult {
  if (typeof ev !== 'object' || ev === null) {
    return { ok: false, reason: 'evaluation must be an object' };
  }
  const e = ev as Partial<RoundEvaluation>;
  if (
    e.verdict !== 'passed' &&
    e.verdict !== 'failed-fixed' &&
    e.verdict !== 'failed-escalate'
  ) {
    return { ok: false, reason: `evaluation.verdict invalid: ${String(e.verdict)}` };
  }
  if (!Array.isArray(e.criteria)) {
    return { ok: false, reason: 'evaluation.criteria missing or not an array' };
  }
  for (const [i, c] of e.criteria.entries()) {
    if (typeof c !== 'object' || c === null) {
      return { ok: false, reason: `evaluation.criteria[${i}] not an object` };
    }
    const cc = c as Partial<RoundEvaluation['criteria'][number]>;
    if (typeof cc.criterion !== 'string') {
      return { ok: false, reason: `evaluation.criteria[${i}].criterion missing` };
    }
    if (
      cc.outcome !== 'passed' &&
      cc.outcome !== 'failed' &&
      cc.outcome !== 'untestable'
    ) {
      return {
        ok: false,
        reason: `evaluation.criteria[${i}].outcome invalid: ${String(cc.outcome)}`,
      };
    }
  }
  if (!isStringArray(e.test_commits)) {
    return { ok: false, reason: 'evaluation.test_commits must be a string[]' };
  }
  if (!isStringArray(e.fix_commits)) {
    return { ok: false, reason: 'evaluation.fix_commits must be a string[]' };
  }
  return { ok: true };
}

function validateRoundReturn(brief: RoundBrief, ret: unknown): ValidationResult {
  if (typeof ret !== 'object' || ret === null) {
    return { ok: false, reason: 'return is not an object' };
  }
  const r = ret as Partial<RoundReturn>;
  if (
    r.status !== 'continue' &&
    r.status !== 'needs-input' &&
    r.status !== 'blocked' &&
    r.status !== 'done'
  ) {
    return { ok: false, reason: `status invalid: ${String(r.status)}` };
  }
  if (typeof r.summary !== 'string' || r.summary.length === 0) {
    return { ok: false, reason: 'summary missing or empty' };
  }
  if (!isStringArray(r.findings_written)) {
    return { ok: false, reason: 'findings_written must be a string[]' };
  }
  if (!isStringArray(r.commits)) {
    return { ok: false, reason: 'commits must be a string[]' };
  }
  if (r.next_round_brief !== undefined && typeof r.next_round_brief !== 'string') {
    return { ok: false, reason: 'next_round_brief must be a string when present' };
  }

  if (brief.kind === 'qa') {
    const evRes = validateEvaluation(r.evaluation);
    if (!evRes.ok) return evRes;
  } else if (r.evaluation !== undefined) {
    // Non-QA rounds shouldn't be filling the evaluation block; not fatal,
    // but worth logging once.
    logger.warn(
      { trio_id: brief.trio_id, kind: brief.kind },
      'evaluation present on non-QA round; ignoring',
    );
  }

  return { ok: true };
}

/** Truncates a summary to MAX_SUMMARY_LINES lines, logging when it had to clip. */
function normaliseSummary(brief: RoundBrief, summary: string): string {
  const lines = summary.split('\n');
  if (lines.length <= MAX_SUMMARY_LINES) return summary;
  logger.warn(
    {
      trio_id: brief.trio_id,
      kind: brief.kind,
      provided_lines: lines.length,
      max_lines: MAX_SUMMARY_LINES,
    },
    'round summary exceeded line cap; truncating',
  );
  return `${lines.slice(0, MAX_SUMMARY_LINES).join('\n')}\n... [truncated ${lines.length - MAX_SUMMARY_LINES} more lines]`;
}

/**
 * Run a round through the executor with one validation retry. On second
 * failure throws `RoundReturnParseError`; the trio runner converts that
 * into a `regressed` outcome with the parse reason.
 */
export async function runRound(
  executor: RoundExecutor,
  brief: RoundBrief,
): Promise<RoundReturn> {
  logger.info(
    { trio_id: brief.trio_id, kind: brief.kind, mode: brief.mode },
    'round.start',
  );

  let raw = await executor.run(brief);
  let v = validateRoundReturn(brief, raw);

  if (!v.ok) {
    logger.warn(
      { trio_id: brief.trio_id, kind: brief.kind, reason: v.reason },
      'round return failed validation; re-prompting once',
    );
    const retryBrief: RoundBrief = {
      ...brief,
      body: `${brief.body}\n\nReturn ONLY the structured block.`,
    };
    raw = await executor.run(retryBrief);
    v = validateRoundReturn(brief, raw);
    if (!v.ok) {
      logger.error(
        { trio_id: brief.trio_id, kind: brief.kind, reason: v.reason },
        'round return failed validation after re-prompt',
      );
      throw new RoundReturnParseError(
        `round ${brief.kind} failed validation: ${v.reason ?? 'unknown'}`,
      );
    }
  }

  // Validation guarantees raw matches RoundReturn shape past this point.
  const ret = raw as RoundReturn;
  const normalised: RoundReturn = {
    ...ret,
    summary: normaliseSummary(brief, ret.summary),
  };

  logger.info(
    {
      trio_id: brief.trio_id,
      kind: brief.kind,
      status: normalised.status,
      commits: normalised.commits.length,
      findings: normalised.findings_written.length,
    },
    'round.end',
  );

  return normalised;
}
