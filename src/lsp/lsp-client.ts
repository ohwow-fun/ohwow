/**
 * LSP client that wraps a transport with LSP protocol semantics.
 * Handles initialization, document sync, and typed request methods.
 */

import { readFileSync, statSync, existsSync } from 'fs';
import { pathToFileURL } from 'url';
import { logger } from '../lib/logger.js';
import { LspTransport } from './lsp-transport.js';
import type {
  LspServerSpec, LspDiagnostic, LspHoverResult,
  LspLocation, LspCompletionItem, LspPosition,
} from './lsp-types.js';
import { diagnosticSeverityToString, completionKindToString } from './lsp-types.js';

const DIAGNOSTICS_WAIT_MS = 3000;
const DIAGNOSTICS_POLL_MS = 200;

interface DocumentState {
  uri: string;
  version: number;
  mtime: number;
}

export class LspClient {
  private transport: LspTransport;
  private initialized = false;
  private diagnosticsCache = new Map<string, LspDiagnostic[]>();
  private openDocuments = new Map<string, DocumentState>();

  constructor(
    private spec: LspServerSpec,
    private rootPath: string,
  ) {
    this.transport = new LspTransport(spec.command, spec.args, rootPath);
  }

  get alive(): boolean {
    return this.transport.alive;
  }

  /** Start the language server and run the initialize handshake. */
  async start(): Promise<void> {
    this.transport.start((method, params) => {
      if (method === 'textDocument/publishDiagnostics') {
        const p = params as { uri: string; diagnostics: Array<{ range: { start: LspPosition; end: LspPosition }; severity?: number; message: string; source?: string; code?: string | number }> };
        this.diagnosticsCache.set(p.uri, p.diagnostics.map(d => ({
          range: d.range,
          severity: diagnosticSeverityToString(d.severity),
          message: d.message,
          source: d.source,
          code: d.code,
        })));
      }
    });

    const rootUri = pathToFileURL(this.rootPath).toString();

    await this.transport.request('initialize', {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: false },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: {},
          references: {},
          completion: { completionItem: { snippetSupport: false } },
        },
      },
    });

    this.transport.notify('initialized', {});
    this.initialized = true;
    logger.info({ language: this.spec.language, root: this.rootPath }, '[LSP] Server initialized');
  }

  /** Ensure a document is open and up-to-date. Reopens if file has changed on disk. */
  private async ensureDocument(filePath: string): Promise<string> {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const uri = pathToFileURL(filePath).toString();
    const existing = this.openDocuments.get(uri);

    let currentMtime: number;
    try {
      currentMtime = statSync(filePath).mtimeMs;
    } catch (err) {
      throw new Error(`Cannot access file: ${filePath} (${err instanceof Error ? err.message : 'unknown error'})`);
    }

    if (existing && existing.mtime === currentMtime) return uri;

    // Close stale document
    if (existing) {
      this.transport.notify('textDocument/didClose', {
        textDocument: { uri },
      });
    }

    // Skip binary files (check for null bytes in first 8KB)
    const buf = readFileSync(filePath);
    const sample = buf.subarray(0, 8192);
    if (sample.includes(0)) {
      throw new Error(`File appears to be binary: ${filePath}. LSP only supports text files.`);
    }
    const content = buf.toString('utf-8');
    const version = (existing?.version ?? 0) + 1;

    this.transport.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: this.spec.language,
        version,
        text: content,
      },
    });

    this.openDocuments.set(uri, { uri, version, mtime: currentMtime });
    return uri;
  }

  /** Get diagnostics for a file. Waits briefly for the server to publish them. */
  async getDiagnostics(filePath: string): Promise<LspDiagnostic[]> {
    const uri = await this.ensureDocument(filePath);

    // Clear stale diagnostics and wait for fresh ones
    this.diagnosticsCache.delete(uri);

    const deadline = Date.now() + DIAGNOSTICS_WAIT_MS;
    while (Date.now() < deadline) {
      const cached = this.diagnosticsCache.get(uri);
      if (cached) return cached;
      await new Promise(resolve => setTimeout(resolve, DIAGNOSTICS_POLL_MS));
    }

    // Return whatever we have (may be empty if server is slow)
    return this.diagnosticsCache.get(uri) ?? [];
  }

  /** Get hover information at a position. */
  async hover(filePath: string, position: LspPosition): Promise<LspHoverResult | null> {
    const uri = await this.ensureDocument(filePath);

    const result = await this.transport.request<{
      contents: string | { kind: string; value: string } | Array<string | { kind: string; value: string }>;
      range?: { start: LspPosition; end: LspPosition };
    } | null>('textDocument/hover', {
      textDocument: { uri },
      position,
    });

    if (!result) return null;

    let contents: string;
    if (typeof result.contents === 'string') {
      contents = result.contents;
    } else if (Array.isArray(result.contents)) {
      contents = result.contents.map(c => typeof c === 'string' ? c : c.value).join('\n');
    } else {
      contents = result.contents.value;
    }

    return { contents, range: result.range };
  }

  /** Go to definition of a symbol at a position. */
  async goToDefinition(filePath: string, position: LspPosition): Promise<LspLocation[]> {
    const uri = await this.ensureDocument(filePath);

    const result = await this.transport.request<
      { uri: string; range: { start: LspPosition; end: LspPosition } } |
      Array<{ uri: string; range: { start: LspPosition; end: LspPosition } }> |
      null
    >('textDocument/definition', {
      textDocument: { uri },
      position,
    });

    if (!result) return [];
    const locations = Array.isArray(result) ? result : [result];
    return locations.map(loc => ({ uri: loc.uri, range: loc.range }));
  }

  /** Find all references to a symbol at a position. */
  async references(filePath: string, position: LspPosition): Promise<LspLocation[]> {
    const uri = await this.ensureDocument(filePath);

    const result = await this.transport.request<
      Array<{ uri: string; range: { start: LspPosition; end: LspPosition } }> | null
    >('textDocument/references', {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    });

    return result ?? [];
  }

  /** Get completions at a position. */
  async completions(filePath: string, position: LspPosition): Promise<LspCompletionItem[]> {
    const uri = await this.ensureDocument(filePath);

    const result = await this.transport.request<{
      items?: Array<{ label: string; kind?: number; detail?: string }>;
    } | Array<{ label: string; kind?: number; detail?: string }> | null>(
      'textDocument/completion',
      { textDocument: { uri }, position },
    );

    if (!result) return [];
    const items = Array.isArray(result) ? result : (result.items ?? []);

    return items.slice(0, 20).map(item => ({
      label: item.label,
      kind: completionKindToString(item.kind),
      detail: item.detail,
    }));
  }

  /** Graceful shutdown: send shutdown request then exit notification. */
  async stop(): Promise<void> {
    if (!this.initialized) {
      await this.transport.destroy();
      return;
    }

    try {
      await this.transport.request('shutdown', null);
      this.transport.notify('exit', null);
    } catch {
      // Server may have already exited
    }

    await this.transport.destroy();
    this.initialized = false;
    this.openDocuments.clear();
    this.diagnosticsCache.clear();
  }
}
