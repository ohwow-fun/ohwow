/**
 * Singleton LSP manager: lazy-start language servers, cache per language, graceful shutdown.
 * Follows the ScraplingService sidecar pattern with promise latching.
 */

import { logger } from '../lib/logger.js';
import { LspClient } from './lsp-client.js';
import { detectLanguage, LSP_SERVER_SPECS } from './lsp-types.js';
import type { LspLanguage } from './lsp-types.js';
import { ensureLspServer } from './lsp-installer.js';

export class LspManager {
  private clients = new Map<LspLanguage, LspClient>();
  private startPromises = new Map<LspLanguage, Promise<LspClient | null>>();

  constructor(private rootPath: string) {}

  /**
   * Get or create an LSP client for the given file's language.
   * Auto-detects language from file extension and lazy-starts the server.
   * Returns null if the language is unsupported or the server can't be started.
   */
  async getClient(filePath: string): Promise<LspClient | null> {
    const language = detectLanguage(filePath);
    if (!language) return null;

    // Return existing healthy client
    const existing = this.clients.get(language);
    if (existing?.alive) return existing;

    // Clean up dead client (but don't clear startPromises — a concurrent start may be in progress)
    if (existing && !existing.alive) {
      this.clients.delete(language);
    }

    // Promise latch: prevent concurrent starts of the same server.
    // The promise stays in the map until it resolves/rejects, so all concurrent
    // callers share the same startup attempt. No eager deletion.
    const pendingStart = this.startPromises.get(language);
    if (pendingStart) return pendingStart;

    const startPromise = this.startClient(language).finally(() => {
      // Clean up the latch only after all awaiters have been notified
      this.startPromises.delete(language);
    });
    this.startPromises.set(language, startPromise);

    return startPromise;
  }

  private async startClient(language: LspLanguage): Promise<LspClient | null> {
    const available = await ensureLspServer(language);
    if (!available) {
      const spec = LSP_SERVER_SPECS[language];
      logger.warn({ language, hint: spec.installHint }, '[LSP] Server not available');
      return null;
    }

    const spec = LSP_SERVER_SPECS[language];
    const client = new LspClient(spec, this.rootPath);

    try {
      await client.start();
      this.clients.set(language, client);
      return client;
    } catch (err) {
      logger.error({ language, err }, '[LSP] Failed to start server');
      await client.stop().catch(() => {});
      return null;
    }
  }

  /** Stop all running language servers. Called on daemon shutdown. */
  async stopAll(): Promise<void> {
    const stops = [...this.clients.values()].map(client =>
      client.stop().catch(err =>
        logger.warn({ err }, '[LSP] Error stopping server'),
      ),
    );
    await Promise.all(stops);
    this.clients.clear();
    this.startPromises.clear();
  }

  /** Update the root path (e.g., when working directory changes). */
  async setRootPath(rootPath: string): Promise<void> {
    if (rootPath !== this.rootPath) {
      this.rootPath = rootPath;
      await this.stopAll();
    }
  }
}
