import { describe, it, expect } from 'vitest';
import { verifyOnlyStringLiteralsChanged } from '../patch-string-literal-bounds.js';

describe('verifyOnlyStringLiteralsChanged', () => {
  it('accepts byte-identical sources', () => {
    const src = `const x: string = 'hi';\n`;
    expect(verifyOnlyStringLiteralsChanged(src, src).ok).toBe(true);
  });

  it('accepts changes limited to string-literal content', () => {
    const a = `const x: string = 'hello world';\n`;
    const b = `const x: string = 'goodbye world';\n`;
    expect(verifyOnlyStringLiteralsChanged(a, b).ok).toBe(true);
  });

  it('accepts changes inside JSX text', () => {
    const a = `export const C = () => <div>old copy here</div>;\n`;
    const b = `export const C = () => <div>new copy here</div>;\n`;
    expect(verifyOnlyStringLiteralsChanged(a, b).ok).toBe(true);
  });

  it('accepts changes inside template-literal chunks', () => {
    const a = "const msg = `hello ${name} there`;\n";
    const b = "const msg = `hi ${name} friend`;\n";
    expect(verifyOnlyStringLiteralsChanged(a, b).ok).toBe(true);
  });

  it('rejects an identifier rename', () => {
    const a = `const foo = 'x';\n`;
    const b = `const bar = 'x';\n`;
    const r = verifyOnlyStringLiteralsChanged(a, b);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/non-string-literal AST change/);
  });

  it('rejects a new import', () => {
    const a = `const x = 'hi';\n`;
    const b = `import './y.js';\nconst x = 'hi';\n`;
    expect(verifyOnlyStringLiteralsChanged(a, b).ok).toBe(false);
  });

  it('rejects a flipped boolean literal', () => {
    const a = `const on = true;\n`;
    const b = `const on = false;\n`;
    expect(verifyOnlyStringLiteralsChanged(a, b).ok).toBe(false);
  });

  it('rejects a new top-level statement', () => {
    const a = `const x = 'hi';\n`;
    const b = `const x = 'hi';\nconst y = 'bye';\n`;
    expect(verifyOnlyStringLiteralsChanged(a, b).ok).toBe(false);
  });

  it('rejects an added JSX attribute even when strings also change', () => {
    const a = `export const C = () => <div>hi</div>;\n`;
    const b = `export const C = () => <div title="t">bye</div>;\n`;
    expect(verifyOnlyStringLiteralsChanged(a, b).ok).toBe(false);
  });

  it('refuses when post-write source fails to parse', () => {
    const a = `const x = 'hi';\n`;
    const b = `const x = 'hi';\nfunction (\n`;
    const r = verifyOnlyStringLiteralsChanged(a, b);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/failed to parse/);
  });
});
