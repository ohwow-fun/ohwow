import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInvariantsForPaths } from '../patch-invariants.js';

let root: string;

function seed(rel: string, content: string) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-invariants-'));
  fs.mkdirSync(path.join(root, 'src/self-bench/experiments'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/self-bench/registries'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/self-bench/__tests__'), { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('runInvariantsForPaths — experiment-id-uniqueness', () => {
  it('refuses two files with the same id literal', () => {
    seed('src/self-bench/experiments/a.ts', `export class A { readonly id = 'dup'; }`);
    seed('src/self-bench/experiments/b.ts', `export class B { readonly id = 'dup'; }`);

    const r = runInvariantsForPaths(root, ['src/self-bench/experiments/b.ts']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("duplicate experiment id 'dup'");
  });

  it('passes when ids are distinct', () => {
    seed('src/self-bench/experiments/a.ts', `export class A { readonly id = 'one'; }`);
    seed('src/self-bench/experiments/b.ts', `export class B { readonly id = 'two'; }`);

    expect(runInvariantsForPaths(root, ['src/self-bench/experiments/b.ts']).ok).toBe(true);
  });

  it('skips parameterized base classes (*-probe.ts)', () => {
    seed(
      'src/self-bench/experiments/something-probe.ts',
      `export class X { readonly id = 'dup'; }`,
    );
    seed('src/self-bench/experiments/b.ts', `export class B { readonly id = 'dup'; }`);

    expect(runInvariantsForPaths(root, ['src/self-bench/experiments/b.ts']).ok).toBe(true);
  });
});

describe('runInvariantsForPaths — experiment-blast-radius', () => {
  it('refuses a patched file that imports from ../../orchestrator/', () => {
    seed(
      'src/self-bench/experiments/bad.ts',
      `import { foo } from '../../orchestrator/engine.js';`,
    );
    const r = runInvariantsForPaths(root, ['src/self-bench/experiments/bad.ts']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('forbidden module');
  });

  it('does NOT refuse when a pre-existing (non-patched) file has the forbidden import', () => {
    // Grandfathering: only the files in opts.files are scanned.
    seed(
      'src/self-bench/experiments/grandfathered.ts',
      `import { foo } from '../../orchestrator/engine.js';`,
    );
    seed('src/self-bench/experiments/clean.ts', `export const x = 1;`);

    expect(
      runInvariantsForPaths(root, ['src/self-bench/experiments/clean.ts']).ok,
    ).toBe(true);
  });
});

describe('runInvariantsForPaths — registry-key-uniqueness', () => {
  it('refuses a registry file with a duplicate slug', () => {
    seed(
      'src/self-bench/registries/r.ts',
      `export const R = [{ slug: 'same' }, { slug: 'same' }];`,
    );
    const r = runInvariantsForPaths(root, ['src/self-bench/registries/r.ts']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("duplicate registry key 'same'");
  });

  it('refuses a registry key that is not a slug', () => {
    seed(
      'src/self-bench/registries/r.ts',
      `export const R = [{ slug: 'Bad Slug!' }];`,
    );
    const r = runInvariantsForPaths(root, ['src/self-bench/registries/r.ts']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('must be [a-z0-9-]+');
  });

  it('passes with valid unique slugs', () => {
    seed(
      'src/self-bench/registries/r.ts',
      `export const R = [{ slug: 'foo-bar' }, { slug: 'baz' }];`,
    );
    expect(runInvariantsForPaths(root, ['src/self-bench/registries/r.ts']).ok).toBe(true);
  });
});

describe('runInvariantsForPaths — tests-shape', () => {
  it('refuses a patched test file that does not import from vitest', () => {
    seed('src/self-bench/__tests__/nope.ts', `export const x = 1;`);
    const r = runInvariantsForPaths(root, ['src/self-bench/__tests__/nope.ts']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('vitest');
  });

  it('refuses a patched test file with a leftover .only focus', () => {
    seed(
      'src/self-bench/__tests__/focus.ts',
      `import { it } from 'vitest';\nit.only('x', () => {});`,
    );
    const r = runInvariantsForPaths(root, ['src/self-bench/__tests__/focus.ts']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('.only');
  });

  it('passes a well-formed test file', () => {
    seed(
      'src/self-bench/__tests__/ok.ts',
      `import { it, expect } from 'vitest';\nit('x', () => expect(1).toBe(1));`,
    );
    expect(runInvariantsForPaths(root, ['src/self-bench/__tests__/ok.ts']).ok).toBe(true);
  });
});

describe('runInvariantsForPaths — suite isolation', () => {
  it('a failure in the experiments suite does not block a patch scoped to registries/', () => {
    // Broken experiment file exists on disk but is NOT in patchedFiles,
    // AND the registries suite is the only one whose directory matches.
    seed(
      'src/self-bench/experiments/broken.ts',
      `import { x } from '../../orchestrator/bad.js';`,
    );
    seed(
      'src/self-bench/registries/r.ts',
      `export const R = [{ slug: 'ok' }];`,
    );
    expect(runInvariantsForPaths(root, ['src/self-bench/registries/r.ts']).ok).toBe(true);
  });
});
