/**
 * LSP tool handlers for code intelligence.
 * Provides diagnostics, hover, go-to-definition, references, and completions.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { logger } from '../../lib/logger.js';
import type { LocalToolContext } from '../local-tool-types.js';
import type { ToolResult } from '../local-tool-types.js';

export const LSP_CODE_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'lsp_diagnostics',
    description: 'Get compiler errors and warnings for a file using the language server. Use before and after edits to verify correctness.',
    input_schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path (absolute or relative to workspace)' },
      },
      required: ['file'],
    },
  },
  {
    name: 'lsp_hover',
    description: 'Get type information and documentation for a symbol at a specific position in a file.',
    input_schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path' },
        line: { type: 'number', description: 'Line number (1-based)' },
        character: { type: 'number', description: 'Column number (1-based)' },
      },
      required: ['file', 'line', 'character'],
    },
  },
  {
    name: 'lsp_go_to_definition',
    description: 'Jump to the definition of a symbol at a given position. Returns the file and location with surrounding code context.',
    input_schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path' },
        line: { type: 'number', description: 'Line number (1-based)' },
        character: { type: 'number', description: 'Column number (1-based)' },
      },
      required: ['file', 'line', 'character'],
    },
  },
  {
    name: 'lsp_references',
    description: 'Find all references to a symbol at a given position across the project.',
    input_schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path' },
        line: { type: 'number', description: 'Line number (1-based)' },
        character: { type: 'number', description: 'Column number (1-based)' },
      },
      required: ['file', 'line', 'character'],
    },
  },
  {
    name: 'lsp_completions',
    description: 'Get code completions at a position. Useful for discovering available methods, properties, or imports.',
    input_schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path' },
        line: { type: 'number', description: 'Line number (1-based)' },
        character: { type: 'number', description: 'Column number (1-based)' },
      },
      required: ['file', 'line', 'character'],
    },
  },
];

/** Resolve a file path relative to working directory, with workspace boundary check. */
function resolveFile(ctx: LocalToolContext, file: string): string {
  const workingDir = ctx.workingDirectory || process.cwd();
  const resolved = resolve(workingDir, file);
  const normalizedDir = workingDir.endsWith('/') ? workingDir : workingDir + '/';
  if (resolved !== workingDir && !resolved.startsWith(normalizedDir)) {
    throw new Error(`Path "${file}" resolves outside working directory`);
  }
  return resolved;
}

/** Convert 1-based user input to 0-based LSP position. */
function toPosition(line: number, character: number) {
  return { line: Math.max(0, line - 1), character: Math.max(0, character - 1) };
}

/** Convert an LSP URI to a relative path from workspace root. */
function uriToRelative(uri: string, cwd: string): string {
  try {
    const abs = fileURLToPath(uri);
    const cwdWithSlash = cwd.endsWith('/') ? cwd : cwd + '/';
    if (abs.startsWith(cwdWithSlash)) {
      return abs.slice(cwdWithSlash.length);
    }
    return abs;
  } catch {
    return uri;
  }
}

/** Read a few lines of context around a position from a file. */
function readContext(filePath: string, line: number, contextLines = 2): string {
  try {
    const absPath = filePath.startsWith('file://') ? fileURLToPath(filePath) : filePath;
    const lines = readFileSync(absPath, 'utf-8').split('\n');
    const start = Math.max(0, line - contextLines);
    const end = Math.min(lines.length, line + contextLines + 1);
    return lines.slice(start, end).map((l, i) => {
      const lineNum = start + i + 1;
      const marker = lineNum === line + 1 ? '>' : ' ';
      return `${marker} ${lineNum}: ${l}`;
    }).join('\n');
  } catch {
    return '';
  }
}

export async function lspDiagnostics(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const file = input.file as string;
  if (!file) return { success: false, error: 'Missing required parameter: file' };
  if (!ctx.lspManager) return { success: false, error: 'LSP is not available. Enable it in config.' };

  const filePath = resolveFile(ctx, file);
  const client = await ctx.lspManager.getClient(filePath);
  if (!client) {
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    return { success: false, error: `No language server available for "${ext}" files. Install one and try again.` };
  }

  try {
    const diagnostics = await client.getDiagnostics(filePath);
    if (diagnostics.length === 0) {
      return { success: true, data: { file, diagnosticCount: 0, message: 'No errors or warnings.' } };
    }

    // Limit and format
    const limited = diagnostics.slice(0, 50);
    const formatted = limited.map(d => ({
      severity: d.severity,
      line: d.range.start.line + 1,
      character: d.range.start.character + 1,
      message: d.message,
      source: d.source,
      code: d.code,
    }));

    const errors = formatted.filter(d => d.severity === 'error').length;
    const warnings = formatted.filter(d => d.severity === 'warning').length;

    return {
      success: true,
      data: {
        file,
        diagnosticCount: diagnostics.length,
        errors,
        warnings,
        diagnostics: formatted,
        ...(diagnostics.length > 50 ? { truncated: true, totalCount: diagnostics.length } : {}),
      },
    };
  } catch (err) {
    logger.error({ err, file }, '[LSP] Diagnostics failed');
    return { success: false, error: err instanceof Error ? err.message : 'Diagnostics failed' };
  }
}

export async function lspHover(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const file = input.file as string;
  const line = input.line as number;
  const character = input.character as number;
  if (!file || line == null || character == null) return { success: false, error: 'Missing required parameters: file, line, character' };
  if (!ctx.lspManager) return { success: false, error: 'LSP is not available.' };

  const filePath = resolveFile(ctx, file);
  const client = await ctx.lspManager.getClient(filePath);
  if (!client) return { success: false, error: 'No language server available for this file type.' };

  try {
    const result = await client.hover(filePath, toPosition(line, character));
    if (!result) return { success: true, data: { file, line, character, info: 'No hover information available at this position.' } };
    return { success: true, data: { file, line, character, info: result.contents } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Hover failed' };
  }
}

export async function lspGoToDefinition(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const file = input.file as string;
  const line = input.line as number;
  const character = input.character as number;
  if (!file || line == null || character == null) return { success: false, error: 'Missing required parameters: file, line, character' };
  if (!ctx.lspManager) return { success: false, error: 'LSP is not available.' };

  const filePath = resolveFile(ctx, file);
  const cwd = ctx.workingDirectory || process.cwd();
  const client = await ctx.lspManager.getClient(filePath);
  if (!client) return { success: false, error: 'No language server available for this file type.' };

  try {
    const locations = await client.goToDefinition(filePath, toPosition(line, character));
    if (locations.length === 0) return { success: true, data: { file, line, character, message: 'No definition found.' } };

    const definitions = locations.slice(0, 10).map(loc => {
      const relPath = uriToRelative(loc.uri, cwd);
      const defLine = loc.range.start.line;
      const context = readContext(loc.uri, defLine);
      return {
        file: relPath,
        line: defLine + 1,
        character: loc.range.start.character + 1,
        context,
      };
    });

    return { success: true, data: { file, line, character, definitions } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Go to definition failed' };
  }
}

export async function lspReferences(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const file = input.file as string;
  const line = input.line as number;
  const character = input.character as number;
  if (!file || line == null || character == null) return { success: false, error: 'Missing required parameters: file, line, character' };
  if (!ctx.lspManager) return { success: false, error: 'LSP is not available.' };

  const filePath = resolveFile(ctx, file);
  const cwd = ctx.workingDirectory || process.cwd();
  const client = await ctx.lspManager.getClient(filePath);
  if (!client) return { success: false, error: 'No language server available for this file type.' };

  try {
    const locations = await client.references(filePath, toPosition(line, character));
    if (locations.length === 0) return { success: true, data: { file, line, character, message: 'No references found.' } };

    const refs = locations.slice(0, 30).map(loc => ({
      file: uriToRelative(loc.uri, cwd),
      line: loc.range.start.line + 1,
      character: loc.range.start.character + 1,
    }));

    return {
      success: true,
      data: {
        file, line, character,
        referenceCount: locations.length,
        references: refs,
        ...(locations.length > 30 ? { truncated: true, totalCount: locations.length } : {}),
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Find references failed' };
  }
}

export async function lspCompletions(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const file = input.file as string;
  const line = input.line as number;
  const character = input.character as number;
  if (!file || line == null || character == null) return { success: false, error: 'Missing required parameters: file, line, character' };
  if (!ctx.lspManager) return { success: false, error: 'LSP is not available.' };

  const filePath = resolveFile(ctx, file);
  const client = await ctx.lspManager.getClient(filePath);
  if (!client) return { success: false, error: 'No language server available for this file type.' };

  try {
    const items = await client.completions(filePath, toPosition(line, character));
    if (items.length === 0) return { success: true, data: { file, line, character, message: 'No completions available.' } };
    return { success: true, data: { file, line, character, completions: items } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Completions failed' };
  }
}
