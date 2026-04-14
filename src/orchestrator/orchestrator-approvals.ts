/**
 * PermissionBroker — owns the three pending-request maps the orchestrator
 * uses to pause tool execution until a user decision arrives from outside
 * the runtime (API route, TUI prompt, future MCP elicitation event).
 *
 * Extracted so LocalOrchestrator doesn't have to house the maps, the
 * wait/resolve pairs, and the agent_file_access_paths DB insert all
 * inline. The orchestrator keeps thin `resolvePermission` /
 * `resolveCostApproval` / `resolveElicitation` delegations so existing
 * API routes and event handlers don't need to know about the broker.
 */

import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { invalidateFileAccessCache } from './tools/filesystem.js';
import { logger } from '../lib/logger.js';

type PermissionResolver = (granted: boolean) => void;
type CostApprovalResolver = (approved: boolean) => void;
type ElicitationResolver = (response: Record<string, unknown> | null) => void;

const DEFAULT_ELICITATION_TIMEOUT_MS = 30_000;

/**
 * Safety cap on permission gates. If no UI/API resolves the request within
 * this window, auto-deny and let the model self-correct on the next
 * iteration. Without this cap, async-dispatched chats (MCP, /api/chat?async=1,
 * webhooks) deadlock forever because there's no interactive consumer to
 * resolve the promise. Override via OHWOW_PERMISSION_TIMEOUT_MS for tests.
 * Bug #8.
 */
const DEFAULT_PERMISSION_TIMEOUT_MS = (() => {
  const fromEnv = parseInt(process.env.OHWOW_PERMISSION_TIMEOUT_MS || '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 60_000;
})();

export class PermissionBroker {
  private pendingPermissions = new Map<string, PermissionResolver>();
  private pendingCostApprovals = new Map<string, CostApprovalResolver>();
  private pendingElicitations = new Map<string, ElicitationResolver>();

  constructor(
    private readonly db: DatabaseAdapter,
    private readonly workspaceId: string,
  ) {}

  // -- Permission gates (filesystem, browser, desktop activations etc.) --

  /**
   * Wait for a caller to resolve permission for `requestId`. Falls back to
   * auto-deny after `timeoutMs` (default 60s) so async-dispatched chats
   * can't deadlock when no interactive UI is listening. Bug #8.
   */
  waitForPermission(
    requestId: string,
    timeoutMs: number = DEFAULT_PERMISSION_TIMEOUT_MS,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pendingPermissions.set(requestId, resolve);
      setTimeout(() => {
        if (this.pendingPermissions.has(requestId)) {
          this.pendingPermissions.delete(requestId);
          logger.warn({ requestId, timeoutMs }, '[permission-broker] permission request timed out, auto-deny');
          resolve(false);
        }
      }, timeoutMs);
    });
  }

  resolvePermission(requestId: string, granted: boolean): void {
    const resolve = this.pendingPermissions.get(requestId);
    if (resolve) {
      this.pendingPermissions.delete(requestId);
      resolve(granted);
    }
  }

  // -- Cost approval gates (cloud media tools, etc.) --

  /**
   * Wait for a caller to resolve cost approval for `requestId`. Same
   * auto-deny safety cap as waitForPermission so async-dispatched chats
   * can't deadlock on an approve-me prompt nobody sees. Bug #8.
   */
  waitForCostApproval(
    requestId: string,
    timeoutMs: number = DEFAULT_PERMISSION_TIMEOUT_MS,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pendingCostApprovals.set(requestId, resolve);
      setTimeout(() => {
        if (this.pendingCostApprovals.has(requestId)) {
          this.pendingCostApprovals.delete(requestId);
          logger.warn({ requestId, timeoutMs }, '[permission-broker] cost approval timed out, auto-deny');
          resolve(false);
        }
      }, timeoutMs);
    });
  }

  resolveCostApproval(requestId: string, approved: boolean): void {
    const resolve = this.pendingCostApprovals.get(requestId);
    if (resolve) {
      this.pendingCostApprovals.delete(requestId);
      resolve(approved);
    }
  }

  // -- MCP elicitation gates --

  /**
   * Start a pending MCP elicitation request and return a promise that
   * resolves when the user replies (via `resolveElicitation`) or when the
   * timeout expires (auto-null). Generates the requestId internally — the
   * event stream plumbing that exposes it to the UI is still TODO.
   */
  awaitElicitation(timeoutMs = DEFAULT_ELICITATION_TIMEOUT_MS): Promise<Record<string, unknown> | null> {
    const requestId = crypto.randomUUID();
    return new Promise<Record<string, unknown> | null>((resolve) => {
      this.pendingElicitations.set(requestId, resolve);
      setTimeout(() => {
        if (this.pendingElicitations.has(requestId)) {
          this.pendingElicitations.delete(requestId);
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  resolveElicitation(requestId: string, response: Record<string, unknown> | null): void {
    const resolve = this.pendingElicitations.get(requestId);
    if (resolve) {
      this.pendingElicitations.delete(requestId);
      resolve(response);
    }
  }

  // -- File access persistence --

  /**
   * Persist a granted filesystem path to agent_file_access_paths and
   * invalidate the in-memory cache so the next tool call sees the new
   * allowlist immediately.
   */
  async addAllowedPath(allowedPath: string): Promise<void> {
    await this.db.from('agent_file_access_paths').insert({
      id: crypto.randomUUID(),
      workspace_id: this.workspaceId,
      agent_id: '__orchestrator__',
      path: allowedPath,
    });
    invalidateFileAccessCache();
  }
}
