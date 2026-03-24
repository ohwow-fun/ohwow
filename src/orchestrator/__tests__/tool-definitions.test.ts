import { describe, it, expect } from 'vitest';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  filterToolsByIntent,
  ORCHESTRATOR_TOOL_DEFINITIONS,
  type IntentSection,
} from '../tool-definitions.js';

function makeTool(name: string): Tool {
  return { name, description: name, input_schema: { type: 'object' as const, properties: {} } };
}

describe('filterToolsByIntent', () => {
  it('always includes update_plan regardless of sections', () => {
    const tools = [makeTool('update_plan'), makeTool('list_agents')];
    const result = filterToolsByIntent(tools, new Set<IntentSection>());
    expect(result.some((t) => t.name === 'update_plan')).toBe(true);
  });

  it('always includes delegate_subtask', () => {
    const tools = [makeTool('delegate_subtask'), makeTool('list_agents')];
    const result = filterToolsByIntent(tools, new Set<IntentSection>());
    expect(result.some((t) => t.name === 'delegate_subtask')).toBe(true);
  });

  it('includes agent tools when agents section is active', () => {
    const tools = [makeTool('list_agents'), makeTool('run_agent')];
    const result = filterToolsByIntent(tools, new Set<IntentSection>(['agents']));
    expect(result).toHaveLength(2);
  });

  it('excludes agent tools when agents section is not active', () => {
    const tools = [makeTool('list_agents'), makeTool('run_agent')];
    const result = filterToolsByIntent(tools, new Set<IntentSection>(['pulse']));
    expect(result).toHaveLength(0);
  });

  it('includes filesystem tools when filesystem section is active', () => {
    const tools = [makeTool('local_read_file'), makeTool('local_write_file')];
    const result = filterToolsByIntent(tools, new Set<IntentSection>(['filesystem']));
    expect(result).toHaveLength(2);
  });

  it('tools not in TOOL_SECTION_MAP are always included', () => {
    const tools = [makeTool('some_custom_tool')];
    const result = filterToolsByIntent(tools, new Set<IntentSection>());
    expect(result).toHaveLength(1);
  });
});

describe('ORCHESTRATOR_TOOL_DEFINITIONS', () => {
  it('is a non-empty array with valid schemas', () => {
    expect(Array.isArray(ORCHESTRATOR_TOOL_DEFINITIONS)).toBe(true);
    expect(ORCHESTRATOR_TOOL_DEFINITIONS.length).toBeGreaterThan(0);
    for (const tool of ORCHESTRATOR_TOOL_DEFINITIONS) {
      expect(tool.name).toBeTruthy();
      expect(tool.input_schema).toBeDefined();
    }
  });
});
