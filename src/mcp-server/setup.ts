/**
 * Claude Code Integration Setup
 * Writes/removes the MCP server config in ~/.claude/settings.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
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

/**
 * Resolve the absolute path to the `ohwow` binary on this machine. Claude
 * Code spawns MCP servers through a minimal shell that does not source the
 * user's login profile, so an `nvm`-managed `ohwow` is not on PATH. We
 * therefore write an absolute path into the mcpServers entry.
 *
 * Preference order:
 *   1. `which ohwow` resolved to an absolute path
 *   2. `commandExists('ohwow')` + assume the caller shell can find it
 *      (bare command name, fallback)
 *   3. `npx -y ohwow mcp-server` as a last resort
 */
function detectOhwowCommand(): { command: string; args: string[]; env?: Record<string, string> } {
  try {
    const resolved = execSync('which ohwow', { encoding: 'utf-8', timeout: 3000 }).trim();
    if (resolved && existsSync(resolved)) {
      const real = realpathSync(resolved);
      // PATH derivation: whichever directory holds the resolved binary goes
      // first so Claude Code's spawn env can find `node` (the ohwow shebang
      // target) alongside it. This is the fix for nvm-managed installs.
      const binDir = dirname(real);
      const env = {
        PATH: `${binDir}:/usr/local/bin:/usr/bin:/bin`,
      };
      return { command: real, args: ['mcp-server'], env };
    }
  } catch {
    // which failed — fall through
  }
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
  const { command, args, env } = detectOhwowCommand();

  if (!settings.mcpServers) {
    settings.mcpServers = {};
  }

  settings.mcpServers.ohwow = env ? { command, args, env } : { command, args };
  writeClaudeSettings(settings);

  return `Claude Code integration enabled.

Next steps:
  1. Restart Claude Code (or run /reload-plugins)
  2. Say "ohwow_workspace_status" to verify the connection
  3. Optional: Set modelSource to "claude-code" in ~/.ohwow/config.json
     to use Claude as the AI processor for your agents (no API key needed)

Config written to ${CLAUDE_SETTINGS_PATH}`;
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
