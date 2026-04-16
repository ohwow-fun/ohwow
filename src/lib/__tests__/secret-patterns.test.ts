import { describe, it, expect } from 'vitest';
import {
  scanForSecrets,
  scanSelfCommitInputs,
  summarizeHits,
} from '../secret-patterns.js';

describe('scanForSecrets', () => {
  it('flags a personal email on a common provider', () => {
    const hits = scanForSecrets('contact: real@gmail.com', 'test.ts');
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe('personal-email');
    expect(hits[0].source).toBe('test.ts');
    expect(hits[0].line).toBe(1);
  });

  it('flags an ohwow-adjacent work domain', () => {
    expect(scanForSecrets('alice@ohwow.fun', 'x.ts')[0]?.kind).toBe('personal-email');
    expect(scanForSecrets('bob@dcommunity.io', 'x.ts')[0]?.kind).toBe('personal-email');
  });

  it('passes RFC 2606 placeholder domains', () => {
    expect(scanForSecrets('alice@example.com', 'x.ts')).toEqual([]);
    expect(scanForSecrets('eve@example.org', 'x.ts')).toEqual([]);
    expect(scanForSecrets('carol@acme.test', 'x.ts')).toEqual([]);
  });

  it('allows a real email on a Signed-off-by trailer line', () => {
    const txt = 'fix: something\n\nSigned-off-by: someone <real@gmail.com>';
    expect(scanForSecrets(txt, 'msg').filter((h) => h.kind === 'personal-email')).toEqual([]);
  });

  it('still flags a real email on a body line, even when a signoff is present', () => {
    const txt = 'fix: something\n\nExample: real@gmail.com\n\nSigned-off-by: someone <signoff@gmail.com>';
    const emailHits = scanForSecrets(txt, 'msg').filter((h) => h.kind === 'personal-email');
    expect(emailHits).toHaveLength(1);
    expect(emailHits[0].match).toBe('real@gmail.com');
  });

  it('flags a GitHub personal access token', () => {
    const token = 'ghp_' + 'A'.repeat(36);
    expect(scanForSecrets(`const t = "${token}";`, 'x.ts')[0]?.kind).toBe('github-token');
  });

  it('flags an Anthropic API key', () => {
    const key = 'sk-ant-api03-' + 'x'.repeat(60);
    expect(scanForSecrets(`const k = "${key}";`, 'x.ts')[0]?.kind).toBe('anthropic-key');
  });

  it('flags an AWS access key id', () => {
    expect(scanForSecrets('AKIAABCDEFGHIJKLMNOP', 'x.ts')[0]?.kind).toBe('aws-access-key');
  });

  it('flags a PEM-wrapped private key header', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----';
    expect(scanForSecrets(pem, 'key.pem')[0]?.kind).toBe('private-key-block');
  });

  it('flags a bearer-token-shaped value near a secret keyword', () => {
    const hits = scanForSecrets('authorization: "Bearer abc123def456ghi789jkl012mno"', 'x.ts');
    expect(hits.some((h) => h.kind === 'bearer-token')).toBe(true);
  });

  it('flags an assignment with a "secret"-keyworded name', () => {
    const hits = scanForSecrets('const secret = "abc123def456ghi789jkl"', 'x.ts');
    expect(hits.some((h) => h.kind === 'api-key')).toBe(true);
  });

  it('does NOT flag env-var references disguised as bearer tokens', () => {
    const samples = [
      'openAiApiKey: process.env.OPENAI_API_KEY,',
      'const k = import.meta.env.VITE_OPENROUTER_API_KEY;',
      'access_token = os.environ["GITHUB_ACCESS_TOKEN"]',
      'const t = Deno.env.get("CLIENT_SECRET_VALUE");',
      'Authorization: Bearer ${MY_ACCESS_TOKEN}',
    ];
    for (const s of samples) {
      const hits = scanForSecrets(s, 'x.ts').filter(
        (h) => h.kind === 'bearer-token' || h.kind === 'api-key',
      );
      expect(hits, `unexpected hit on: ${s}`).toEqual([]);
    }
  });

  it('does NOT flag config / opts / this.config property passthroughs', () => {
    // Canonical "forward a nullable config field" pattern — 26+ char tail
    // otherwise trips the bearer-token regex. Mirror this list in
    // scripts/check-push-content.mjs's ENV_REFERENCE_MARKERS.
    const samples = [
      'openaiCompatibleApiKey: config.openaiCompatibleApiKey || undefined,',
      'anthropicApiKey: config.anthropicApiKey || undefined,',
      'const accessToken = this.opts.accessToken;',
      'apiKey: opts.apiKey,',
      'clientSecret: options.clientSecret ?? null,',
      'refreshToken: this.config.refreshToken,',
      'access_token = params.access_token;',
      'authorization = settings.authorization;',
    ];
    for (const s of samples) {
      const hits = scanForSecrets(s, 'x.ts').filter(
        (h) => h.kind === 'bearer-token' || h.kind === 'api-key',
      );
      expect(hits, `unexpected hit on: ${s}`).toEqual([]);
    }
  });

  it('still flags a property access mixed with an inline literal', () => {
    // Defense in depth: even if the line mentions `config.foo` elsewhere,
    // an INLINE literal in the same line must still land.
    const kw = 'author' + 'ization';
    const prefix = 'Bear' + 'er';
    const value = 'abc123def456ghi789jkl012mno';
    const line = `// note: also uses config.something_else\n${kw}: "${prefix} ${value}"`;
    expect(scanForSecrets(line, 'x.ts').some((h) => h.kind === 'bearer-token')).toBe(true);
  });

  it('still flags a real inline bearer even when the line mentions env elsewhere', () => {
    // Keywords are split so the bytes of this source file do not themselves
    // trip the pre-push scanner. Runtime value is unchanged.
    const kw = 'author' + 'ization';
    const prefix = 'Bear' + 'er';
    const value = 'abc123def456ghi789jkl012mno';
    const line = `// note: replaces process.env fallback\n${kw}: "${prefix} ${value}"`;
    expect(scanForSecrets(line, 'x.ts').some((h) => h.kind === 'bearer-token')).toBe(true);
  });

  it('returns an empty array for clean text', () => {
    expect(scanForSecrets('just some code\nconst x = 1;', 'x.ts')).toEqual([]);
  });

  it('records the 1-based line number of the hit', () => {
    const text = 'line 1\nline 2\nreal@gmail.com\nline 4';
    expect(scanForSecrets(text, 'x.ts')[0]?.line).toBe(3);
  });

  it('does not leak long match strings; truncates to 120 chars', () => {
    const giant = 'sk-proj-' + 'A'.repeat(500);
    const hit = scanForSecrets(giant, 'x.ts').find((h) => h.kind === 'openai-key');
    expect(hit).toBeDefined();
    expect(hit!.match.length).toBeLessThanOrEqual(120);
    expect(hit!.match.endsWith('...')).toBe(true);
  });
});

describe('scanSelfCommitInputs', () => {
  it('reports hits from each file and the commit message together', () => {
    const hits = scanSelfCommitInputs(
      [
        { path: 'a.ts', content: 'const x = "real@gmail.com";' },
        { path: 'b.ts', content: 'const y = "alice@example.com";' },
      ],
      'feat: something\n\nReaches out to person@yahoo.com for review.',
    );
    const sources = hits.map((h) => h.source).sort();
    expect(sources).toContain('a.ts');
    expect(sources).toContain('commit-message');
    expect(sources).not.toContain('b.ts'); // placeholder email, no hit
  });

  it('returns [] when every input is clean', () => {
    expect(
      scanSelfCommitInputs(
        [{ path: 'a.ts', content: 'const x = "alice@example.com";' }],
        'feat: use placeholders only',
      ),
    ).toEqual([]);
  });
});

describe('summarizeHits', () => {
  it('returns an empty string for no hits', () => {
    expect(summarizeHits([])).toBe('');
  });

  it('summarizes the first hit with count + kind + location + match excerpt', () => {
    const summary = summarizeHits([
      { kind: 'personal-email', match: 'real@gmail.com', source: 'x.ts', line: 3 },
      { kind: 'github-token', match: 'ghp_abc', source: 'y.ts', line: 1 },
    ]);
    expect(summary).toMatch(/2 secret-pattern hit\(s\)/);
    expect(summary).toContain('personal-email');
    expect(summary).toContain('x.ts:3');
  });
});
