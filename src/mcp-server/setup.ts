/**
 * Claude Code Integration Setup
 * Writes/removes the MCP server config in ~/.claude/settings.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { commandExists } from '../lib/platform-utils.js';

const CLAUDE_DIR = join(homedir(), '.claude');
const CLAUDE_SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');

interface ClaudeSettings {
  mcpServers?: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
  [key: string]: unknown;
}

function readClaudeSettings(): ClaudeSettings | null {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
  } catch {
    // Invalid JSON — return null so callers don't overwrite the file
    return null;
  }
}

function writeClaudeSettings(settings: ClaudeSettings): void {
  if (!existsSync(CLAUDE_DIR)) {
    mkdirSync(CLAUDE_DIR, { recursive: true });
  }
  writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

function detectOhwowCommand(): { command: string; args: string[] } {
  if (commandExists('ohwow')) {
    return { command: 'ohwow', args: ['mcp-server'] };
  }
  return { command: 'npx', args: ['-y', 'ohwow', 'mcp-server'] };
}

/**
 * Enable the OHWOW MCP server in Claude Code settings.
 * Writes the mcpServers.ohwow entry to ~/.claude/settings.json.
 */
export function enableClaudeCodeIntegration(): string {
  const settings = readClaudeSettings();
  if (!settings) {
    return `Couldn't parse ${CLAUDE_SETTINGS_PATH}. Fix the JSON manually before enabling.`;
  }
  const { command, args } = detectOhwowCommand();

  if (!settings.mcpServers) {
    settings.mcpServers = {};
  }

  settings.mcpServers.ohwow = { command, args };
  writeClaudeSettings(settings);

  return `Claude Code integration enabled. Restart Claude Code to connect.\nConfig written to ${CLAUDE_SETTINGS_PATH}`;
}

/**
 * Disable the OHWOW MCP server in Claude Code settings.
 * Removes the mcpServers.ohwow entry from ~/.claude/settings.json.
 */
export function disableClaudeCodeIntegration(): string {
  const settings = readClaudeSettings();
  if (!settings) {
    return `Couldn't parse ${CLAUDE_SETTINGS_PATH}. Fix the JSON manually before disabling.`;
  }

  if (settings.mcpServers?.ohwow) {
    delete settings.mcpServers.ohwow;
    if (Object.keys(settings.mcpServers).length === 0) {
      delete settings.mcpServers;
    }
    writeClaudeSettings(settings);
  }

  return 'Claude Code integration disabled.';
}
