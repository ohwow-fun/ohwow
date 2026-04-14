import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeFilesystemTool } from '../filesystem-executor.js';
import { FileAccessGuard } from '../filesystem-guard.js';
import { PermissionDeniedError } from '../permission-error.js';

describe('filesystem-executor permission denials', () => {
  let allowedDir: string;
  let deniedDir: string;
  let guard: FileAccessGuard;

  beforeAll(() => {
    allowedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-allowed-'));
    deniedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-denied-'));
    fs.writeFileSync(path.join(allowedDir, 'hello.txt'), 'hi');
    fs.writeFileSync(path.join(deniedDir, 'secret.txt'), 'nope');
    guard = new FileAccessGuard([allowedDir]);
  });

  afterAll(() => {
    fs.rmSync(allowedDir, { recursive: true, force: true });
    fs.rmSync(deniedDir, { recursive: true, force: true });
  });

  it('local_write_file throws PermissionDeniedError outside allowlist', async () => {
    const target = path.join(deniedDir, 'out.txt');
    await expect(
      executeFilesystemTool(guard, 'local_write_file', { path: target, content: 'x' }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('local_edit_file throws PermissionDeniedError outside allowlist', async () => {
    await expect(
      executeFilesystemTool(guard, 'local_edit_file', {
        path: path.join(deniedDir, 'secret.txt'),
        old_string: 'nope',
        new_string: 'yep',
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('local_read_file throws PermissionDeniedError outside allowlist', async () => {
    await expect(
      executeFilesystemTool(guard, 'local_read_file', { path: path.join(deniedDir, 'secret.txt') }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('local_list_directory throws PermissionDeniedError outside allowlist', async () => {
    await expect(
      executeFilesystemTool(guard, 'local_list_directory', { path: deniedDir }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('local_search_content throws when an explicit denied path is passed', async () => {
    await expect(
      executeFilesystemTool(guard, 'local_search_content', { query: 'nope', path: deniedDir }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('permission-denied error carries structured suggestedExact + suggestedParent', async () => {
    const target = path.join(deniedDir, 'deep', 'nested', 'new.txt');
    try {
      await executeFilesystemTool(guard, 'local_write_file', { path: target, content: 'x' });
      throw new Error('expected PermissionDeniedError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PermissionDeniedError);
      const details = (err as PermissionDeniedError).details;
      expect(details.toolName).toBe('local_write_file');
      expect(details.attemptedPath).toBe(target);
      expect(details.suggestedExact).toContain('new.txt');
      expect(details.suggestedParent).toBe(path.dirname(details.suggestedExact));
      expect(details.guardReason.length).toBeGreaterThan(0);
    }
  });

  it('allowed paths still succeed without throwing', async () => {
    const readResult = await executeFilesystemTool(guard, 'local_read_file', {
      path: path.join(allowedDir, 'hello.txt'),
    });
    expect(readResult.is_error).toBeFalsy();
    expect(readResult.content).toBe('hi');
  });

  it('non-denial errors still return is_error strings (do not throw)', async () => {
    // File missing in an allowed dir → returns an error result, does NOT throw.
    const result = await executeFilesystemTool(guard, 'local_read_file', {
      path: path.join(allowedDir, 'does-not-exist.txt'),
    });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Error');
  });
});
