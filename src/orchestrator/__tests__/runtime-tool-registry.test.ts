import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  runtimeToolRegistry,
  type RuntimeToolDefinition,
} from '../runtime-tool-registry.js';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';

function makeDef(partial: Partial<RuntimeToolDefinition>): RuntimeToolDefinition {
  return {
    name: 'example_skill',
    description: 'example',
    input_schema: { type: 'object', properties: {}, required: [] },
    handler: (_ctx: LocalToolContext) => ({ success: true } as ToolResult),
    skillId: 'sk-1',
    scriptPath: '/tmp/example_skill.ts',
    probation: false,
    ...partial,
  };
}

describe('runtimeToolRegistry', () => {
  afterEach(() => {
    runtimeToolRegistry._clear();
    delete process.env.OHWOW_SYNTHESIS_DEBUG;
  });

  it('registers and retrieves a tool by name', () => {
    const def = makeDef({});
    runtimeToolRegistry.register(def);
    expect(runtimeToolRegistry.get('example_skill')).toBe(def);
    expect(runtimeToolRegistry.size()).toBe(1);
  });

  it('unregisters by name', () => {
    runtimeToolRegistry.register(makeDef({}));
    runtimeToolRegistry.unregister('example_skill');
    expect(runtimeToolRegistry.get('example_skill')).toBeUndefined();
    expect(runtimeToolRegistry.size()).toBe(0);
  });

  it('unregisters by script path', () => {
    runtimeToolRegistry.register(makeDef({ scriptPath: '/skills/foo.ts' }));
    runtimeToolRegistry.unregisterByScriptPath('/skills/foo.ts');
    expect(runtimeToolRegistry.get('example_skill')).toBeUndefined();
  });

  it('throws on name collision across different script paths', () => {
    runtimeToolRegistry.register(makeDef({ scriptPath: '/skills/a.ts' }));
    expect(() =>
      runtimeToolRegistry.register(makeDef({ scriptPath: '/skills/b.ts' })),
    ).toThrow(/collision/);
  });

  it('allows re-registration from the same script path (hot reload)', () => {
    runtimeToolRegistry.register(makeDef({ scriptPath: '/skills/a.ts', description: 'v1' }));
    runtimeToolRegistry.register(makeDef({ scriptPath: '/skills/a.ts', description: 'v2' }));
    expect(runtimeToolRegistry.get('example_skill')?.description).toBe('v2');
  });

  it('hides probation skills from getToolDefinitions by default', () => {
    runtimeToolRegistry.register(makeDef({ name: 'stable', probation: false, scriptPath: '/a.ts' }));
    runtimeToolRegistry.register(makeDef({ name: 'probationary', probation: true, scriptPath: '/b.ts' }));
    const defs = runtimeToolRegistry.getToolDefinitions();
    expect(defs.map((d) => d.name)).toEqual(['stable']);
  });

  it('surfaces probation skills when OHWOW_SYNTHESIS_DEBUG=1', () => {
    process.env.OHWOW_SYNTHESIS_DEBUG = '1';
    runtimeToolRegistry.register(makeDef({ name: 'stable', probation: false, scriptPath: '/a.ts' }));
    runtimeToolRegistry.register(makeDef({ name: 'probationary', probation: true, scriptPath: '/b.ts' }));
    const defs = runtimeToolRegistry.getToolDefinitions();
    expect(defs.map((d) => d.name).sort()).toEqual(['probationary', 'stable']);
  });

  it('surfaces probation skills when explicitly requested via options', () => {
    runtimeToolRegistry.register(makeDef({ name: 'probationary', probation: true, scriptPath: '/b.ts' }));
    const defs = runtimeToolRegistry.getToolDefinitions({ includeProbation: true });
    expect(defs.map((d) => d.name)).toEqual(['probationary']);
  });

  it('getToolDefinitions returns only the Anthropic-compatible fields', () => {
    const spy = vi.fn();
    runtimeToolRegistry.register(
      makeDef({
        handler: spy,
        skillId: 'sk-xyz',
        scriptPath: '/p.ts',
        probation: false,
      }),
    );
    const [def] = runtimeToolRegistry.getToolDefinitions();
    expect(def).toEqual({
      name: 'example_skill',
      description: 'example',
      input_schema: { type: 'object', properties: {}, required: [] },
    });
    expect(def).not.toHaveProperty('handler');
    expect(def).not.toHaveProperty('skillId');
    expect(def).not.toHaveProperty('probation');
    expect(spy).not.toHaveBeenCalled();
  });
});
