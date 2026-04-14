/**
 * PermissionDeniedError — typed signal that a filesystem or bash tool call
 * was blocked by FileAccessGuard. Thrown from the guard call sites in
 * filesystem-executor and bash-executor so the ReAct loop unwinds cleanly
 * and RuntimeEngine.executeTask's outer catch can route the task to
 * needs_approval with a structured permission request instead of handing
 * the model an error string to hallucinate around.
 */

import path from 'node:path';
import fs from 'node:fs';
import { expandTilde } from './filesystem-guard.js';

export interface PermissionDeniedDetails {
  /** Name of the tool the agent tried to call (e.g. "local_write_file", "run_bash"). */
  toolName: string;
  /** The raw path the agent passed in. */
  attemptedPath: string;
  /** Resolved absolute path (realpath-walked for non-existent tails). */
  suggestedExact: string;
  /** Parent directory of the exact path — the "grant the whole folder" option. */
  suggestedParent: string;
  /** Human-readable reason from FileAccessGuard.isAllowed(). */
  guardReason: string;
}

export class PermissionDeniedError extends Error {
  readonly details: PermissionDeniedDetails;

  constructor(details: PermissionDeniedDetails) {
    super(`Permission denied: ${details.toolName} on ${details.attemptedPath} (${details.guardReason})`);
    this.name = 'PermissionDeniedError';
    this.details = details;
  }
}

/**
 * Resolve a raw path to its nearest absolute representation for
 * suggesting to the operator. Mirrors the walk-up-ancestors logic in
 * FileAccessGuard.isAllowed so the exact path we suggest matches the
 * path the guard was comparing against.
 */
export function resolveSuggestedPath(rawPath: string): string {
  const absolute = path.resolve(expandTilde(rawPath));
  try {
    return fs.realpathSync(absolute);
  } catch {
    const tail: string[] = [];
    let cursor = absolute;
    while (cursor !== path.dirname(cursor)) {
      tail.unshift(path.basename(cursor));
      cursor = path.dirname(cursor);
      try {
        return path.join(fs.realpathSync(cursor), ...tail);
      } catch { /* keep walking */ }
    }
    return absolute;
  }
}
