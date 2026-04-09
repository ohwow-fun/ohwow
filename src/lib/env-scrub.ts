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
