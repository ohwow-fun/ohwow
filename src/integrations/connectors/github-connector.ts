/**
 * GitHub Data Source Connector
 * Fetches documents from a GitHub repository via the REST API.
 */

import type { DataSourceConnector, ConnectorDocument, ConnectorConfig } from '../connector-types.js';
import { logger } from '../../lib/logger.js';

const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt', '.rst', '.json', '.csv', '.html', '.xml']);
const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 30_000;

export class GitHubConnector implements DataSourceConnector {
  readonly type = 'github' as const;
  readonly name: string;
  private repo: string;      // "owner/repo"
  private token?: string;
  private branch: string;
  private paths: string[];    // glob-like path filters, e.g. ["docs/", "*.md"]

  constructor(config: ConnectorConfig) {
    this.name = config.name;
    const settings = config.settings as { repo: string; token?: string; branch?: string; paths?: string[] };
    this.repo = settings.repo;
    this.token = settings.token;
    this.branch = settings.branch || 'main';
    this.paths = settings.paths || [];
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'ohwow-connector',
    };
    if (this.token) {
      h['Authorization'] = `Bearer ${this.token}`;
    }
    return h;
  }

  private hasSupportedExtension(path: string): boolean {
    const dotIdx = path.lastIndexOf('.');
    if (dotIdx === -1) return false;
    return SUPPORTED_EXTENSIONS.has(path.slice(dotIdx).toLowerCase());
  }

  private matchesPaths(filePath: string): boolean {
    if (this.paths.length === 0) return true;
    return this.paths.some((pattern) => {
      // Directory prefix match: "docs/" matches "docs/readme.md"
      if (pattern.endsWith('/')) {
        return filePath.startsWith(pattern);
      }
      // Extension glob: "*.md" matches any file ending in .md
      if (pattern.startsWith('*.')) {
        const ext = pattern.slice(1); // ".md"
        return filePath.endsWith(ext);
      }
      // Exact match
      return filePath === pattern;
    });
  }

  async *load(): AsyncGenerator<ConnectorDocument> {
    // Fetch repository file tree
    const treeUrl = `${GITHUB_API}/repos/${this.repo}/git/trees/${this.branch}?recursive=1`;
    let treeData: { tree: Array<{ path: string; sha: string; type: string }> };

    try {
      const resp = await fetch(treeUrl, {
        headers: this.headers(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!resp.ok) {
        logger.error({ status: resp.status, repo: this.repo }, '[github-connector] Failed to fetch tree');
        return;
      }
      treeData = await resp.json() as typeof treeData;
    } catch (err) {
      logger.error({ err, repo: this.repo }, '[github-connector] Tree fetch error');
      return;
    }

    const files = (treeData.tree || []).filter(
      (entry) => entry.type === 'blob' && this.hasSupportedExtension(entry.path) && this.matchesPaths(entry.path),
    );

    for (const file of files) {
      const doc = await this.fetchFileContent(file.path, file.sha);
      if (doc) yield doc;
    }
  }

  async *poll(since: Date): AsyncGenerator<ConnectorDocument> {
    // Fetch commits since the given date
    const commitsUrl = `${GITHUB_API}/repos/${this.repo}/commits?since=${since.toISOString()}&sha=${this.branch}`;
    let commits: Array<{ sha: string }>;

    try {
      const resp = await fetch(commitsUrl, {
        headers: this.headers(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!resp.ok) {
        logger.error({ status: resp.status, repo: this.repo }, '[github-connector] Failed to fetch commits');
        return;
      }
      commits = await resp.json() as typeof commits;
    } catch (err) {
      logger.error({ err, repo: this.repo }, '[github-connector] Commits fetch error');
      return;
    }

    // Collect unique changed file paths
    const changedPaths = new Set<string>();
    for (const commit of commits) {
      try {
        const detailUrl = `${GITHUB_API}/repos/${this.repo}/commits/${commit.sha}`;
        const resp = await fetch(detailUrl, {
          headers: this.headers(),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!resp.ok) continue;
        const detail = await resp.json() as { files?: Array<{ filename: string; sha: string; status: string }> };
        for (const f of detail.files || []) {
          if (f.status !== 'removed' && this.hasSupportedExtension(f.filename) && this.matchesPaths(f.filename)) {
            changedPaths.add(f.filename);
          }
        }
      } catch {
        // Skip individual commit errors
      }
    }

    // Fetch current content for each changed file
    for (const filePath of changedPaths) {
      const doc = await this.fetchFileContent(filePath);
      if (doc) yield doc;
    }
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const resp = await fetch(`${GITHUB_API}/repos/${this.repo}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (resp.ok) return { ok: true };
      return { ok: false, error: `GitHub API returned ${resp.status} ${resp.statusText}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' };
    }
  }

  private async fetchFileContent(path: string, sha?: string): Promise<ConnectorDocument | null> {
    try {
      const url = `${GITHUB_API}/repos/${this.repo}/contents/${path}?ref=${this.branch}`;
      const resp = await fetch(url, {
        headers: this.headers(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!resp.ok) return null;

      const data = await resp.json() as {
        sha: string;
        content?: string;
        encoding?: string;
        html_url?: string;
        size?: number;
      };

      if (!data.content || data.encoding !== 'base64') return null;

      const content = Buffer.from(data.content, 'base64').toString('utf-8');

      return {
        id: sha || data.sha,
        title: path,
        content,
        sourceUrl: data.html_url || `https://github.com/${this.repo}/blob/${this.branch}/${path}`,
        metadata: { repo: this.repo, branch: this.branch, path },
        mimeType: this.guessMimeType(path),
      };
    } catch (err) {
      logger.warn({ err, path, repo: this.repo }, '[github-connector] Failed to fetch file content');
      return null;
    }
  }

  private guessMimeType(path: string): string {
    if (path.endsWith('.md')) return 'text/markdown';
    if (path.endsWith('.json')) return 'application/json';
    if (path.endsWith('.html')) return 'text/html';
    if (path.endsWith('.xml')) return 'application/xml';
    if (path.endsWith('.csv')) return 'text/csv';
    if (path.endsWith('.rst')) return 'text/x-rst';
    return 'text/plain';
  }
}
