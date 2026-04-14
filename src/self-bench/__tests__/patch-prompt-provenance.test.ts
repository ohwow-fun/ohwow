import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateProvenanceInputs,
  buildProvenancePrompt,
  type ProvenanceInput,
} from '../patch-prompt-provenance.js';

let repoRoot: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-'));
});

afterEach(() => {
  try { fs.rmSync(repoRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('validateProvenanceInputs — source allowlist', () => {
  it('accepts the four authoritative sources', () => {
    const findingsJson = '{"id":"abc","verdict":"fail","evidence":{}}';
    fs.writeFileSync(path.join(repoRoot, 'src.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(repoRoot, 'test.ts'), 'it("x", ...);\n');
    fs.writeFileSync(path.join(repoRoot, 'reg.ts'), 'export const R = [];\n');

    const inputs: ProvenanceInput[] = [
      { source: 'finding', ref: 'abc', content: findingsJson },
      { source: 'source-file', ref: 'src.ts', content: 'export const x = 1;\n' },
      { source: 'test-file', ref: 'test.ts', content: 'it("x", ...);\n' },
      { source: 'registry', ref: 'reg.ts', content: 'export const R = [];\n' },
    ];
    expect(validateProvenanceInputs(inputs, repoRoot).ok).toBe(true);
  });

  it.each([
    'llm-call',
    'agent-message',
    'chat-transcript',
    'agent-output',
    'proposal-history',
  ])('rejects forbidden source %s', (badSource) => {
    const r = validateProvenanceInputs(
      [{ source: badSource as never, ref: 'x', content: 'y' }],
      repoRoot,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('forbidden');
  });

  it('rejects a source not in the allowlist at all', () => {
    const r = validateProvenanceInputs(
      [{ source: 'made-up' as never, ref: 'x', content: 'y' }],
      repoRoot,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not in the provenance allowlist');
  });
});

describe('validateProvenanceInputs — shape', () => {
  it('rejects empty input list', () => {
    const r = validateProvenanceInputs([], repoRoot);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no provenance inputs');
  });

  it('rejects empty ref', () => {
    const r = validateProvenanceInputs(
      [{ source: 'finding', ref: '', content: 'x' }],
      repoRoot,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('ref must be');
  });

  it('rejects empty content', () => {
    const r = validateProvenanceInputs(
      [{ source: 'finding', ref: 'abc', content: '' }],
      repoRoot,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('content must be');
  });
});

describe('validateProvenanceInputs — disk verification', () => {
  it('accepts a source-file whose content matches disk', () => {
    fs.writeFileSync(path.join(repoRoot, 'a.ts'), 'export const a = 1;\n');
    const r = validateProvenanceInputs(
      [{ source: 'source-file', ref: 'a.ts', content: 'export const a = 1;\n' }],
      repoRoot,
    );
    expect(r.ok).toBe(true);
  });

  it('refuses a source-file whose content does NOT match disk', () => {
    fs.writeFileSync(path.join(repoRoot, 'a.ts'), 'export const a = 1;\n');
    const r = validateProvenanceInputs(
      [{ source: 'source-file', ref: 'a.ts', content: 'totally different content\n' }],
      repoRoot,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('does not match disk');
  });

  it('refuses a source-file ref that does not exist on disk', () => {
    const r = validateProvenanceInputs(
      [{ source: 'source-file', ref: 'nope.ts', content: 'whatever' }],
      repoRoot,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('could not read');
  });

  it('refuses a source-file with path traversal in the ref', () => {
    const r = validateProvenanceInputs(
      [{ source: 'source-file', ref: '../etc/passwd', content: 'x' }],
      repoRoot,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no traversal');
  });

  it('does NOT disk-verify non-file sources (findings, registries)', () => {
    // A finding is identified by uuid, not a file path — skip disk check.
    const r = validateProvenanceInputs(
      [{ source: 'finding', ref: 'some-uuid', content: 'any content' }],
      repoRoot,
    );
    expect(r.ok).toBe(true);
  });
});

describe('buildProvenancePrompt', () => {
  it('emits one tagged block per input', () => {
    const out = buildProvenancePrompt([
      { source: 'finding', ref: 'abc', content: 'finding-body' },
      { source: 'source-file', ref: 'a.ts', content: 'export const a = 1;' },
    ]);
    expect(out).toContain('<source name="finding" ref="abc">');
    expect(out).toContain('finding-body');
    expect(out).toContain('</source>');
    expect(out).toContain('<source name="source-file" ref="a.ts">');
    // Two blocks separated by a blank line
    expect(out.split('<source').length - 1).toBe(2);
  });

  it('escapes double-quotes in the ref attribute', () => {
    const out = buildProvenancePrompt([
      { source: 'finding', ref: 'weird"uuid', content: 'x' },
    ]);
    expect(out).toContain('ref="weird&quot;uuid"');
  });
});
