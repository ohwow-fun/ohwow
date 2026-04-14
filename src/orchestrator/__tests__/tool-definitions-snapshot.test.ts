import { describe, it, expect } from 'vitest';
import {
  ORCHESTRATOR_TOOL_DEFINITIONS,
  LSP_TOOL_DEFINITIONS,
  COS_EXTENSION_TOOL_DEFINITIONS,
  filterToolsByIntent,
  type IntentSection,
} from '../tool-definitions.js';

const ALL_INTENT_SECTIONS: IntentSection[] = [
  'pulse',
  'agents',
  'projects',
  'business',
  'memory',
  'rag',
  'vision',
  'filesystem',
  'channels',
  'browser',
  'desktop',
  'project_instructions',
  'dev',
];

const UNION_TOOLS = [
  ...ORCHESTRATOR_TOOL_DEFINITIONS,
  ...LSP_TOOL_DEFINITIONS,
  ...COS_EXTENSION_TOOL_DEFINITIONS,
];

describe('tool-definitions snapshot (regression net for refactor)', () => {
  it('ORCHESTRATOR_TOOL_DEFINITIONS preserves tool names and source order', () => {
    expect(ORCHESTRATOR_TOOL_DEFINITIONS.map((t) => t.name)).toMatchSnapshot();
  });

  it('LSP_TOOL_DEFINITIONS preserves tool names and source order', () => {
    expect(LSP_TOOL_DEFINITIONS.map((t) => t.name)).toMatchSnapshot();
  });

  it('COS_EXTENSION_TOOL_DEFINITIONS preserves tool names and source order', () => {
    expect(COS_EXTENSION_TOOL_DEFINITIONS.map((t) => t.name)).toMatchSnapshot();
  });

  it('union catalog tool count', () => {
    expect({
      orchestrator: ORCHESTRATOR_TOOL_DEFINITIONS.length,
      lsp: LSP_TOOL_DEFINITIONS.length,
      cosExtension: COS_EXTENSION_TOOL_DEFINITIONS.length,
      union: UNION_TOOLS.length,
    }).toMatchSnapshot();
  });

  it('always-included set (filter with empty intent)', () => {
    const result = filterToolsByIntent(UNION_TOOLS, new Set<IntentSection>())
      .map((t) => t.name)
      .sort();
    expect(result).toMatchSnapshot();
  });

  for (const section of ALL_INTENT_SECTIONS) {
    it(`filterToolsByIntent('${section}') is stable`, () => {
      const result = filterToolsByIntent(UNION_TOOLS, new Set<IntentSection>([section]))
        .map((t) => t.name)
        .sort();
      expect(result).toMatchSnapshot();
    });
  }

  for (const priority of [1, 2, 3] as const) {
    it(`filterToolsByIntent('agents', maxPriority=${priority}) is stable`, () => {
      const result = filterToolsByIntent(
        UNION_TOOLS,
        new Set<IntentSection>(['agents']),
        priority,
      )
        .map((t) => t.name)
        .sort();
      expect(result).toMatchSnapshot();
    });
  }

  it('explicit-tool-name bypass surfaces a non-mapped tool', () => {
    const result = filterToolsByIntent(
      UNION_TOOLS,
      new Set<IntentSection>(),
      1,
      new Set(['list_workflows']),
    ).map((t) => t.name);
    expect(result).toContain('list_workflows');
  });
});
