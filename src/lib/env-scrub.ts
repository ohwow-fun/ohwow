/**
 * Environment variable scrubbing.
 * Strips secrets (API keys, tokens, passwords) from the process environment
 * before passing it to child processes (PTY sessions, bash commands, etc.).
 */

/** Patterns that match environment variable names containing secrets. */
const SECRET_ENV_PATTERNS = [
  /API_KEY/i,
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /ANTHROPIC_API_KEY/i,
  /SSH_AUTH_SOCK/i,
  /AWS_SECRET/i,
  /PRIVATE_KEY/i,
];

/**
 * Env vars that are safe to pass through for git operations.
 * SSH_AUTH_SOCK is a Unix socket path (not a secret itself).
 * GIT_* vars are git configuration, not credentials.
 */
const GIT_SAFE_PATTERNS = [
  /^SSH_AUTH_SOCK$/,
  /^GIT_SSH_COMMAND$/,
  /^GIT_ASKPASS$/,
  /^GIT_AUTHOR_NAME$/,
  /^GIT_AUTHOR_EMAIL$/,
  /^GIT_COMMITTER_NAME$/,
  /^GIT_COMMITTER_EMAIL$/,
  /^GIT_CONFIG_/,
];

/**
 * Return a copy of process.env with secret-bearing variables removed.
 */
export function scrubEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const isSecret = SECRET_ENV_PATTERNS.some((p) => p.test(key));
    if (!isSecret) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Return a copy of process.env with secrets removed, but git-safe vars preserved.
 * Used for git commands that need SSH_AUTH_SOCK for push/pull authentication.
 */
export function scrubEnvironmentForGit(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const isGitSafe = GIT_SAFE_PATTERNS.some((p) => p.test(key));
    if (isGitSafe) {
      env[key] = value;
      continue;
    }
    const isSecret = SECRET_ENV_PATTERNS.some((p) => p.test(key));
    if (!isSecret) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Output-side redaction. Scrubs high-signal token patterns from bash stdout/stderr
 * before the result reaches model context. Defense-in-depth: agents sometimes
 * source .env files or run commands that echo credentials. We do not want raw
 * tokens flowing through chat streams, telemetry, or activity logs.
 *
 * Conservative by design — only redacts patterns with near-zero false positive
 * rate (known prefixes, URI credential syntax). Generic entropy detection is
 * avoided because it mangles legitimate base64 output.
 */
const SECRET_OUTPUT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Fly.io tokens: "FlyV1 fm2_..." or bare "fm2_..." with optional second token after comma
  { pattern: /FlyV1\s+fm2_[A-Za-z0-9+/=_,-]{40,}/g, label: 'FLY_TOKEN' },
  { pattern: /\bfm2_[A-Za-z0-9+/=_-]{60,}(?:,fm2_[A-Za-z0-9+/=_-]{60,})?/g, label: 'FLY_TOKEN' },
  // Anthropic / OpenAI / Google / Groq API keys
  { pattern: /sk-ant-(?:api|admin)[0-9]*-[A-Za-z0-9_-]{20,}/g, label: 'ANTHROPIC_KEY' },
  { pattern: /sk-proj-[A-Za-z0-9_-]{20,}/g, label: 'OPENAI_KEY' },
  { pattern: /\bsk-[A-Za-z0-9]{32,}\b/g, label: 'OPENAI_KEY' },
  { pattern: /\bgsk_[A-Za-z0-9]{40,}\b/g, label: 'GROQ_KEY' },
  // GitHub personal / OAuth / app tokens
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, label: 'GITHUB_TOKEN' },
  // Postgres / generic URI credentials "scheme://user:password@host"
  { pattern: /([a-z][a-z0-9+.-]{2,}):\/\/([^:/@\s]+):([^@\s]+)@/gi, label: 'URI_CREDENTIAL' },
  // Supabase service role / anon JWTs (eyJ + two more base64 segments, 100+ chars)
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, label: 'JWT' },
  // AWS access key id + secret access key
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, label: 'AWS_KEY_ID' },
];

export function scrubBashOutput(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { pattern, label } of SECRET_OUTPUT_PATTERNS) {
    if (label === 'URI_CREDENTIAL') {
      out = out.replace(pattern, (_m, scheme, user) => `${scheme}://${user}:[REDACTED:${label}]@`);
    } else {
      out = out.replace(pattern, `[REDACTED:${label}]`);
    }
  }
  return out;
}
