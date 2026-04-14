/**
 * Fixture coverage for the doc-drift audit module. Stubs a DriftCtx
 * backed by an in-memory file map + a fake git runner, runs the
 * runner against synthetic claims, asserts correct classification.
 * No dependency on the real repo.
 */

import { describe, it, expect } from 'vitest';
import type { DriftClaim, DriftCtx, DriftResult } from '../doc-drift-audit.js';
import {
  runDriftAudit,
  formatDriftReport,
  extractConstLiteral,
  parseNumericLiteral,
} from '../doc-drift-audit.js';

// Minimal stub context: in-memory file map, stubbed git log, no grep.
function stubCtx(files: Record<string, string> = {}, gitOut: Record<string, string> = {}): DriftCtx {
  return {
    repoRoot: '/fake',
    readFile(rel) {
      if (!(rel in files)) throw new Error(`no such file: ${rel}`);
      return files[rel];
    },
    fileExists(rel) { return rel in files; },
    grep() { return []; },
    git(args) {
      if (args in gitOut) return gitOut[args];
      throw new Error(`git stub: no canned response for "${args}"`);
    },
    listSources() { return []; },
  };
}

function cleanResult(verdict: string): DriftResult { return { passed: true, severity: 'clean', verdict }; }
function majorResult(verdict: string): DriftResult { return { passed: false, severity: 'major', verdict }; }
function minorResult(verdict: string): DriftResult { return { passed: false, severity: 'minor', verdict }; }

describe('extractConstLiteral', () => {
  it('extracts a plain numeric const', () => {
    expect(extractConstLiteral('const X = 42;', 'X')).toBe('42');
  });
  it('extracts an underscore-separated numeric const', () => {
    expect(extractConstLiteral('const TIMEOUT = 60_000;', 'TIMEOUT')).toBe('60_000');
  });
  it('extracts a typed const', () => {
    expect(extractConstLiteral('const X: number = 7;', 'X')).toBe('7');
  });
  it('returns null when the const does not exist', () => {
    expect(extractConstLiteral('const Y = 1;', 'X')).toBeNull();
  });
});

describe('parseNumericLiteral', () => {
  it('parses plain numbers', () => {
    expect(parseNumericLiteral('42')).toBe(42);
  });
  it('parses underscore-separated numbers', () => {
    expect(parseNumericLiteral('60_000')).toBe(60000);
  });
  it('ignores whitespace', () => {
    expect(parseNumericLiteral(' 60_000 ')).toBe(60000);
  });
  it('returns null for expressions', () => {
    expect(parseNumericLiteral('Math.max(1, 2)')).toBeNull();
  });
});

describe('runDriftAudit', () => {
  it('reports a clean run when every claim passes', () => {
    const claims: DriftClaim[] = [
      {
        id: 'always-passes',
        description: 'trivially passing',
        source: 'test',
        severityOnFail: 'minor',
        verify: () => cleanResult('all good'),
      },
      {
        id: 'also-passes',
        description: 'also passing',
        source: 'test',
        severityOnFail: 'major',
        verify: () => cleanResult('also good'),
      },
    ];
    const run = runDriftAudit(claims, stubCtx());
    expect(run.summary.total).toBe(2);
    expect(run.summary.clean).toBe(2);
    expect(run.summary.minor).toBe(0);
    expect(run.summary.major).toBe(0);
  });

  it('captures severity per claim based on the verify result', () => {
    const claims: DriftClaim[] = [
      { id: 'clean1', description: '', source: '', severityOnFail: 'major', verify: () => cleanResult('ok') },
      { id: 'minor1', description: '', source: '', severityOnFail: 'minor', verify: () => minorResult('drifted a bit') },
      { id: 'major1', description: '', source: '', severityOnFail: 'major', verify: () => majorResult('drifted hard') },
    ];
    const run = runDriftAudit(claims, stubCtx());
    expect(run.summary.clean).toBe(1);
    expect(run.summary.minor).toBe(1);
    expect(run.summary.major).toBe(1);
  });

  it('catches a verifier that throws and surfaces the error as a failure', () => {
    const claims: DriftClaim[] = [
      {
        id: 'bomb',
        description: 'throws inside verify',
        source: 'test',
        severityOnFail: 'major',
        verify: () => { throw new Error('kaboom'); },
      },
    ];
    const run = runDriftAudit(claims, stubCtx());
    expect(run.summary.major).toBe(1);
    expect(run.results[0].result.verdict).toContain('kaboom');
    expect(run.results[0].result.passed).toBe(false);
  });
});

describe('formatDriftReport', () => {
  it('produces a tagged, severity-sorted report', () => {
    const claims: DriftClaim[] = [
      { id: 'a-clean', description: '', source: 'src/a.ts', severityOnFail: 'minor', verify: () => cleanResult('ok') },
      { id: 'b-major', description: '', source: 'src/b.ts', severityOnFail: 'major', verify: () => majorResult('broken') },
      { id: 'c-minor', description: '', source: 'src/c.ts', severityOnFail: 'minor', verify: () => minorResult('drifted') },
    ];
    const run = runDriftAudit(claims, stubCtx());
    const report = formatDriftReport(run);

    expect(report).toContain('doc↔code drift audit');
    expect(report).toContain('🔴 b-major');
    expect(report).toContain('🟡 c-minor');
    expect(report).toContain('🟢 a-clean');

    // Major should come before minor which should come before clean
    const majorIdx = report.indexOf('🔴');
    const minorIdx = report.indexOf('🟡');
    const cleanIdx = report.indexOf('🟢');
    expect(majorIdx).toBeLessThan(minorIdx);
    expect(minorIdx).toBeLessThan(cleanIdx);
  });

  it('renders evidence lines (capped at 5 with a +more counter)', () => {
    const claims: DriftClaim[] = [
      {
        id: 'many-evidence',
        description: '',
        source: '',
        severityOnFail: 'minor',
        verify: () => ({
          passed: false,
          severity: 'minor' as const,
          verdict: 'many offenders',
          evidence: Array.from({ length: 8 }, (_, i) => `file${i}.ts`),
        }),
      },
    ];
    const run = runDriftAudit(claims, stubCtx());
    const report = formatDriftReport(run);
    expect(report).toContain('file0.ts');
    expect(report).toContain('file4.ts');
    expect(report).toContain('and 3 more');
  });
});

describe('end-to-end: a minimal const-value claim against stub files', () => {
  it('passes when the constant has the expected value', () => {
    const ctx = stubCtx({
      'src/foo.ts': 'export const TIMEOUT = 60_000;',
    });
    const claims: DriftClaim[] = [
      {
        id: 'timeout-is-60s',
        description: 'TIMEOUT = 60000',
        source: 'src/foo.ts',
        severityOnFail: 'major',
        verify(c) {
          const src = c.readFile('src/foo.ts');
          const lit = extractConstLiteral(src, 'TIMEOUT');
          const n = lit ? parseNumericLiteral(lit) : null;
          if (n === 60_000) return cleanResult(`TIMEOUT = ${n} ✓`);
          return majorResult(`TIMEOUT = ${lit ?? 'missing'}, expected 60000`);
        },
      },
    ];
    const run = runDriftAudit(claims, ctx);
    expect(run.summary.clean).toBe(1);
    expect(run.summary.major).toBe(0);
  });

  it('fails when the constant drifts', () => {
    const ctx = stubCtx({
      'src/foo.ts': 'export const TIMEOUT = 30_000;',
    });
    const claims: DriftClaim[] = [
      {
        id: 'timeout-is-60s',
        description: 'TIMEOUT = 60000',
        source: 'src/foo.ts',
        severityOnFail: 'major',
        verify(c) {
          const src = c.readFile('src/foo.ts');
          const lit = extractConstLiteral(src, 'TIMEOUT');
          const n = lit ? parseNumericLiteral(lit) : null;
          if (n === 60_000) return cleanResult('ok');
          return majorResult(`TIMEOUT = ${lit ?? 'missing'}, expected 60000`);
        },
      },
    ];
    const run = runDriftAudit(claims, ctx);
    expect(run.summary.major).toBe(1);
    expect(run.results[0].result.verdict).toContain('30_000');
  });
});
