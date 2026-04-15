/**
 * Programmatic detectors for the copywriting rules that live in
 * src/lib/copywriting-rules.ts and CLAUDE.md. The rules file holds
 * the human-readable policy (used as a system prompt); this module
 * makes a subset of them machine-checkable so we can lint rendered
 * UI text without an LLM call.
 *
 * Scope
 * -----
 * Rules here are the narrow, high-precision ones — phrases we never
 * want to see in user-facing copy regardless of context. Fuzzier
 * rules (passive empty states, corporate tone, consistent product
 * language) stay in LLM-land where judgment can be applied.
 *
 * A detector is (regexp, rule-id, severity, message, optional
 * suggestion). Violations are emitted in source order so the same
 * phrase appearing twice on a page is reported twice — the caller
 * decides whether to dedupe.
 *
 * Callers: DashboardCopyExperiment (runtime: visible DOM text) and
 * eventually a pre-commit check (static: JSX/TSX source).
 */

export type CopyRuleSeverity = 'error' | 'warning';

export interface CopyRule {
  id: string;
  pattern: RegExp;
  severity: CopyRuleSeverity;
  message: string;
  /**
   * Optional transformer to preview a rewrite. Purely informational —
   * the lint step never applies it; a patch author does.
   */
  suggest?: (match: string) => string;
}

export interface CopyViolation {
  ruleId: string;
  severity: CopyRuleSeverity;
  /** The exact substring that matched. */
  match: string;
  /** Character index in the input text where the match starts. */
  index: number;
  message: string;
  suggest?: string;
}

/**
 * Canonical rule set. Each rule ships with a regex precise enough
 * that a false positive is surprising. When in doubt, err on the
 * side of NOT adding a rule here — a noisy lint is worse than a
 * silent one. Fuzzy cases belong in an LLM critique pass.
 */
export const COPY_RULES: readonly CopyRule[] = [
  {
    id: 'no-failed-to',
    pattern: /\bFailed to\b/,
    severity: 'error',
    message:
      'Avoid "Failed to X." Use "Couldn\'t X. Try again?" or "Couldn\'t X. Try refreshing."',
    suggest: (m) => m.replace(/^Failed to\b/, "Couldn't"),
  },
  {
    id: 'no-paren-s',
    pattern: /\w+\(s\)/,
    severity: 'error',
    message:
      'Avoid "(s)" pluralization. Write a conditional plural like "1 task / 3 tasks".',
  },
  {
    id: 'no-em-dash',
    pattern: /—/,
    severity: 'warning',
    message:
      'Avoid em dashes in user-facing copy. Use a period, comma, semicolon, or line break.',
    suggest: (m) => m.replace(/—/g, '. '),
  },
  {
    id: 'no-en-dash',
    pattern: /–/,
    severity: 'warning',
    message:
      'Avoid en dashes in user-facing copy. Use a hyphen, "to", or a range notation.',
  },
  {
    id: 'no-please',
    pattern: /\bplease\b/i,
    severity: 'warning',
    message:
      'Avoid "please" in direct instructions or validation errors — be direct.',
  },
  {
    id: 'no-unable-to',
    pattern: /\bUnable to\b/,
    severity: 'warning',
    message: 'Prefer "Couldn\'t X" over "Unable to X".',
    suggest: (m) => m.replace(/^Unable to\b/, "Couldn't"),
  },
  {
    id: 'no-an-error-occurred',
    pattern: /\ban error occurred\b/i,
    severity: 'error',
    message:
      'Avoid generic "An error occurred". Say what broke and what the user can try.',
  },
];

/**
 * Lint one chunk of text against a rule set. Returns violations in
 * index order. Non-string inputs return []. An empty ruleset returns
 * []. Regex state across rules is independent; we build a per-call
 * RegExp each time to avoid global-flag contamination.
 */
export function lintCopy(
  text: unknown,
  rules: readonly CopyRule[] = COPY_RULES,
): CopyViolation[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out: CopyViolation[] = [];
  for (const rule of rules) {
    // Re-create with /g so we can walk every occurrence, preserving
    // the rule's own flags.
    const flags = rule.pattern.flags.includes('g')
      ? rule.pattern.flags
      : rule.pattern.flags + 'g';
    const walker = new RegExp(rule.pattern.source, flags);
    let m: RegExpExecArray | null;
    while ((m = walker.exec(text)) !== null) {
      if (m[0].length === 0) {
        walker.lastIndex++;
        continue;
      }
      out.push({
        ruleId: rule.id,
        severity: rule.severity,
        match: m[0],
        index: m.index,
        message: rule.message,
        suggest: rule.suggest?.(m[0]),
      });
    }
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

/** Pretty-print a violation as a single line for logs. */
export function formatViolation(v: CopyViolation): string {
  return `[${v.severity}] ${v.ruleId} @${v.index}: ${JSON.stringify(v.match)} — ${v.message}`;
}
