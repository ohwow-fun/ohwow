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
