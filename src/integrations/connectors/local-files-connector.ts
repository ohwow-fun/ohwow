/**
 * Local Files Data Source Connector
 * Reads documents from a local directory, with optional pattern filtering.
 */

import type { DataSourceConnector, ConnectorDocument, ConnectorConfig } from '../connector-types.js';
import { readFile, stat, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../../lib/logger.js';

export class LocalFilesConnector implements DataSourceConnector {
  readonly type = 'local-files' as const;
  readonly name: string;
  private dirPath: string;
  private patterns: string[];
  private recursive: boolean;

  constructor(config: ConnectorConfig) {
    this.name = config.name;
    const settings = config.settings as { path: string; patterns?: string[]; recursive?: boolean };
    this.dirPath = settings.path;
    this.patterns = settings.patterns || ['*.md', '*.txt'];
    this.recursive = settings.recursive !== false;
  }

  private matchesPattern(filename: string): boolean {
    const ext = extname(filename).toLowerCase();
    return this.patterns.some((pattern) => {
      // Extension glob: "*.md" matches any file with .md extension
      if (pattern.startsWith('*.')) {
        return ext === pattern.slice(1).toLowerCase();
      }
      // Exact filename match
      return filename === pattern;
    });
  }

  private makeId(relativePath: string): string {
    return createHash('sha256').update(relativePath).digest('hex').slice(0, 32);
  }

  async *load(): AsyncGenerator<ConnectorDocument> {
    let entries: string[];
    try {
      entries = await this.listFiles();
    } catch (err) {
      logger.error({ err, path: this.dirPath }, '[local-files-connector] Failed to list directory');
      return;
    }

    for (const relPath of entries) {
      const doc = await this.readFileAsDocument(relPath);
      if (doc) yield doc;
    }
  }

  async *poll(since: Date): AsyncGenerator<ConnectorDocument> {
    let entries: string[];
    try {
      entries = await this.listFiles();
    } catch (err) {
      logger.error({ err, path: this.dirPath }, '[local-files-connector] Failed to list directory');
      return;
    }

    for (const relPath of entries) {
      try {
        const absPath = join(this.dirPath, relPath);
        const fileStat = await stat(absPath);
        if (fileStat.mtime > since) {
          const doc = await this.readFileAsDocument(relPath);
          if (doc) yield doc;
        }
      } catch {
        // Skip files we can't stat
      }
    }
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const dirStat = await stat(this.dirPath);
      if (!dirStat.isDirectory()) {
        return { ok: false, error: `"${this.dirPath}" is not a directory` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Directory not accessible' };
    }
  }

  private async listFiles(): Promise<string[]> {
    const raw = await readdir(this.dirPath, { recursive: this.recursive });
    // readdir with recursive returns strings (relative paths)
    const entries = raw as string[];
    return entries.filter((entry) => this.matchesPattern(entry));
  }

  private async readFileAsDocument(relPath: string): Promise<ConnectorDocument | null> {
    const absPath = join(this.dirPath, relPath);
    try {
      const fileStat = await stat(absPath);
      if (!fileStat.isFile()) return null;

      const content = await readFile(absPath, 'utf-8');
      const ext = extname(relPath).toLowerCase();

      return {
        id: this.makeId(relPath),
        title: relPath,
        content,
        sourceUrl: absPath,
        metadata: { dirPath: this.dirPath, relativePath: relPath },
        updatedAt: fileStat.mtime,
        mimeType: ext === '.md' ? 'text/markdown' : ext === '.json' ? 'application/json' : 'text/plain',
      };
    } catch (err) {
      logger.warn({ err, path: absPath }, '[local-files-connector] Failed to read file');
      return null;
    }
  }
}
