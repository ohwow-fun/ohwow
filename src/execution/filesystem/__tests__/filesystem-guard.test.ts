import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { FileAccessGuard, expandTilde } from '../filesystem-guard.js';

describe('expandTilde', () => {
  it('resolves ~ to home directory', () => {
    expect(expandTilde('~')).toBe(os.homedir());
  });

  it('resolves ~/path to home directory + path', () => {
    expect(expandTilde('~/Documents')).toBe(os.homedir() + '/Documents');
  });

  it('returns non-tilde paths unchanged', () => {
    expect(expandTilde('/usr/local')).toBe('/usr/local');
  });
});

describe('FileAccessGuard', () => {
  // Use a temp directory that definitely exists for testing
  const tmpDir = fs.realpathSync(os.tmpdir());
  const guard = new FileAccessGuard([tmpDir]);

  it('allows paths within allowed directories', () => {
    const result = guard.isAllowed(path.join(tmpDir, 'somefile.txt'));
    expect(result.allowed).toBe(true);
  });

  it('rejects paths outside allowed directories', () => {
    const result = guard.isAllowed('/etc/passwd');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('outside the allowed directories');
  });

  it('blocks .ssh directory', () => {
    const result = guard.isAllowed(path.join(tmpDir, '.ssh', 'id_rsa'));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.ssh');
  });

  it('blocks .gnupg directory', () => {
    const result = guard.isAllowed(path.join(tmpDir, '.gnupg', 'keys'));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.gnupg');
  });

  it('blocks .aws directory', () => {
    const result = guard.isAllowed(path.join(tmpDir, '.aws', 'credentials'));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.aws');
  });

  it('blocks .env files', () => {
    const result = guard.isAllowed(path.join(tmpDir, '.env'));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.env');
  });

  it('blocks .env.local and .env.production', () => {
    expect(guard.isAllowed(path.join(tmpDir, '.env.local')).allowed).toBe(false);
    expect(guard.isAllowed(path.join(tmpDir, '.env.production')).allowed).toBe(false);
  });

  it('blocks .pem and .key extensions', () => {
    expect(guard.isAllowed(path.join(tmpDir, 'cert.pem')).allowed).toBe(false);
    expect(guard.isAllowed(path.join(tmpDir, 'private.key')).allowed).toBe(false);
  });

  it('blocks id_rsa filename', () => {
    const result = guard.isAllowed(path.join(tmpDir, 'id_rsa'));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('id_rsa');
  });

  it('returns denial reason string', () => {
    const result = guard.isAllowed('/nonexistent/path');
    expect(result.allowed).toBe(false);
    expect(typeof result.reason).toBe('string');
    expect(result.reason!.length).toBeGreaterThan(0);
  });

  it('reports no allowed directories when constructed with empty array', () => {
    const emptyGuard = new FileAccessGuard([]);
    const result = emptyGuard.isAllowed('/any/path');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No directories');
  });
});
