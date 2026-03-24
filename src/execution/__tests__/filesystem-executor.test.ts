import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeFilesystemTool, globMatch } from '../filesystem/filesystem-executor.js';
import { FileAccessGuard } from '../filesystem/filesystem-guard.js';
import { detectRipgrep, resetRipgrepCache } from '../filesystem/rg-backend.js';

// Force JS fallback for deterministic tests
vi.mock('../filesystem/rg-backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../filesystem/rg-backend.js')>();
  return {
    ...actual,
    detectRipgrep: vi.fn(() => null),
  };
});

describe('globMatch', () => {
  it('*.csv matches data.csv', () => {
    expect(globMatch('data.csv', '*.csv')).toBe(true);
  });

  it('*.csv does not match data.txt', () => {
    expect(globMatch('data.txt', '*.csv')).toBe(false);
  });

  it('**/*.json matches src/config.json', () => {
    expect(globMatch('src/config.json', '**/*.json')).toBe(true);
  });

  it('report* matches report_2024.pdf', () => {
    expect(globMatch('report_2024.pdf', 'report*')).toBe(true);
  });

  it('file(1).txt matches literally (regex special chars)', () => {
    expect(globMatch('file(1).txt', 'file(1).txt')).toBe(true);
  });

  it('file[2].txt matches literally', () => {
    expect(globMatch('file[2].txt', 'file[2].txt')).toBe(true);
  });

  it('pattern with + matches literally', () => {
    expect(globMatch('file+name.txt', 'file+name.txt')).toBe(true);
  });

  it('case insensitivity: *.CSV matches file.csv', () => {
    expect(globMatch('file.csv', '*.CSV')).toBe(true);
  });

  it('? matches single character', () => {
    expect(globMatch('a1.txt', 'a?.txt')).toBe(true);
    expect(globMatch('ab.txt', 'a?.txt')).toBe(true);
    expect(globMatch('abc.txt', 'a?.txt')).toBe(false);
  });
});

describe('executeSearchFiles', () => {
  let tmpDir: string;
  let guard: FileAccessGuard;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-search-test-'));
    guard = new FileAccessGuard([tmpDir]);

    // Create test file tree
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# Hello');
    fs.writeFileSync(path.join(tmpDir, 'data.csv'), 'a,b,c');
    fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'const x = 1;');
    fs.writeFileSync(path.join(tmpDir, 'app.js'), 'var x = 1;');

    const sub = path.join(tmpDir, 'src');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'index.ts'), 'export {}');
    fs.writeFileSync(path.join(sub, 'util.ts'), 'export const y = 2;');

    // Blocked directories
    const gitDir = path.join(tmpDir, '.git');
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, 'config'), 'gitconfig');

    const nm = path.join(tmpDir, 'node_modules');
    fs.mkdirSync(nm);
    fs.writeFileSync(path.join(nm, 'dep.js'), 'module');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds files matching glob pattern', async () => {
    const result = await executeFilesystemTool(guard, 'local_search_files', { pattern: '*.ts' });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain('app.ts');
    expect(result.content).toContain('index.ts');
  });

  it('respects type filter', async () => {
    const result = await executeFilesystemTool(guard, 'local_search_files', { pattern: '*', type: 'ts' });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain('.ts');
    expect(result.content).not.toContain('.js');
    expect(result.content).not.toContain('.csv');
  });

  it('skips blocked directories (.git, node_modules)', async () => {
    const result = await executeFilesystemTool(guard, 'local_search_files', { pattern: '*' });
    expect(result.is_error).toBeFalsy();
    expect(result.content).not.toContain('.git');
    expect(result.content).not.toContain('node_modules');
  });

  it('returns friendly message when no matches', async () => {
    const result = await executeFilesystemTool(guard, 'local_search_files', { pattern: '*.xyz' });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain('No files matching');
  });
});

describe('executeSearchContent', () => {
  let tmpDir: string;
  let guard: FileAccessGuard;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-content-test-'));
    guard = new FileAccessGuard([tmpDir]);

    fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'Hello World\nfoo bar\nHello Again\n');
    fs.writeFileSync(path.join(tmpDir, 'code.ts'), 'const hello = "hi";\nfunction greet() { return hello; }\n');
    fs.writeFileSync(path.join(tmpDir, 'data.csv'), 'name,value\nalpha,1\nbeta,2\n');

    const sub = path.join(tmpDir, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'deep.txt'), 'needle in haystack\n');

    // Binary file
    const binBuf = Buffer.alloc(100);
    binBuf[10] = 0; // null byte makes it binary
    binBuf.write('Hello binary', 20);
    fs.writeFileSync(path.join(tmpDir, 'binary.dat'), binBuf);

    // Blocked dir
    const gitDir = path.join(tmpDir, '.git');
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'Hello from git');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds literal text matches with line numbers', async () => {
    const result = await executeFilesystemTool(guard, 'local_search_content', { query: 'Hello' });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain(':1:');
    expect(result.content).toContain('Hello World');
    expect(result.content).toContain('Hello Again');
  });

  it('regex mode works', async () => {
    const result = await executeFilesystemTool(guard, 'local_search_content', {
      query: 'Hello.*World',
      regex: true,
    });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain('Hello World');
    expect(result.content).not.toContain('Hello Again');
  });

  it('case_sensitive: true respects exact case', async () => {
    const result = await executeFilesystemTool(guard, 'local_search_content', {
      query: 'hello',
      case_sensitive: true,
    });
    expect(result.is_error).toBeFalsy();
    // Should match "const hello" in code.ts, not "Hello" in hello.txt
    expect(result.content).toContain('code.ts');
    expect(result.content).not.toContain('Hello World');
  });

  it('output_mode: "files" returns file paths only', async () => {
    const result = await executeFilesystemTool(guard, 'local_search_content', {
      query: 'Hello',
      output_mode: 'files',
    });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain('hello.txt');
    // Should not contain line numbers
    expect(result.content).not.toMatch(/:\d+:/);
  });

  it('output_mode: "count" returns counts per file', async () => {
    const result = await executeFilesystemTool(guard, 'local_search_content', {
      query: 'Hello',
      output_mode: 'count',
    });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain('hello.txt:2');
  });

  it('context lines work correctly', async () => {
    const result = await executeFilesystemTool(guard, 'local_search_content', {
      query: 'foo bar',
      context: 1,
    });
    expect(result.is_error).toBeFalsy();
    // Should include the line before and after "foo bar"
    expect(result.content).toContain('Hello World');
    expect(result.content).toContain('foo bar');
    expect(result.content).toContain('Hello Again');
  });

  it('type filter scopes to file extensions', async () => {
    const result = await executeFilesystemTool(guard, 'local_search_content', {
      query: 'hello',
      type: 'ts',
    });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain('code.ts');
    expect(result.content).not.toContain('hello.txt');
  });

  it('skips binary files', async () => {
    const result = await executeFilesystemTool(guard, 'local_search_content', {
      query: 'Hello binary',
    });
    expect(result.is_error).toBeFalsy();
    expect(result.content).not.toContain('binary.dat');
  });

  it('skips blocked directories', async () => {
    const result = await executeFilesystemTool(guard, 'local_search_content', {
      query: 'Hello from git',
    });
    expect(result.is_error).toBeFalsy();
    // Should not find the match inside .git/
    expect(result.content).not.toContain('.git');
  });

  it('returns friendly message when no matches', async () => {
    const result = await executeFilesystemTool(guard, 'local_search_content', {
      query: 'zzzznonexistent',
    });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain('No matches');
  });
});

describe('rg detection cache', () => {
  it('detectRipgrep returns cached result (mocked to null)', () => {
    // Our mock forces null
    expect(detectRipgrep()).toBeNull();
  });

  it('resetRipgrepCache clears the cache', () => {
    // Should not throw
    resetRipgrepCache();
    // After reset, detectRipgrep still returns our mock value
    expect(detectRipgrep()).toBeNull();
  });
});
