/**
 * Daemon API Client
 * HTTP bridge between the MCP server process and the ohwow daemon.
 * Reads session token from ~/.ohwow/data/daemon.token for auth.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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
   * Create a client by reading config and daemon token from disk.
   * Throws if token file is missing or daemon is not reachable.
   */
  static async create(): Promise<DaemonApiClient> {
    const configDir = join(homedir(), '.ohwow');
    const configPath = join(configDir, 'config.json');
    const tokenPath = join(configDir, 'data', 'daemon.token');

    // Read port from config
    let port = 7700;
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw);
        if (config.port) port = config.port;
      } catch {
        // Use default port
      }
    }

    // Read daemon token
    if (!existsSync(tokenPath)) {
      throw new Error(
        'OHWOW daemon is not running. Start it with: ohwow'
      );
    }

    const token = readFileSync(tokenPath, 'utf-8').trim();
    if (!token) {
      throw new Error(
        "Couldn't authenticate with OHWOW daemon. Try: ohwow restart"
      );
    }

    // Health check
    const client = new DaemonApiClient(port, token, tokenPath);
    try {
      await client.get('/health');
    } catch {
      throw new Error(
        'OHWOW daemon is not running. Start it with: ohwow'
      );
    }

    return client;
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
      throw new Error(`ohwow daemon error on GET ${path}: ${res.status}. Check daemon with: ohwow logs`);
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
      throw new Error(`ohwow daemon error on POST ${path}: ${res.status}. Check daemon with: ohwow logs`);
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
