import { describe, it, expect } from 'vitest';
import { getToolReversibility, TOOL_REVERSIBILITY } from '../tool-reversibility.js';

describe('getToolReversibility', () => {
  it('returns read_only for list_agents', () => {
    expect(getToolReversibility('list_agents')).toBe('read_only');
  });

  it('returns read_only for list_tasks', () => {
    expect(getToolReversibility('list_tasks')).toBe('read_only');
  });

  it('returns read_only for get_task_detail', () => {
    expect(getToolReversibility('get_task_detail')).toBe('read_only');
  });

  it('returns reversible for run_agent', () => {
    expect(getToolReversibility('run_agent')).toBe('reversible');
  });

  it('returns reversible for create_contact', () => {
    expect(getToolReversibility('create_contact')).toBe('reversible');
  });

  it('returns irreversible for approve_task', () => {
    expect(getToolReversibility('approve_task')).toBe('irreversible');
  });

  it('returns irreversible for send_whatsapp_message', () => {
    expect(getToolReversibility('send_whatsapp_message')).toBe('irreversible');
  });

  it('returns irreversible for run_bash', () => {
    expect(getToolReversibility('run_bash')).toBe('irreversible');
  });

  it('returns reversible as default for unknown tools', () => {
    expect(getToolReversibility('some_unknown_tool')).toBe('reversible');
  });

  it('returns reversible for MCP tool names (default fallback)', () => {
    expect(getToolReversibility('mcp__slack__send_message')).toBe('reversible');
  });
});

describe('TOOL_REVERSIBILITY map', () => {
  it('has entries for all browser tools', () => {
    const browserTools = Object.keys(TOOL_REVERSIBILITY).filter((k) => k.startsWith('browser_'));
    expect(browserTools.length).toBeGreaterThanOrEqual(4);
    for (const tool of browserTools) {
      expect(['read_only', 'reversible', 'irreversible']).toContain(TOOL_REVERSIBILITY[tool]);
    }
  });

  it('has entries for all filesystem tools', () => {
    const fsTools = Object.keys(TOOL_REVERSIBILITY).filter((k) => k.startsWith('local_'));
    expect(fsTools.length).toBeGreaterThanOrEqual(4);
    for (const tool of fsTools) {
      expect(['read_only', 'reversible', 'irreversible']).toContain(TOOL_REVERSIBILITY[tool]);
    }
  });
});
