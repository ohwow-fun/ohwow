/**
 * ToolResultView Component
 * Renders rich, Claude Code-style tool results in the TUI.
 * Diffs for edits, line-numbered content for reads, styled bash output, etc.
 */

import React from 'react';
import { Box, Text } from 'ink';

const MAX_RESULT_LINES = 20;
const MAX_LINE_WIDTH = 100;

function truncLine(line: string): string {
  return line.length > MAX_LINE_WIDTH ? line.slice(0, MAX_LINE_WIDTH) + '…' : line;
}

function shortenPath(path: string): string {
  // Show last 3 segments: …/foo/bar/baz.ts
  const parts = path.split('/');
  if (parts.length <= 4) return path;
  return '…/' + parts.slice(-3).join('/');
}

/**
 * Render a file read result with line numbers
 */
function ReadFileView({ input, result }: { input: Record<string, unknown>; result: string }) {
  const filePath = (input.path || input.file_path || '') as string;
  const lines = result.split('\n');
  const startLine = typeof input.start_line === 'number' ? input.start_line : 1;
  const displayLines = lines.slice(0, MAX_RESULT_LINES);
  const remaining = lines.length - displayLines.length;

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text color="cyan" dimColor>{shortenPath(filePath)}</Text>
      {displayLines.map((line, i) => {
        const lineNum = startLine + i;
        const numStr = String(lineNum).padStart(4, ' ');
        return (
          <Box key={i}>
            <Text color="gray" dimColor>{numStr} │ </Text>
            <Text>{truncLine(line)}</Text>
          </Box>
        );
      })}
      {remaining > 0 && (
        <Text color="gray" dimColor>     … {remaining} more lines</Text>
      )}
    </Box>
  );
}

/**
 * Build a unified diff: shared prefix context, removed lines, added lines, shared suffix context.
 */
function buildUnifiedDiff(oldStr: string, newStr: string): Array<{ type: 'ctx' | 'del' | 'add'; text: string }> {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const result: Array<{ type: 'ctx' | 'del' | 'add'; text: string }> = [];

  // Find common prefix lines
  let prefixLen = 0;
  while (prefixLen < oldLines.length && prefixLen < newLines.length && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }

  // Find common suffix lines (don't overlap with prefix)
  let suffixLen = 0;
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  // Show up to 2 context lines from prefix/suffix
  const ctxBefore = Math.min(prefixLen, 2);
  const ctxAfter = Math.min(suffixLen, 2);

  for (let i = prefixLen - ctxBefore; i < prefixLen; i++) {
    result.push({ type: 'ctx', text: oldLines[i] });
  }
  for (let i = prefixLen; i < oldLines.length - suffixLen; i++) {
    result.push({ type: 'del', text: oldLines[i] });
  }
  for (let i = prefixLen; i < newLines.length - suffixLen; i++) {
    result.push({ type: 'add', text: newLines[i] });
  }
  for (let i = oldLines.length - suffixLen; i < oldLines.length - suffixLen + ctxAfter; i++) {
    if (i >= 0 && i < oldLines.length) {
      result.push({ type: 'ctx', text: oldLines[i] });
    }
  }

  return result;
}

/**
 * Render an edit result with unified diff (context + red/green)
 */
function EditFileView({ input }: { input: Record<string, unknown> }) {
  const filePath = (input.path || input.file_path || '') as string;
  const oldStr = (input.old_string || '') as string;
  const newStr = (input.new_string || '') as string;

  const diffLines = buildUnifiedDiff(oldStr, newStr);
  const maxDiffLines = 20;
  const displayLines = diffLines.slice(0, maxDiffLines);
  const remaining = diffLines.length - displayLines.length;

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text color="cyan" dimColor>{shortenPath(filePath)}</Text>
      {displayLines.map((dl, i) => {
        if (dl.type === 'ctx') {
          return (
            <Box key={i}>
              <Text color="gray" dimColor>  {truncLine(dl.text)}</Text>
            </Box>
          );
        }
        if (dl.type === 'del') {
          return (
            <Box key={i}>
              <Text color="red">- {truncLine(dl.text)}</Text>
            </Box>
          );
        }
        return (
          <Box key={i}>
            <Text color="green">+ {truncLine(dl.text)}</Text>
          </Box>
        );
      })}
      {remaining > 0 && (
        <Text color="gray" dimColor>  … {remaining} more lines</Text>
      )}
    </Box>
  );
}

/**
 * Render a file write result
 */
function WriteFileView({ input, result }: { input: Record<string, unknown>; result: string }) {
  const filePath = (input.path || input.file_path || '') as string;
  const content = (input.content || '') as string;
  const lineCount = content.split('\n').length;

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text color="green">✓ </Text>
        <Text color="cyan" dimColor>{shortenPath(filePath)}</Text>
        <Text color="gray" dimColor> ({lineCount} lines)</Text>
      </Box>
    </Box>
  );
}

/**
 * Render bash command output
 */
function BashResultView({ input, result }: { input: Record<string, unknown>; result: string }) {
  const command = (input.command || '') as string;
  const lines = result.split('\n');
  const displayLines = lines.slice(0, MAX_RESULT_LINES);
  const remaining = lines.length - displayLines.length;

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text color="gray" dimColor>$ </Text>
        <Text color="white" bold>{truncLine(command)}</Text>
      </Box>
      {displayLines.length > 0 && (
        <Box flexDirection="column" marginLeft={1}>
          {displayLines.map((line, i) => (
            <Text key={i} color="gray">{truncLine(line)}</Text>
          ))}
          {remaining > 0 && (
            <Text color="gray" dimColor>… {remaining} more lines</Text>
          )}
        </Box>
      )}
    </Box>
  );
}

/**
 * Render search content results with file paths and matched lines
 */
function SearchResultView({ input, result }: { input: Record<string, unknown>; result: string }) {
  const pattern = (input.pattern || input.query || input.text || '') as string;
  const lines = result.split('\n').filter(Boolean);
  const displayLines = lines.slice(0, MAX_RESULT_LINES);
  const remaining = lines.length - displayLines.length;

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text color="yellow" dimColor>search: {pattern}</Text>
      {displayLines.map((line, i) => {
        // Lines often look like "path/file.ts:42:  matched content"
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0 && colonIdx < 100) {
          const path = line.slice(0, colonIdx);
          const rest = line.slice(colonIdx);
          return (
            <Box key={i}>
              <Text color="cyan" dimColor>{shortenPath(path)}</Text>
              <Text color="gray">{truncLine(rest)}</Text>
            </Box>
          );
        }
        return <Text key={i} color="gray">{truncLine(line)}</Text>;
      })}
      {remaining > 0 && (
        <Text color="gray" dimColor>… {remaining} more results</Text>
      )}
    </Box>
  );
}

/**
 * Render a directory listing
 */
function ListDirectoryView({ input, result }: { input: Record<string, unknown>; result: string }) {
  const dirPath = (input.path || input.directory || '') as string;
  const lines = result.split('\n').filter(Boolean);
  const displayLines = lines.slice(0, MAX_RESULT_LINES);
  const remaining = lines.length - displayLines.length;

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text color="cyan" dimColor>{shortenPath(String(dirPath))}/</Text>
      {displayLines.map((entry, i) => {
        const isDir = entry.endsWith('/');
        return (
          <Box key={i}>
            <Text color="gray" dimColor>  </Text>
            <Text color={isDir ? 'blue' : 'white'}>{entry}</Text>
          </Box>
        );
      })}
      {remaining > 0 && (
        <Text color="gray" dimColor>  … {remaining} more entries</Text>
      )}
    </Box>
  );
}

/**
 * Generic fallback for unknown tool results
 */
function GenericResultView({ result }: { result: string }) {
  const lines = result.split('\n');
  const displayLines = lines.slice(0, 8);
  const remaining = lines.length - displayLines.length;

  return (
    <Box flexDirection="column" marginLeft={2}>
      {displayLines.map((line, i) => (
        <Text key={i} color="gray">{truncLine(line)}</Text>
      ))}
      {remaining > 0 && (
        <Text color="gray" dimColor>… {remaining} more lines</Text>
      )}
    </Box>
  );
}

interface ToolResultViewProps {
  toolName: string;
  input: Record<string, unknown>;
  result?: string;
  status: 'running' | 'done' | 'error';
}

export function ToolResultView({ toolName, input, result, status }: ToolResultViewProps) {
  // Only show results for completed tools
  if (status !== 'done' || !result) return null;

  // Skip empty or trivial results
  const trimmed = result.trim();
  if (!trimmed || trimmed === 'ok' || trimmed === 'success' || trimmed.length < 5) return null;

  // Edit tools always show diff from input, not result
  if (toolName === 'local_edit_file') {
    return <EditFileView input={input} />;
  }

  // Route to specialized views
  if (toolName === 'local_read_file') {
    return <ReadFileView input={input} result={trimmed} />;
  }

  if (toolName === 'local_write_file') {
    return <WriteFileView input={input} result={trimmed} />;
  }

  if (toolName === 'run_bash') {
    return <BashResultView input={input} result={trimmed} />;
  }

  if (toolName === 'local_search_content') {
    return <SearchResultView input={input} result={trimmed} />;
  }

  if (toolName === 'local_search_files') {
    return <SearchResultView input={input} result={trimmed} />;
  }

  if (toolName === 'local_list_directory') {
    return <ListDirectoryView input={input} result={trimmed} />;
  }

  // For other tools, show generic truncated output
  return <GenericResultView result={trimmed} />;
}
