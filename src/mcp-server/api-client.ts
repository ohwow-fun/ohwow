/**
 * Daemon API Client
 * HTTP bridge between the MCP server process and the ohwow daemon.
 *
 * Resolves the FOCUSED workspace (via the same resolver the CLI uses) and
 * connects to that workspace's daemon. Under the parallel-daemon model,
 * multiple daemons can be running simultaneously on different ports — the
 * MCP follows whichever workspace ~/.ohwow/current-workspace points at.
 * To talk to a different workspace, switch focus with `ohwow workspace use
 * <name>` and re-launch the MCP (or restart Claude Code).
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  resolveActiveWorkspace,
  portForWorkspace,
  workspaceLayoutFor,
  writeWorkspacePointer,
  isValidWorkspaceName,
  DEFAULT_PORT,
  LEGACY_DATA_DIR,
} from '../config.js';

export class DaemonApiClient {
  private baseUrl: string;
  private token: string;
  private tokenPath: string;

  constructor(port: number, token: string, tokenPath: string) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.token = token;
    this.tokenPath = tokenPath;
  }

  /**
   * Create a client by resolving the focused workspace and reading its
   * daemon token. Throws if the daemon for that workspace isn't running.
   */
  static async create(): Promise<DaemonApiClient> {
    const active = resolveActiveWorkspace();
    const port = portForWorkspace(active.name) ?? DEFAULT_PORT;
    let tokenPath = join(active.dataDir, 'daemon.token');

    // Backward compat: pre-migration installs may still have the token at
    // the legacy ~/.ohwow/data/daemon.token path. Fall through to it if the
    // workspace dir doesn't have one yet (and the legacy one does).
    if (!existsSync(tokenPath)) {
      const legacyToken = join(LEGACY_DATA_DIR, 'daemon.token');
      if (existsSync(legacyToken)) {
        tokenPath = legacyToken;
      } else {
        throw new Error(
          `OHWOW process is not running for workspace "${active.name}". ` +
            `Start it with: ohwow workspace start ${active.name}`,
        );
      }
    }

    const token = readFileSync(tokenPath, 'utf-8').trim();
    if (!token) {
      throw new Error(
        `Couldn't read process token for workspace "${active.name}". Try: ohwow workspace restart ${active.name}`,
      );
    }

    // Health check against the resolved port.
    const client = new DaemonApiClient(port, token, tokenPath);
    try {
      await client.get('/health');
    } catch {
      throw new Error(
        `OHWOW process for workspace "${active.name}" is not reachable on port ${port}. ` +
          `Start it with: ohwow workspace start ${active.name}`,
      );
    }

    return client;
  }

  /**
   * Repoint this client at a different workspace's daemon. Used by the
   * `ohwow_workspace_use` MCP tool so callers can switch the MCP session's
   * target without restarting Claude Code. Health-checks the new daemon
   * before swapping internal state — if the target is down, the client
   * stays attached to its current workspace and the caller gets a clear
   * error.
   *
   * Side effects: also updates ~/.ohwow/current-workspace so future TUI
   * launches and new MCP sessions default to this workspace.
   */
  async switchTo(workspaceName: string): Promise<{ port: number; workspaceName: string }> {
    if (!isValidWorkspaceName(workspaceName)) {
      throw new Error(`Invalid workspace name: ${workspaceName}`);
    }

    const layout = workspaceLayoutFor(workspaceName);
    const port = portForWorkspace(workspaceName);
    if (port === null) {
      throw new Error(
        `Workspace "${workspaceName}" has no port assigned yet. Start it once with: ohwow workspace start ${workspaceName}`,
      );
    }

    const newTokenPath = join(layout.dataDir, 'daemon.token');
    if (!existsSync(newTokenPath)) {
      throw new Error(
        `Daemon for workspace "${workspaceName}" is not running. Start it with: ohwow workspace start ${workspaceName}`,
      );
    }

    const newToken = readFileSync(newTokenPath, 'utf-8').trim();
    if (!newToken) {
      throw new Error(`Empty process token for workspace "${workspaceName}"`);
    }

    const newBaseUrl = `http://127.0.0.1:${port}`;

    // Health check the candidate BEFORE swapping so a failed switch leaves
    // the client attached to the previous workspace cleanly.
    try {
      const res = await fetch(`${newBaseUrl}/health`, {
        headers: { Authorization: `Bearer ${newToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      throw new Error(
        `Daemon for "${workspaceName}" not responding on port ${port}: ${err instanceof Error ? err.message : err}`,
      );
    }

    // Swap atomically (simple field assignment, all on one tick)
    this.baseUrl = newBaseUrl;
    this.token = newToken;
    this.tokenPath = newTokenPath;

    // Persist the focus shift for future sessions/launches.
    writeWorkspacePointer(workspaceName);

    // Also set OHWOW_WORKSPACE in this MCP process's env so any child
    // daemon spawned by daemon-tools (start/restart) explicitly inherits
    // the new workspace instead of relying solely on the pointer file.
    process.env.OHWOW_WORKSPACE = workspaceName;

    return { port, workspaceName };
  }

  /**
   * Re-read the token from disk. Returns true if the token changed.
   */
  private refreshToken(): boolean {
    try {
      const fresh = readFileSync(this.tokenPath, 'utf-8').trim();
      if (fresh && fresh !== this.token) {
        this.token = fresh;
        return true;
      }
    } catch {
      // Token file missing or unreadable
    }
    return false;
  }

  private authHeaders(): Record<string, string> {
    return { 'Authorization': `Bearer ${this.token}` };
  }

  /**
   * Fetch with automatic retry on 401 (stale token after daemon restart).
   */
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let res = await fetch(url, init);
    if (res.status === 401 && this.refreshToken()) {
      const headers = { ...(init.headers as Record<string, string>), ...this.authHeaders() };
      res = await fetch(url, { ...init, headers });
    }
    return res;
  }

  async get(path: string): Promise<unknown> {
    const res = await this.fetchWithRetry(`${this.baseUrl}${path}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(`ohwow process error on GET ${path}: ${res.status}. Check with: ohwow logs`);
    }
    return res.json();
  }

  async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchWithRetry(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`ohwow process error on POST ${path}: ${res.status}. Check with: ohwow logs`);
    }
    return res.json();
  }

  async del(path: string): Promise<unknown> {
    const res = await this.fetchWithRetry(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(`ohwow process error on DELETE ${path}: ${res.status}. Check with: ohwow logs`);
    }
    return res.json();
  }

  async patch(path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchWithRetry(`${this.baseUrl}${path}`, {
      method: 'PATCH',
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`ohwow process error on PATCH ${path}: ${res.status}. Check with: ohwow logs`);
    }
    return res.json();
  }

  /**
   * POST to an SSE endpoint, consume the stream, and return assembled text.
   * Used for /api/chat which streams orchestrator events.
   */
  async postSSE(path: string, body: Record<string, unknown>, timeoutMs = 120_000): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const textParts: string[] = [];

    const doRequest = async (): Promise<Response> => {
      return fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    };

    try {
      let res = await doRequest();

      // Retry once on 401 with refreshed token
      if (res.status === 401 && this.refreshToken()) {
        res = await doRequest();
      }

      if (!res.ok) {
        throw new Error(`Daemon API error: ${res.status} ${res.statusText}`);
      }

      if (!res.body) {
        throw new Error('No response body from daemon');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data);
            if (event.type === 'text' && event.content) {
              textParts.push(event.content);
            } else if (event.type === 'tool_start') {
              textParts.push(`\n[Using tool: ${event.name}]\n`);
            } else if (event.type === 'error') {
              textParts.push(`\n[Error: ${event.error}]\n`);
            } else if (event.type === 'done') {
              break;
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }

      return textParts.join('');
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return textParts.join('') + `\n[Timed out after ${timeoutMs / 1000}s. The task may still be running. Check with ohwow_list_tasks.]`;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
