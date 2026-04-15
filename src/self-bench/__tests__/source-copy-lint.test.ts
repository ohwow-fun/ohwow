import { describe, it, expect } from 'vitest';
import { extractLiterals, scanFile } from '../experiments/source-copy-lint.js';

describe('extractLiterals', () => {
  it('captures double-quoted, single-quoted, template, and JSX text', () => {
    const src = [
      `const a = "hello double";`,
      `const b = 'hello single';`,
      'const c = `hello ${name} template`;',
      'const jsx = <div>Visible JSX text</div>;',
    ].join('\n');
    const lits = extractLiterals(src);
    const kinds = lits.map((l) => l.kind).sort();
    expect(kinds).toContain('string-literal');
    expect(kinds).toContain('template-literal');
    expect(kinds).toContain('jsx-text');
    const values = lits.map((l) => l.value.trim());
    expect(values).toContain('hello double');
    expect(values).toContain('hello single');
    expect(values.some((v) => v.includes('hello '))).toBe(true);
    expect(values).toContain('Visible JSX text');
  });

  it('skips comments so "// Failed to X" does not register as a literal', () => {
    const src = `// Failed to parse\n/* please try */\nconst x = 1;`;
    const lits = extractLiterals(src);
    expect(lits).toEqual([]);
  });

  it('skips ${...} expressions inside templates', () => {
    const src = 'const x = `Hello ${user.name}! Failed to X`;';
    const lits = extractLiterals(src);
    const tpl = lits.find((l) => l.kind === 'template-literal');
    expect(tpl?.value).toContain('Failed to X');
    expect(tpl?.value).not.toContain('user.name');
  });
});

describe('scanFile', () => {
  it('attributes a "Failed to" violation to the right line and column', () => {
    const src = `
const err = "Failed to load thing";
`.trimStart();
    const vs = scanFile('src/web/src/pages/X.tsx', src);
    expect(vs).toHaveLength(1);
    expect(vs[0].ruleId).toBe('no-failed-to');
    expect(vs[0].file).toBe('src/web/src/pages/X.tsx');
    expect(vs[0].line).toBe(1);
    expect(vs[0].kind).toBe('string-literal');
  });

  it('does not flag phrases that only appear in comments', () => {
    const src = [
      '// Failed to parse this — but we recovered',
      'const x = "Couldn\'t reach server";',
    ].join('\n');
    const vs = scanFile('src/web/src/pages/Y.tsx', src);
    expect(vs).toEqual([]);
  });

  it('flags an em dash inside JSX text', () => {
    const src = '<div>Agents — Content & Growth</div>';
    const vs = scanFile('x.tsx', src);
    expect(vs.some((v) => v.ruleId === 'no-em-dash' && v.kind === 'jsx-text')).toBe(true);
  });
});
