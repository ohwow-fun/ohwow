/**
 * Deterministic secret + personal-data detection for autonomous commits.
 *
 * This module is the TypeScript counterpart to scripts/check-personal-data.sh.
 * The shell hook runs on human commits via husky; this module runs inside the
 * autonomous-commit pipeline (safeSelfCommit) where the LLM-generated content
 * never touches a shell — the shell hook would fire AFTER the daemon had
 * already written bytes to disk, and a hard refusal needs to happen BEFORE
 * git sees them.
 *
 * Two overlapping concerns covered:
 *   1. Personal identifier leaks — real emails on common providers, known
 *      ohwow-adjacent work domains. Same pattern bank the shell hook uses.
 *   2. Credential-shaped tokens — API keys, bearer tokens, private-key PEM
 *      blocks. These are the "what if next time it's a token, not an email"
 *      fallout the gap analysis flagged.
 *
 * Pattern list is intentionally conservative: false positives block a
 * commit, which an operator has to clear; false negatives ship a secret.
 * We'd rather eat the occasional review friction than the occasional leak.
 */

/** Classification of what a scanner hit looks like. */
export type SecretKind =
  | 'personal-email'
  | 'api-key'
  | 'bearer-token'
  | 'private-key-block'
  | 'github-token'
  | 'anthropic-key'
  | 'openai-key'
  | 'aws-access-key'
  | 'slack-token';

export interface SecretHit {
  kind: SecretKind;
  /** Matched substring, truncated to keep audit logs bounded. */
  match: string;
  /** Where the hit surfaced (file path, or 'commit-message'). */
  source: string;
  /** 1-based line number within `source` for file hits; undefined for messages. */
  line?: number;
}

interface PatternSpec {
  kind: SecretKind;
  /** Global, multiline-friendly regex. */
  re: RegExp;
  /** True when this pattern should be excluded on Signed-off-by / Co-Authored-By trailer lines. */
  allowTrailers?: boolean;
}

/**
 * Core pattern bank. Each entry mirrors a well-known leak shape.
 * Citations in-line so the next engineer knows what these match and why.
 */
const PATTERNS: readonly PatternSpec[] = [
  // Real-email providers + ohwow-adjacent work domains. Mirrors
  // scripts/check-personal-data.sh. The trailer allowance handles the
  // accepted Signed-off-by / Co-Authored-By leak in this repo's history.
  {
    kind: 'personal-email',
    re: /[A-Za-z0-9._%+-]+@(gmail|googlemail|yahoo|outlook|hotmail|icloud|live|proton(?:mail)?|ohwow\.fun|dcommunity\.io|aved\.ai)\.?(?:com|org|net|io|ai|fun|me)?\b/gi,
    allowTrailers: true,
  },
  // GitHub personal access tokens. Format documented by GitHub:
  //   ghp_<36 base62>, ghs_<36>, gho_<36>, ghu_<36>, ghr_<36>
  {
    kind: 'github-token',
    re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  },
  // Anthropic API keys. Format: sk-ant-api##-<base64ish>-<base64ish>
  {
    kind: 'anthropic-key',
    re: /\bsk-ant-(?:api|admin)[0-9]{2}-[A-Za-z0-9_-]{40,}\b/g,
  },
  // OpenAI API keys. Format: sk-[project-]<alphanum, 20+>.
  {
    kind: 'openai-key',
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  // AWS access key IDs. Format: AKIA + 16 uppercase alphanumerics.
  {
    kind: 'aws-access-key',
    re: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  // Slack tokens. Format: xox[abprs]-... across several variants.
  {
    kind: 'slack-token',
    re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  // PEM-wrapped private key blocks (RSA, EC, OPENSSH, PGP, etc.). The
  // BEGIN header is the smoking gun; we match the opening marker only,
  // then the surrounding lines get captured via the hit's line context.
  {
    kind: 'private-key-block',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
  },
  // Generic bearer-token-shaped long strings preceded by a keyword.
  // Narrow to reduce false positives: require a recognizably "secret"
  // keyword immediately before the value.
  {
    kind: 'bearer-token',
    re: /(?:authorization|bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)['"\s:=]+[A-Za-z0-9_\-.=]{24,}/gi,
  },
  // Generic api-key-shaped assignment. Similar to bearer-token but
  // scoped to assignment syntax (=, :, =>). Lower confidence; still
  // blocks because a false-positive is cheap and a false-negative is
  // catastrophic.
  {
    kind: 'api-key',
    re: /(?:secret|token|password|passwd|pwd)['"\s]*[:=]\s*['"][A-Za-z0-9_\-.=]{16,}['"]/gi,
  },
];

/** True when the given line looks like a commit trailer we allow to carry personal data. */
function isTrailerLine(line: string): boolean {
  return /^(?:Signed-off-by|Co-Authored-By):/i.test(line.trim());
}

/**
 * True when the generic bearer-token / api-key match is a reference to an
 * env var rather than an inline secret. The tail `process.env.OPENAI_API_KEY`
 * is 26 `[A-Za-z0-9_]` chars, so `apiKey: process.env.OPENAI_API_KEY` trips
 * the bearer-token regex — but no secret has actually landed in source.
 * Scoped to the already-matched substring so unrelated `$VAR` usages don't
 * get silently suppressed elsewhere.
 */
const ENV_REFERENCE_MARKERS: readonly RegExp[] = [
  /process\.env\b/i,
  /import\.meta\.env\b/i,
  /os\.environ\b/i,
  /Deno\.env\b/i,
  /\$\{?[A-Z_][A-Z0-9_]*\}?/,
];
function isEnvReference(match: string): boolean {
  return ENV_REFERENCE_MARKERS.some((re) => re.test(match));
}

/**
 * Scan a blob of text for any pattern match. Returns all hits; empty
 * array means clean. `source` is a human-readable label that ends up in
 * each SecretHit for downstream audit logging.
 */
export function scanForSecrets(text: string, source: string): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = text.split('\n');
  for (const spec of PATTERNS) {
    // Reset `lastIndex` defensively: global regex state persists across
    // `.exec()` calls and would skip matches on the second call.
    spec.re.lastIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (spec.allowTrailers && isTrailerLine(line)) continue;
      // `String.prototype.matchAll` returns all non-overlapping matches.
      for (const m of line.matchAll(spec.re)) {
        // Env-var references aren't secrets — suppress on the two generic
        // keyword-triggered patterns where this false positive is common.
        if (
          (spec.kind === 'bearer-token' || spec.kind === 'api-key') &&
          isEnvReference(m[0])
        ) {
          continue;
        }
        hits.push({
          kind: spec.kind,
          match: m[0].length > 120 ? `${m[0].slice(0, 117)}...` : m[0],
          source,
          line: i + 1,
        });
      }
    }
  }
  return hits;
}

/**
 * Scan an arbitrary set of file contents plus a commit message. Returns
 * aggregated hits across all inputs. This is the shape safeSelfCommit
 * will call: one blob per file being written, plus the message itself.
 */
export function scanSelfCommitInputs(
  files: readonly { path: string; content: string }[],
  commitMessage: string,
): SecretHit[] {
  const out: SecretHit[] = [];
  for (const f of files) {
    out.push(...scanForSecrets(f.content, f.path));
  }
  out.push(...scanForSecrets(commitMessage, 'commit-message'));
  return out;
}

/**
 * Compact, human-readable one-line summary of a hit set for embedding
 * in safeSelfCommit's refusal reason. Keep within ~200 chars so the
 * downstream logging path stays readable.
 */
export function summarizeHits(hits: readonly SecretHit[]): string {
  if (hits.length === 0) return '';
  const first = hits[0];
  const where = first.line !== undefined ? `${first.source}:${first.line}` : first.source;
  return `${hits.length} secret-pattern hit(s); first: ${first.kind} at ${where} (match: ${first.match.slice(0, 40)}${first.match.length > 40 ? '...' : ''})`;
}
