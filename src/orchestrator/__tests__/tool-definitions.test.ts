import { describe, it, expect } from 'vitest';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  filterToolsByIntent,
  getToolPriorityLimit,
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

describe('getToolPriorityLimit', () => {
  it('returns P1 for micro models', () => {
    expect(getToolPriorityLimit(0.5, 8000)).toBe(1);
    expect(getToolPriorityLimit(1.0, 16000)).toBe(1);
  });

  it('returns P1 for very tight context regardless of model size', () => {
    expect(getToolPriorityLimit(5, 4000)).toBe(1);
  });

  it('returns P2 for small-medium models', () => {
    expect(getToolPriorityLimit(2.5, 16000)).toBe(2);
    expect(getToolPriorityLimit(4.0, 16000)).toBe(2);
  });

  it('returns P3 for large models with ample context', () => {
    expect(getToolPriorityLimit(9.0, 65000)).toBe(3);
  });
});

describe('filterToolsByIntent with priority', () => {
  it('P1 filter returns fewer tools than no filter', () => {
    const sections = new Set<IntentSection>(['agents']);
    const allTools = filterToolsByIntent(ORCHESTRATOR_TOOL_DEFINITIONS, sections);
    const p1Tools = filterToolsByIntent(ORCHESTRATOR_TOOL_DEFINITIONS, sections, 1);
    expect(p1Tools.length).toBeLessThan(allTools.length);
    expect(p1Tools.length).toBeGreaterThan(0);
  });

  it('P1 filter includes core tools like run_agent', () => {
    const sections = new Set<IntentSection>(['agents']);
    const p1Tools = filterToolsByIntent(ORCHESTRATOR_TOOL_DEFINITIONS, sections, 1);
    const names = p1Tools.map(t => t.name);
    expect(names).toContain('run_agent');
    expect(names).toContain('list_agents');
  });

  it('P1 filter excludes P3 tools like workflow management', () => {
    const sections = new Set<IntentSection>(['agents']);
    const p1Tools = filterToolsByIntent(ORCHESTRATOR_TOOL_DEFINITIONS, sections, 1);
    const names = p1Tools.map(t => t.name);
    expect(names).not.toContain('list_workflows');
    expect(names).not.toContain('generate_workflow');
  });

  it('always includes update_plan regardless of priority', () => {
    const sections = new Set<IntentSection>(['agents']);
    const p1Tools = filterToolsByIntent(ORCHESTRATOR_TOOL_DEFINITIONS, sections, 1);
    const names = p1Tools.map(t => t.name);
    expect(names).toContain('update_plan');
  });

  it('no maxPriority returns all section-matched tools (backward compatible)', () => {
    const sections = new Set<IntentSection>(['agents']);
    const allTools = filterToolsByIntent(ORCHESTRATOR_TOOL_DEFINITIONS, sections);
    const p3Tools = filterToolsByIntent(ORCHESTRATOR_TOOL_DEFINITIONS, sections, 3);
    expect(allTools.length).toBe(p3Tools.length);
  });
});
