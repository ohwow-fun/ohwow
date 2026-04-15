/**
 * Deterministic redactor for LLM prompt context.
 *
 * Root-cause lesson from the April 2026 x-posting incident: the autonomous
 * author ingested the running debug Chrome state (real profile directory
 * → real email addresses) and used those verbatim as "examples" in commit
 * messages and docblocks. The downstream content gate in safeSelfCommit
 * now catches the output, but the cleaner cut is preventing the LLM from
 * ever seeing the raw identifier. This module is the upstream cut: call
 * it on any string, finding evidence, or config blob before handing it
 * to `runLlmCall`.
 *
 * Redaction is deterministic and reversible to a caller that holds the
 * same input — the placeholder is derived from a short hash of the
 * original, so the same real string always maps to the same placeholder.
 * That preserves the LLM's ability to reason about "these two mentions
 * refer to the same person" without the LLM ever seeing the person's
 * identity. Callers that need to map back (rare; usually you do not)
 * can carry the `replacements` map returned alongside the redacted text.
 */

import { createHash } from 'node:crypto';

/** A single redaction record: what was replaced with what. */
export interface Redaction {
  original: string;
  placeholder: string;
  /** The pattern class that triggered — useful for audit logs. */
  kind: 'personal-email' | 'phone-number' | 'url-with-identifier';
}

export interface RedactionResult {
  /** The input with sensitive spans replaced by deterministic placeholders. */
  redacted: string;
  /** One entry per replaced span, in first-occurrence order. */
  replacements: Redaction[];
}

/** Short deterministic hash for placeholder suffixes. Keep it 8 chars so placeholders read cleanly. */
function hash8(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

/**
 * Producer of stable placeholders. We keep a tiny per-call cache so the
 * same input maps to the same output within a single redaction pass —
 * the LLM sees consistent identifiers it can reason about.
 */
function placeholderFor(
  kind: Redaction['kind'],
  original: string,
  cache: Map<string, string>,
): string {
  const cached = cache.get(original);
  if (cached) return cached;
  let out: string;
  switch (kind) {
    case 'personal-email': {
      // Preserve the TLD structure so the LLM still knows "this is an email"
      // without seeing the real local-part or domain. example.com is the
      // RFC-reserved fictional domain; hash8 disambiguates multiple redacted
      // emails from each other.
      out = `redacted-${hash8(original)}@example.com`;
      break;
    }
    case 'phone-number': {
      out = `+1-555-0${hash8(original).slice(0, 3)}`;
      break;
    }
    case 'url-with-identifier': {
      out = `https://example.com/redacted-${hash8(original)}`;
      break;
    }
  }
  cache.set(original, out);
  return out;
}

/**
 * Patterns considered "sensitive context" for LLM prompts.
 *
 * Scope is intentionally narrower than secret-patterns.ts: this module
 * redacts upstream of the LLM, so it must be conservative enough to not
 * destroy useful signal. secret-patterns.ts runs downstream and can
 * block aggressively. Two different trade-offs, two different modules.
 *
 * What this redacts:
 *   - Personal emails on common providers + ohwow-adjacent work domains.
 *   - Phone numbers in the E.164-ish `+NN NNN NNN NNNN` shape.
 *   - URLs with a trailing identifier that looks like a user handle
 *     (github.com/<user>, x.com/<handle>, linkedin.com/in/<slug>).
 *
 * What it deliberately does NOT redact:
 *   - Placeholder domains (example.com, example.org, acme.test) — the
 *     LLM needs to produce these in its outputs; redacting would strip
 *     the exemplar it should copy.
 *   - Company handles and product names — those are public branding.
 *   - Commit SHAs, hashes — public in a git repo.
 */
interface RedactPattern {
  kind: Redaction['kind'];
  re: RegExp;
  /** Optional guard: predicate to skip redaction for a specific match (e.g. placeholder domains). */
  skip?: (match: string) => boolean;
}

const PATTERNS: readonly RedactPattern[] = [
  {
    kind: 'personal-email',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    skip: (m) => {
      const domain = m.split('@')[1]?.toLowerCase() ?? '';
      return /\.(example|invalid|localhost|test)$/.test(domain)
        || domain === 'example.com'
        || domain === 'example.org'
        || domain === 'example.net'
        || domain === 'acme.test'
        || domain.endsWith('.local');
    },
  },
  {
    kind: 'phone-number',
    re: /\+?\d{1,3}[\s-]?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g,
    skip: (m) => m.replace(/\D/g, '').length < 7,
  },
  {
    kind: 'url-with-identifier',
    re: /\bhttps?:\/\/(?:github\.com|x\.com|twitter\.com|linkedin\.com\/in)\/[A-Za-z0-9][A-Za-z0-9_-]*/g,
    // github.com/ohwow-fun (the org) is the repo itself; don't redact.
    // Extend with per-project allowlists later if needed.
    skip: (m) => /github\.com\/ohwow-fun(?:\/|$)/.test(m),
  },
];

/**
 * Scan `text` and replace every sensitive span with a deterministic
 * placeholder. Returns both the redacted string and the list of
 * replacements, so callers can log what was redacted for audit.
 *
 * Idempotent: calling twice on the same input returns the same output
 * and the same replacements list (order: first occurrence).
 */
export function redactForPrompt(text: string): RedactionResult {
  const cache = new Map<string, string>();
  const replacements: Redaction[] = [];
  let out = text;
  for (const spec of PATTERNS) {
    spec.re.lastIndex = 0;
    out = out.replace(spec.re, (match) => {
      if (spec.skip?.(match)) return match;
      const placeholder = placeholderFor(spec.kind, match, cache);
      if (!replacements.some((r) => r.original === match)) {
        replacements.push({ original: match, placeholder, kind: spec.kind });
      }
      return placeholder;
    });
  }
  return { redacted: out, replacements };
}

/**
 * Redact an arbitrary JSON-serializable object. Traverses strings; leaves
 * numbers, booleans, nulls alone. Useful for redacting finding evidence
 * blobs before serializing them into a prompt.
 */
export function redactForPromptDeep<T>(value: T): { redacted: T; replacements: Redaction[] } {
  const all: Redaction[] = [];
  const seen = new Map<string, string>();

  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redactForPrompt(v);
      for (const rep of r.replacements) {
        if (!seen.has(rep.original)) {
          seen.set(rep.original, rep.placeholder);
          all.push(rep);
        }
      }
      return r.redacted;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };

  return { redacted: walk(value) as T, replacements: all };
}
