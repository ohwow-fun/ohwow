#!/usr/bin/env node
// Pre-push content scanner. Reads git's pre-push stdin format:
//   <local ref> <local sha> <remote ref> <remote sha>
// For each push range, scans every commit's message AND added-diff
// lines for the same pattern bank safeSelfCommit uses.
// Fail-closed: any hit blocks the push.
//
// This is the last line of defense. pre-commit + commit-msg catch
// human commits before landing locally; safeSelfCommit's content
// gate catches autonomous commits. But both can be bypassed with
// --no-verify, and historical commits from before the gates landed
// may still be pushable. This hook runs at push time.
//
// Override for a legitimate case: OHWOW_ALLOW_PERSONAL_DATA=1 git push
// Same override semantics as the pre-commit hook.
//
// Patterns are duplicated from src/lib/secret-patterns.ts so this hook
// has zero dependencies. The two must stay in sync; the secret-patterns
// unit tests don't re-check these regexes directly, so when you change
// one, change both. The cost of duplication (one file to keep synced)
// beats the cost of running `npx tsx` on every push (~1s startup) and
// the cost of building dist before each push.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

if (process.env.OHWOW_ALLOW_PERSONAL_DATA === '1') {
  process.exit(0);
}

// Pattern bank — mirrors src/lib/secret-patterns.ts. Each entry:
//   { kind, re, allowTrailers }
const PATTERNS = [
  {
    kind: 'personal-email',
    re: /[A-Za-z0-9._%+-]+@(gmail|googlemail|yahoo|outlook|hotmail|icloud|live|proton(?:mail)?|ohwow\.fun|dcommunity\.io|aved\.ai)\.?(?:com|org|net|io|ai|fun|me)?\b/gi,
    allowTrailers: true,
  },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: 'anthropic-key', re: /\bsk-ant-(?:api|admin)[0-9]{2}-[A-Za-z0-9_-]{40,}\b/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'private-key-block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g },
  {
    kind: 'bearer-token',
    re: /(?:authorization|bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)['"\s:=]+[A-Za-z0-9_\-.=]{24,}/gi,
  },
  {
    kind: 'api-key',
    re: /(?:secret|token|password|passwd|pwd)['"\s]*[:=]\s*['"][A-Za-z0-9_\-.=]{16,}['"]/gi,
  },
];

function isTrailerLine(line) {
  return /^(?:Signed-off-by|Co-Authored-By):/i.test(line.trim());
}

// Suppress env-var / config-property references on the generic
// bearer-token / api-key patterns. Mirrors ENV_REFERENCE_MARKERS in
// src/lib/secret-patterns.ts. When you change one, change both.
//
// Covers:
//   apiKey: process.env.OPENAI_API_KEY          (env ref)
//   openaiApiKey: config.openaiApiKey           (config passthrough)
//   accessToken: this.opts.accessToken          (this-bound property)
//   apiKey: opts.apiKey || undefined            (plain arg access)
const ENV_REFERENCE_MARKERS = [
  /process\.env\b/i,
  /import\.meta\.env\b/i,
  /os\.environ\b/i,
  /Deno\.env\b/i,
  /\$\{?[A-Z_][A-Z0-9_]*\}?/,
  /\b(?:this\.)?(?:config|opts|options|args|params|env|settings|input)\.[A-Za-z_][A-Za-z0-9_]*/i,
];
function isEnvReference(match) {
  return ENV_REFERENCE_MARKERS.some((re) => re.test(match));
}

function scan(text, source) {
  const hits = [];
  const lines = text.split('\n');
  for (const spec of PATTERNS) {
    spec.re.lastIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (spec.allowTrailers && isTrailerLine(line)) continue;
      for (const m of line.matchAll(spec.re)) {
        if (
          (spec.kind === 'bearer-token' || spec.kind === 'api-key') &&
          isEnvReference(m[0])
        ) {
          continue;
        }
        hits.push({ kind: spec.kind, match: m[0].slice(0, 80), source, line: i + 1 });
      }
    }
  }
  return hits;
}

// git passes update refs on stdin. Read the whole thing synchronously.
const stdin = readFileSync(0, 'utf-8');
if (!stdin.trim()) process.exit(0); // no-op push

const ZERO_SHA = '0000000000000000000000000000000000000000';
const refs = stdin
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    const [localRef, localSha, remoteRef, remoteSha] = l.split(/\s+/);
    return { localRef, localSha, remoteRef, remoteSha };
  });

// Bound commits-per-ref to keep first-push scans from stalling forever.
// Human commits go through pre-commit + commit-msg; autonomous commits
// through safeSelfCommit's content gate. If something ancient slips past
// the 500-limit, it's historical enough that rewriting old history
// makes more sense than catching it here.
const MAX_COMMITS_PER_REF = 500;
const shas = new Set();
for (const { localSha, remoteSha } of refs) {
  if (localSha === ZERO_SHA) continue; // delete-ref, nothing to scan
  const range = remoteSha === ZERO_SHA ? localSha : `${remoteSha}..${localSha}`;
  let list;
  try {
    list = execSync(`git rev-list --max-count=${MAX_COMMITS_PER_REF} ${range}`, {
      encoding: 'utf-8',
    })
      .split('\n')
      .filter(Boolean);
  } catch (err) {
    console.error(`[pre-push] git rev-list failed for ${range}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  for (const s of list) shas.add(s);
}

if (shas.size === 0) process.exit(0);

const allHits = [];
for (const sha of shas) {
  let message, patch;
  try {
    message = execSync(`git log -1 --format=%B ${sha}`, { encoding: 'utf-8' });
    patch = execSync(`git show --format= --no-color ${sha}`, {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`[pre-push] could not read ${sha}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  allHits.push(...scan(message, `commit-message ${sha.slice(0, 8)}`));
  // Added lines only: what's ARRIVING at the HEAD state. Removed lines
  // (- prefix) are the old state going away — they'll exist in history
  // unchanged whether this push lands or not, so flagging them would be
  // pure noise.
  const addedOnly = patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');
  allHits.push(...scan(addedOnly, `commit-diff ${sha.slice(0, 8)}`));
}

if (allHits.length === 0) process.exit(0);

console.error('[pre-push] Blocking: commits being pushed contain personal data or credential-shaped tokens.');
console.error('           Use RFC 2606 placeholders (alice@example.com, acme.test) in fixtures and docblocks.');
console.error('           To override for a legitimate case: OHWOW_ALLOW_PERSONAL_DATA=1 git push');
console.error('');
const first10 = allHits.slice(0, 10);
for (const h of first10) {
  console.error(`  - ${h.kind}  at ${h.source}${h.line !== undefined ? ':' + h.line : ''}`);
}
if (allHits.length > 10) console.error(`  ... ${allHits.length - 10} more hits suppressed`);
process.exit(1);
