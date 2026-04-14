import { describe, it, expect } from 'vitest';
import { diffTopLevelSymbols, changedSymbolCount } from '../patch-ast-bounds.js';

describe('diffTopLevelSymbols', () => {
  it('returns zero changes for byte-identical sources', () => {
    const src = `export const a = 1;\nexport const b = 2;\n`;
    const d = diffTopLevelSymbols(src, src);
    expect(changedSymbolCount(d)).toBe(0);
  });

  it('detects exactly one change when one function body is edited', () => {
    const a = `export function foo() { return 1; }\nexport function bar() { return 2; }\n`;
    const b = `export function foo() { return 42; }\nexport function bar() { return 2; }\n`;
    const d = diffTopLevelSymbols(a, b);
    expect(d.modified).toEqual(['fn:foo']);
    expect(changedSymbolCount(d)).toBe(1);
  });

  it('detects two changes when two declarations are edited', () => {
    const a = `export const x = 1;\nexport const y = 2;\n`;
    const b = `export const x = 99;\nexport const y = 100;\n`;
    const d = diffTopLevelSymbols(a, b);
    expect(d.modified.sort()).toEqual(['var:x', 'var:y']);
    expect(changedSymbolCount(d)).toBe(2);
  });

  it('counts a newly added import as one change', () => {
    const a = `export const x = 1;\n`;
    const b = `import { z } from './z.js';\nexport const x = 1;\n`;
    const d = diffTopLevelSymbols(a, b);
    expect(d.added).toEqual(["import:'./z.js'"]);
    expect(changedSymbolCount(d)).toBe(1);
  });

  it('counts a registry-row append as one change to the array declaration', () => {
    const a = `export const R = [ { slug: 'a' } ];\n`;
    const b = `export const R = [ { slug: 'a' }, { slug: 'b' } ];\n`;
    const d = diffTopLevelSymbols(a, b);
    expect(d.modified).toEqual(['var:R']);
    expect(changedSymbolCount(d)).toBe(1);
  });

  it('counts a registry row append + a new import as TWO changes', () => {
    const a = `export const R = [ { slug: 'a' } ];\n`;
    const b =
      `import type { T } from './t.js';\n` +
      `export const R = [ { slug: 'a' }, { slug: 'b' } ];\n`;
    const d = diffTopLevelSymbols(a, b);
    expect(changedSymbolCount(d)).toBe(2);
  });

  it('ignores whitespace-only edits between declarations', () => {
    const a = `export const x = 1;\nexport const y = 2;\n`;
    const b = `export const x = 1;\n\n\nexport const y = 2;\n`;
    const d = diffTopLevelSymbols(a, b);
    expect(changedSymbolCount(d)).toBe(0);
  });

  it('detects a deletion', () => {
    const a = `export const x = 1;\nexport const y = 2;\n`;
    const b = `export const x = 1;\n`;
    const d = diffTopLevelSymbols(a, b);
    expect(d.removed).toEqual(['var:y']);
    expect(changedSymbolCount(d)).toBe(1);
  });

  it('distinguishes two variables declared in a single statement', () => {
    const a = `export const a = 1, b = 2;\n`;
    const b = `export const a = 99, b = 2;\n`;
    const d = diffTopLevelSymbols(a, b);
    expect(d.modified).toEqual(['var:a']);
    expect(changedSymbolCount(d)).toBe(1);
  });
});
