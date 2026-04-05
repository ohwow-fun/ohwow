#!/usr/bin/env node
/**
 * OpenClaw MCP Shim Server
 * Runs as a subprocess managed by McpClientManager via stdio transport.
 * Exposes allowlisted OpenClaw skills as MCP tools.
 *
 * Environment variables (set by mcp-bridge.ts):
 *   OPENCLAW_BINARY — path to openclaw CLI
 *   OPENCLAW_ALLOWLIST — JSON array of allowed skill IDs
 *   OPENCLAW_RATE_LIMIT_MINUTE — max calls per minute per skill
 *   OPENCLAW_RATE_LIMIT_HOUR — max calls per hour per skill
 *   OPENCLAW_ALLOW_NETWORK — '1' to allow network in sandbox
 *   OPENCLAW_MAX_EXECUTION_MS — max execution time
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { execFileSync } from 'child_process';

// ============================================================================
// CONFIG FROM ENV
// ============================================================================

const BINARY = process.env.OPENCLAW_BINARY || 'openclaw';
const ALLOWLIST: string[] = JSON.parse(process.env.OPENCLAW_ALLOWLIST || '[]');
const RATE_LIMIT_MINUTE = parseInt(process.env.OPENCLAW_RATE_LIMIT_MINUTE || '10', 10);
const RATE_LIMIT_HOUR = parseInt(process.env.OPENCLAW_RATE_LIMIT_HOUR || '100', 10);
const ALLOW_NETWORK = process.env.OPENCLAW_ALLOW_NETWORK === '1';
const MAX_EXECUTION_MS = parseInt(process.env.OPENCLAW_MAX_EXECUTION_MS || '30000', 10);

// ============================================================================
// RATE LIMITER (in-process)
// ============================================================================

const minuteBuckets = new Map<string, number[]>();
const hourBuckets = new Map<string, number[]>();

function checkRateLimit(skillId: string): boolean {
  const now = Date.now();

  const minuteCalls = (minuteBuckets.get(skillId) ?? []).filter(t => t > now - 60_000);
  if (minuteCalls.length >= RATE_LIMIT_MINUTE) return false;

  const hourCalls = (hourBuckets.get(skillId) ?? []).filter(t => t > now - 3_600_000);
  if (hourCalls.length >= RATE_LIMIT_HOUR) return false;

  minuteCalls.push(now);
  hourCalls.push(now);
  minuteBuckets.set(skillId, minuteCalls);
  hourBuckets.set(skillId, hourCalls);
  return true;
}

// ============================================================================
// SKILL MANIFEST CACHE
// ============================================================================

interface SkillInfo {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

let cachedSkills: SkillInfo[] | null = null;

function getSkills(): SkillInfo[] {
  if (cachedSkills) return cachedSkills;

  const skills: SkillInfo[] = [];

  for (const skillId of ALLOWLIST) {
    try {
      const output = execFileSync(BINARY, ['skill', 'info', skillId, '--json'], {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      const info = JSON.parse(output);
      skills.push({
        id: skillId,
        name: info.name || skillId,
        description: info.description || `OpenClaw skill: ${skillId}`,
        inputSchema: info.inputSchema || { type: 'object', properties: { input: { type: 'string' } } },
      });
    } catch {
      // Skill not found or parse error — skip it
      skills.push({
        id: skillId,
        name: skillId,
        description: `OpenClaw skill: ${skillId}`,
        inputSchema: { type: 'object', properties: { input: { type: 'string', description: 'Input for the skill' } } },
      });
    }
  }

  cachedSkills = skills;
  return skills;
}

// ============================================================================
// SANDBOX EXECUTION
// ============================================================================

function executeSkill(skillId: string, args: Record<string, unknown>): { output: string; durationMs: number } {
  const startTime = Date.now();

  const isWin = process.platform === 'win32';
  const sandboxEnv: Record<string, string> = {
    ...(isWin
      ? { USERPROFILE: 'C:\\Temp\\openclaw-sandbox', TEMP: 'C:\\Temp\\openclaw-sandbox', TMP: 'C:\\Temp\\openclaw-sandbox', PATH: 'C:\\Windows\\System32;C:\\Windows' }
      : { HOME: '/tmp/openclaw-sandbox', TMPDIR: '/tmp/openclaw-sandbox', PATH: '/usr/bin:/bin' }),
    LANG: 'en_US.UTF-8',
    OPENCLAW_SANDBOX: '1',
  };

  if (!ALLOW_NETWORK) {
    sandboxEnv['OPENCLAW_NO_NETWORK'] = '1';
  }

  const inputJson = JSON.stringify(args);

  const output = execFileSync(BINARY, ['skill', 'run', skillId, '--input', inputJson], {
    encoding: 'utf-8',
    timeout: MAX_EXECUTION_MS,
    maxBuffer: 10 * 1024 * 1024,
    env: sandboxEnv,
  });

  return { output: output.trim(), durationMs: Date.now() - startTime };
}

// ============================================================================
// MCP SERVER
// ============================================================================

const server = new Server(
  { name: 'openclaw', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const skills = getSkills();

  return {
    tools: skills.map(skill => ({
      name: skill.id,
      description: skill.description,
      inputSchema: skill.inputSchema,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name: skillId, arguments: args } = request.params;

  // Validate allowlist
  if (!ALLOWLIST.includes(skillId)) {
    return {
      content: [{ type: 'text', text: `Error: Skill "${skillId}" is not in the allowlist` }],
      isError: true,
    };
  }

  // Check rate limit
  if (!checkRateLimit(skillId)) {
    return {
      content: [{ type: 'text', text: `Error: Rate limit exceeded for skill "${skillId}"` }],
      isError: true,
    };
  }

  try {
    const { output, durationMs: _durationMs } = executeSkill(skillId, args || {});

    return {
      content: [{ type: 'text', text: output || '(no output)' }],
      isError: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error executing skill "${skillId}": ${message}` }],
      isError: true,
    };
  }
});

// ============================================================================
// START
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`OpenClaw MCP shim fatal error: ${err}\n`);
  process.exit(1);
});
