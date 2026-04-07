/**
 * JSON-RPC over stdio transport for LSP servers.
 * Handles Content-Length framing, request/response matching, and notifications.
 */

import { spawn, type ChildProcess } from 'child_process';
import { logger } from '../lib/logger.js';

const REQUEST_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LspTransport {
  private process: ChildProcess | null = null;
  private pendingRequests = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private onNotification?: (method: string, params: unknown) => void;
  private _alive = false;

  constructor(
    private command: string,
    private args: string[],
    private cwd: string,
  ) {}

  get alive(): boolean {
    return this._alive;
  }

  /** Start the language server process. */
  start(onNotification?: (method: string, params: unknown) => void): void {
    this.onNotification = onNotification;
    this.process = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this._alive = true;

    this.process.stdout!.on('data', (chunk: Buffer) => this.handleData(chunk));
    this.process.stderr!.on('data', (chunk: Buffer) => {
      logger.debug({ stderr: chunk.toString().slice(0, 200) }, '[LSP] Server stderr');
    });
    this.process.on('exit', (code) => {
      this._alive = false;
      logger.info({ code, command: this.command }, '[LSP] Server exited');
      // Reject all pending requests
      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`LSP server exited with code ${code}`));
      }
      this.pendingRequests.clear();
    });
    this.process.on('error', (err) => {
      this._alive = false;
      logger.error({ err, command: this.command }, '[LSP] Server error');
    });
  }

  /** Send a JSON-RPC request and wait for the response. */
  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.process || !this._alive) {
      throw new Error('LSP transport is not running');
    }

    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const frame = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP request "${method}" timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.process!.stdin!.write(frame);
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params: unknown): void {
    if (!this.process || !this._alive) return;
    const message = JSON.stringify({ jsonrpc: '2.0', method, params });
    const frame = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
    this.process.stdin!.write(frame);
  }

  /** Kill the server process. */
  async destroy(): Promise<void> {
    if (!this.process) return;
    this._alive = false;

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('LSP transport destroyed'));
    }
    this.pendingRequests.clear();

    this.process.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.process?.kill('SIGKILL');
        resolve();
      }, 3000);
      this.process!.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.process = null;
  }

  /** Parse Content-Length framed messages from the server's stdout. */
  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      // Find header/body separator
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      // Parse Content-Length
      const headerStr = this.buffer.subarray(0, headerEnd).toString();
      const match = headerStr.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Skip malformed header
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (this.buffer.length < messageEnd) break; // Not enough data yet

      const body = this.buffer.subarray(messageStart, messageEnd).toString();
      this.buffer = this.buffer.subarray(messageEnd);

      try {
        const msg = JSON.parse(body) as {
          id?: number;
          method?: string;
          result?: unknown;
          error?: { code: number; message: string };
          params?: unknown;
        };

        if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
          // Response to a request
          const pending = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          clearTimeout(pending.timer);

          if (msg.error) {
            pending.reject(new Error(`LSP error ${msg.error.code}: ${msg.error.message}`));
          } else {
            pending.resolve(msg.result);
          }
        } else if (msg.method && !msg.id) {
          // Server notification
          this.onNotification?.(msg.method, msg.params);
        }
      } catch {
        logger.debug('[LSP] Failed to parse message body');
      }
    }
  }
}
