import { describe, it, expect } from 'vitest';
import { mcpToolToAnthropic, parseMcpToolName, isMcpTool, extractToolAnnotations } from '../tool-adapter.js';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';

const baseTool: McpTool = {
  name: 'placeholder',
  inputSchema: { type: 'object' },
};

describe('mcpToolToAnthropic', () => {
  it('namespaces tool name as mcp__<server>__<tool>', () => {
    const result = mcpToolToAnthropic('my-server', {
      ...baseTool,
      name: 'read_data',
      description: 'Reads data',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    });
    expect(result.name).toBe('mcp__my-server__read_data');
    expect(result.description).toBe('Reads data');
  });

  it('passes through inputSchema or defaults to empty object', () => {
    const withSchema = mcpToolToAnthropic('srv', {
      ...baseTool,
      name: 'tool1',
      inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
    });
    expect(withSchema.input_schema.properties).toHaveProperty('x');

    const withoutSchema = mcpToolToAnthropic('srv', {
      ...baseTool,
      name: 'tool2',
      inputSchema: undefined as unknown as McpTool['inputSchema'],
    });
    expect(withoutSchema.input_schema).toEqual({ type: 'object', properties: {} });
  });

  it('generates fallback description when none provided', () => {
    const result = mcpToolToAnthropic('srv', { ...baseTool, name: 'my_tool' });
    expect(result.description).toContain('my_tool');
    expect(result.description).toContain('srv');
  });
});

describe('parseMcpToolName', () => {
  it('parses valid namespaced names', () => {
    expect(parseMcpToolName('mcp__my-server__read_data')).toEqual({
      serverName: 'my-server',
      toolName: 'read_data',
    });
  });

  it('handles server names with underscores', () => {
    const result = parseMcpToolName('mcp__my_server__tool_name');
    expect(result).not.toBeNull();
    expect(result!.serverName).toBe('my_server');
    expect(result!.toolName).toBe('tool_name');
  });

  it('returns null for invalid names', () => {
    expect(parseMcpToolName('not_mcp_tool')).toBeNull();
    expect(parseMcpToolName('mcp__')).toBeNull();
    expect(parseMcpToolName('mcp__server')).toBeNull();
  });
});

describe('isMcpTool', () => {
  it('returns true for mcp-prefixed names', () => {
    expect(isMcpTool('mcp__server__tool')).toBe(true);
  });

  it('returns false for non-mcp names', () => {
    expect(isMcpTool('list_agents')).toBe(false);
    expect(isMcpTool('run_bash')).toBe(false);
  });
});

describe('extractToolAnnotations', () => {
  it('extracts readOnlyHint and destructiveHint', () => {
    const tool: McpTool = {
      ...baseTool,
      name: 'read_data',
      annotations: { readOnlyHint: true, destructiveHint: false },
    };
    const result = extractToolAnnotations(tool);
    expect(result).toEqual({ readOnlyHint: true, destructiveHint: false });
  });

  it('returns undefined when no annotations present', () => {
    expect(extractToolAnnotations({ ...baseTool, name: 'tool' })).toBeUndefined();
  });

  it('returns undefined for empty annotations object', () => {
    expect(extractToolAnnotations({ ...baseTool, name: 'tool', annotations: {} })).toBeUndefined();
  });

  it('extracts only known annotation fields', () => {
    const tool: McpTool = {
      ...baseTool,
      name: 'tool',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    };
    const result = extractToolAnnotations(tool);
    expect(result).toEqual({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
  });
});
