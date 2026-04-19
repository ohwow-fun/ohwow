/**
 * WorkspaceRegistry
 *
 * Maintains the set of WorkspaceContext instances that are live within
 * this daemon process. The primary workspace is registered along with any
 * secondary workspaces discovered on boot.
 *
 * discoverWorkspaceNames() scans ~/.ohwow/workspaces/ for directories that
 * contain a daemon.token file — the presence of a token file is the
 * canonical signal that a workspace has been initialised.
 */

import { readdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { WorkspaceContext } from './workspace-context.js';

export function discoverWorkspaceNames(): string[] {
  const root = join(homedir(), '.ohwow', 'workspaces');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(root, d.name, 'daemon.token')))
    .map(d => d.name);
}

export class WorkspaceRegistry {
  private readonly contexts = new Map<string, WorkspaceContext>();

  register(ctx: WorkspaceContext): void {
    this.contexts.set(ctx.workspaceName, ctx);
  }

  get(workspaceName: string): WorkspaceContext {
    const ctx = this.contexts.get(workspaceName);
    if (!ctx) throw new Error(`Workspace '${workspaceName}' is not loaded`);
    return ctx;
  }

  getAll(): WorkspaceContext[] {
    return Array.from(this.contexts.values());
  }

  has(workspaceName: string): boolean {
    return this.contexts.has(workspaceName);
  }

  async unload(workspaceName: string): Promise<void> {
    const ctx = this.contexts.get(workspaceName);
    if (!ctx) return;
    ctx.scheduler?.stop?.();
    ctx.proactiveEngine?.stop?.();
    ctx.connectorSyncScheduler?.stop?.();
    ctx.rawDb?.close?.();
    this.contexts.delete(workspaceName);
  }

  async unloadAll(): Promise<void> {
    for (const name of [...this.contexts.keys()]) {
      await this.unload(name);
    }
  }
}
