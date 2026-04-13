/**
 * Runtime Tool Registry
 *
 * Module-level singleton that holds dynamically-loaded tool handlers
 * outside the static `toolRegistry` Map. Static tools (the 130 or so
 * entries built at module load in `tools/registry.ts`) can't change at
 * runtime without a daemon restart. The runtime registry is the escape
 * hatch that lets the synthesis pipeline — or any future hot-reload
 * path — register a new tool and have both `LocalOrchestrator.getTools`
 * (which shapes the LLM prompt) and `tool-executor.executeToolCall`
 * (which dispatches the call) see it on the very next turn.
 *
 * Design notes
 *
 *   - This is deliberately a singleton, not a context-scoped object.
 *     The daemon loads skills once at boot; every LocalOrchestrator
 *     instance the daemon creates thereafter shares the same registry
 *     without plumbing constructor args through half the codebase.
 *
 *   - Handlers must match the existing `ToolHandler` signature so the
 *     tool executor can dispatch them with the exact same invocation
 *     shape as static tools: `handler(ctx.toolCtx, toolInput)`. No
 *     special casing at the call site.
 *
 *   - Probation flag is carried on the definition but not enforced
 *     here — it's consulted at prompt-build time so probationary
 *     tools can be hidden from the LLM unless synthesis debugging is
 *     enabled. The executor always dispatches a registered tool
 *     regardless of probation: if the LLM somehow finds the name,
 *     let it run (the generator already vetted the code).
 */

import type { ToolHandler } from './local-tool-types.js';

/**
 * Anthropic-compatible tool definition the LLM sees in its prompt.
 * Matches the shape used by `ORCHESTRATOR_TOOL_DEFINITIONS` entries
 * in `tool-definitions.ts` — name, description, input_schema.
 */
export interface RuntimeToolPromptShape {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface RuntimeToolDefinition extends RuntimeToolPromptShape {
  /** The actual function invoked by tool-executor at dispatch time. */
  handler: ToolHandler;
  /**
   * Primary key of the backing `agent_workforce_skills` row. Lets the
   * executor increment success_count / fail_count against the right
   * skill when a synthesized tool runs.
   */
  skillId: string;
  /**
   * Absolute path to the `.ts` source file on disk. The skill loader
   * uses this as the key for unload/reload when the file changes.
   */
  scriptPath: string;
  /**
   * True until the skill has earned enough live successes to be
   * trusted. Probation tools are hidden from the LLM prompt unless
   * `OHWOW_SYNTHESIS_DEBUG=1` is set, but they can still be executed
   * directly by name (e.g. by the synthesis tester).
   */
  probation: boolean;
}

/**
 * Thin wrapper around a Map with semantic methods. Kept as a class
 * (rather than a plain exported Map) so we can layer observability
 * and index-by-skillId lookups here later without touching call sites.
 */
class RuntimeToolRegistry {
  private readonly byName = new Map<string, RuntimeToolDefinition>();
  private readonly byScriptPath = new Map<string, string>();

  register(def: RuntimeToolDefinition): void {
    const existing = this.byName.get(def.name);
    if (existing && existing.scriptPath !== def.scriptPath) {
      throw new Error(
        `Runtime tool name collision: "${def.name}" is already registered from ${existing.scriptPath}, cannot register from ${def.scriptPath}`,
      );
    }
    this.byName.set(def.name, def);
    this.byScriptPath.set(def.scriptPath, def.name);
  }

  unregister(name: string): void {
    const def = this.byName.get(name);
    if (!def) return;
    this.byName.delete(name);
    this.byScriptPath.delete(def.scriptPath);
  }

  /** Remove by the `.ts` source path. Used by the file-watcher unlink path. */
  unregisterByScriptPath(scriptPath: string): void {
    const name = this.byScriptPath.get(scriptPath);
    if (name) this.unregister(name);
  }

  get(name: string): RuntimeToolDefinition | undefined {
    return this.byName.get(name);
  }

  list(): RuntimeToolDefinition[] {
    return Array.from(this.byName.values());
  }

  /**
   * Return just the Anthropic-compatible shape for every registered
   * tool, suitable for merging into the tool list passed to the model.
   * Probationary tools are excluded unless `includeProbation` is set.
   */
  getToolDefinitions(options: { includeProbation?: boolean } = {}): RuntimeToolPromptShape[] {
    const includeProbation =
      options.includeProbation ?? process.env.OHWOW_SYNTHESIS_DEBUG === '1';
    const defs: RuntimeToolPromptShape[] = [];
    for (const def of this.byName.values()) {
      if (def.probation && !includeProbation) continue;
      defs.push({
        name: def.name,
        description: def.description,
        input_schema: def.input_schema,
      });
    }
    return defs;
  }

  /** Test-only: wipe everything. */
  _clear(): void {
    this.byName.clear();
    this.byScriptPath.clear();
  }

  /** Observability: how many tools are currently registered. */
  size(): number {
    return this.byName.size;
  }
}

export const runtimeToolRegistry = new RuntimeToolRegistry();
