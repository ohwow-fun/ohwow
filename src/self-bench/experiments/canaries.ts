/**
 * Direct-dispatch canaries used by CanaryExperiment.
 *
 * Each canary is a tiny deterministic probe: it invokes a tool
 * executor directly (bypassing the ReAct loop, LLM calls, and
 * provider network) and compares the result to a known-good
 * expected output. This tests the tool substrate — bash, filesystem,
 * and FileAccessGuard enforcement — without dependence on model
 * tool-calling behavior or vendor uptime.
 *
 * Direct dispatch is deliberate for Phase 2. End-to-end canaries
 * that drive a real agent loop will land in Phase 3 when paired
 * with intervention validation; those are slower and can fail for
 * reasons unrelated to the tool substrate.
 *
 * Each canary returns CanaryOutcome — the experiment aggregates the
 * whole suite into one Finding row per tick.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { executeBashTool } from '../../execution/bash/bash-executor.js';
import { executeFilesystemTool } from '../../execution/filesystem/filesystem-executor.js';
import { FileAccessGuard } from '../../execution/filesystem/filesystem-guard.js';
import { PermissionDeniedError } from '../../execution/filesystem/permission-error.js';

export interface CanaryOutcome {
  id: string;
  description: string;
  passed: boolean;
  reason?: string;
  latencyMs: number;
}

async function measured(id: string, description: string, fn: () => Promise<void>): Promise<CanaryOutcome> {
  const start = Date.now();
  try {
    await fn();
    return { id, description, passed: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      id,
      description,
      passed: false,
      reason: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
    };
  }
}

/**
 * Canary 1: executeBashTool round-trips stdout for a trivial echo.
 * Catches: bash executor broken, env scrubbing bug, spawn regression.
 */
export async function canary_bash_echo(): Promise<CanaryOutcome> {
  return measured('bash_echo', 'executeBashTool echoes "ping" back via stdout', async () => {
    const guard = new FileAccessGuard([os.tmpdir()]);
    const result = await executeBashTool(guard, 'run_bash', {
      command: 'echo ping',
      working_directory: os.tmpdir(),
    });
    if (result.is_error) throw new Error(`bash exited with error: ${result.content.slice(0, 120)}`);
    if (!result.content.includes('ping')) {
      throw new Error(`stdout did not contain "ping": ${result.content.slice(0, 120)}`);
    }
  });
}

/**
 * Canary 2: local_write_file → local_read_file round-trips an exact payload.
 * Catches: filesystem executor broken, path resolution regression,
 * binary detection false-positive, guard allowing but executor rejecting.
 */
export async function canary_fs_write_read(): Promise<CanaryOutcome> {
  return measured('fs_write_read', 'local_write_file writes a payload, local_read_file reads it back verbatim', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-wr-'));
    const guard = new FileAccessGuard([dir]);
    const filePath = path.join(dir, `${crypto.randomUUID()}.txt`);
    const payload = `canary-${Date.now()}`;
    try {
      const writeRes = await executeFilesystemTool(guard, 'local_write_file', { path: filePath, content: payload });
      if (writeRes.is_error) throw new Error(`write failed: ${writeRes.content}`);
      const readRes = await executeFilesystemTool(guard, 'local_read_file', { path: filePath });
      if (readRes.is_error) throw new Error(`read failed: ${readRes.content}`);
      if (readRes.content !== payload) {
        throw new Error(`read content mismatch: expected "${payload}", got "${readRes.content.slice(0, 120)}"`);
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
}

/**
 * Canary 3: local_list_directory returns non-empty for a known directory.
 * Catches: listing broken, entry serialization regression, empty-result
 * false-negative on populated dirs.
 */
export async function canary_fs_list_directory(): Promise<CanaryOutcome> {
  return measured('fs_list_directory', 'local_list_directory returns at least one entry for a populated tmp dir', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-ls-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
      fs.writeFileSync(path.join(dir, 'b.txt'), 'y');
      const guard = new FileAccessGuard([dir]);
      const result = await executeFilesystemTool(guard, 'local_list_directory', { path: dir });
      if (result.is_error) throw new Error(`list failed: ${result.content}`);
      if (!result.content.includes('a.txt') || !result.content.includes('b.txt')) {
        throw new Error(`listing did not contain both entries: ${result.content.slice(0, 200)}`);
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
}

/**
 * Canary 4: FileAccessGuard denies a path outside the allowlist by
 * throwing PermissionDeniedError. The throw is load-bearing for the
 * permission-request flow from commit 5215ae2 — if this canary fails,
 * the entire needs_approval queue is silently broken.
 */
export async function canary_fs_guard_denies_out_of_bounds(): Promise<CanaryOutcome> {
  return measured('fs_guard_denies_out_of_bounds', 'filesystem guard throws PermissionDeniedError on out-of-bounds write', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-guard-'));
    try {
      const narrowGuard = new FileAccessGuard([tmp]);
      // Write target outside the allowlist — use a sibling tmpdir path
      // that definitely isn't inside `tmp`. We don't actually create
      // this file; we expect the guard to throw before any filesystem
      // touch happens.
      const outOfBounds = path.join(os.tmpdir(), `canary-out-${crypto.randomUUID()}.txt`);
      try {
        await executeFilesystemTool(narrowGuard, 'local_write_file', {
          path: outOfBounds,
          content: 'should not be written',
        });
        throw new Error('PermissionDeniedError was not thrown for out-of-bounds write');
      } catch (err) {
        if (err instanceof PermissionDeniedError) return; // expected
        throw err;
      }
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
}

/**
 * Canary 5: executeBashTool guard denies an out-of-bounds working_directory.
 * Mirrors canary_4 on the bash path. If this regresses, agents with
 * narrow bash access can escape their jail.
 */
export async function canary_bash_guard_denies_cwd(): Promise<CanaryOutcome> {
  return measured('bash_guard_denies_cwd', 'bash guard throws PermissionDeniedError on out-of-bounds working_directory', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-bash-guard-'));
    try {
      const narrowGuard = new FileAccessGuard([tmp]);
      try {
        await executeBashTool(narrowGuard, 'run_bash', {
          command: 'echo escaped',
          working_directory: '/etc',
        });
        throw new Error('PermissionDeniedError was not thrown for out-of-bounds working_directory');
      } catch (err) {
        if (err instanceof PermissionDeniedError) return; // expected
        throw err;
      }
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
}

/**
 * The canonical canary suite. Adding or removing entries here changes
 * the shape of the CanaryExperiment's evidence payload, so keep the
 * ids stable across releases — operators filter on them.
 */
export const CANARY_SUITE = [
  canary_bash_echo,
  canary_fs_write_read,
  canary_fs_list_directory,
  canary_fs_guard_denies_out_of_bounds,
  canary_bash_guard_denies_cwd,
] as const;
