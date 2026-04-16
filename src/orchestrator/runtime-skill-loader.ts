/**
 * Runtime Skill Loader
 *
 * Walks a workspace's skills directory, compiles every `.ts` file it
 * finds with esbuild, dynamic-imports the resulting `.mjs`, validates
 * the module exports match the runtime-tool shape, and registers the
 * handler with `runtimeToolRegistry`. Then it parks a `fs.watch` on
 * the directory so any add/change/unlink flushes through the same
 * pipeline without a daemon restart.
 *
 * Why esbuild instead of ts-node or the TypeScript compiler API: the
 * runtime is already production-bundled via tsup → esbuild; adding
 * ts-node would pull the full TS toolchain into a published npm
 * package for no additional safety. esbuild's `build()` returns a
 * plain ESM JS file we can dynamic-import with the native loader.
 *
 * Why `.mjs` output: Node picks the ESM loader by file extension, so
 * a `.mjs` output file is always parsed as a module regardless of the
 * package's `type` field. Removes one class of "it works in dev but
 * crashes when ohwow is installed globally" bugs.
 *
 * Why cache-bust the dynamic import: Node caches `import()` results
 * by specifier. A bare `await import(path)` after a file edit would
 * return the stale module. Appending `?v=<mtime>` to the specifier
 * forces a fresh load on every watcher event.
 *
 * The loader holds no skill rows in memory — the `agent_workforce_skills`
 * row is the system of record for `skill_id`, `probation`, counters,
 * etc. This module looks those up via the DB adapter lazily at load
 * time so a hand-edited `.ts` file without a matching row just gets
 * rejected (we don't invent rows from the filesystem).
 */

import { build as esbuildBuild } from 'esbuild';
import { watch, type FSWatcher, existsSync, symlinkSync } from 'node:fs';
import { mkdir, readdir, stat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';
import {
  runtimeToolRegistry,
  type RuntimeToolDefinition,
} from './runtime-tool-registry.js';
import type { ToolHandler } from './local-tool-types.js';

/**
 * Ensure a `node_modules` symlink exists inside the compiled-skills
 * directory so Node's ESM resolver can find `playwright-core` (and
 * anything else the ohwow runtime bundles) from the compiled `.mjs`
 * files. Without this, `import 'playwright-core'` inside a skill
 * resolves relative to the .compiled/ dir, walks upward looking for
 * `node_modules`, and fails with ERR_MODULE_NOT_FOUND because the
 * workspace data dir never contained one.
 *
 * We find the ohwow runtime's node_modules by asking createRequire
 * to resolve a known dep (`playwright-core`) from the loader module
 * itself, then walking the resolved path upward to the nearest
 * `node_modules` ancestor. That directory is the target of the
 * symlink. No hardcoded paths — works from both `src/` during dev
 * and `dist/` in a published install.
 */
function ensureNodeModulesSymlink(compiledDir: string): void {
  const linkPath = join(compiledDir, 'node_modules');
  if (existsSync(linkPath)) return;
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve('playwright-core');
    // Walk up until we hit a path segment named 'node_modules'.
    let cursor = dirname(resolved);
    while (cursor !== dirname(cursor)) {
      if (basename(cursor) === 'node_modules') {
        symlinkSync(cursor, linkPath, 'dir');
        logger.info(
          { linkPath, target: cursor },
          '[runtime-skill-loader] created node_modules symlink for skill imports',
        );
        return;
      }
      cursor = dirname(cursor);
    }
    logger.warn(
      { resolved, compiledDir },
      '[runtime-skill-loader] could not find node_modules ancestor of playwright-core — skill imports may fail',
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, compiledDir },
      '[runtime-skill-loader] failed to create node_modules symlink',
    );
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LoadedModule {
  definition?: {
    name?: unknown;
    description?: unknown;
    input_schema?: unknown;
  };
  handler?: unknown;
}

export interface RuntimeSkillLoaderOptions {
  /**
   * Absolute path to `~/.ohwow/workspaces/<name>/skills`. Created on
   * start if missing.
   */
  skillsDir: string;
  /**
   * Absolute path to `<skillsDir>/.compiled`. Created on start if
   * missing. Skill sources compile into here one-to-one.
   */
  compiledDir: string;
  db: DatabaseAdapter;
  workspaceId: string;
}

// ---------------------------------------------------------------------------
// Filename ↔ tool name mapping
// ---------------------------------------------------------------------------

/**
 * Turn `post_tweet-abc123.ts` into the slug the registry uses as the
 * cache-key. Not the tool's `name` field (that comes from the
 * exported definition) — this is just an internal identifier for
 * "which file is this handler from?".
 */
function slugForPath(tsPath: string): string {
  return basename(tsPath, extname(tsPath));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateLoadedModule(mod: LoadedModule, scriptPath: string):
  | { ok: true; def: { name: string; description: string; input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] } }; handler: ToolHandler }
  | { ok: false; reason: string } {
  if (!mod || !isPlainObject(mod.definition)) {
    return { ok: false, reason: `${scriptPath} missing required export \`definition\`` };
  }
  const def = mod.definition;
  if (typeof def.name !== 'string' || !def.name) {
    return { ok: false, reason: `${scriptPath} definition.name must be a non-empty string` };
  }
  if (typeof def.description !== 'string' || !def.description) {
    return { ok: false, reason: `${scriptPath} definition.description must be a non-empty string` };
  }
  if (!isPlainObject(def.input_schema)) {
    return { ok: false, reason: `${scriptPath} definition.input_schema must be an object` };
  }
  const schema = def.input_schema as Record<string, unknown>;
  if (schema.type !== 'object') {
    return { ok: false, reason: `${scriptPath} definition.input_schema.type must be 'object'` };
  }
  if (!isPlainObject(schema.properties)) {
    return { ok: false, reason: `${scriptPath} definition.input_schema.properties must be an object` };
  }
  if (typeof mod.handler !== 'function') {
    return { ok: false, reason: `${scriptPath} missing required export \`handler\` (function)` };
  }
  return {
    ok: true,
    def: {
      name: def.name,
      description: def.description,
      input_schema: {
        type: 'object',
        properties: schema.properties as Record<string, unknown>,
        required: Array.isArray(schema.required) ? (schema.required as string[]) : undefined,
      },
    },
    handler: mod.handler as ToolHandler,
  };
}

// ---------------------------------------------------------------------------
// Static safety lint
// ---------------------------------------------------------------------------

/**
 * Scan the raw source for imports and globals we never want a
 * synthesized skill to use. This is defense-in-depth on top of the
 * generator's allowlist. The runtime loader refuses to compile a file
 * that names any forbidden surface, so a hand-edit (or an LLM that
 * slipped past the generator lint) can't introduce child_process,
 * net, raw fs.unlink, etc.
 *
 * Deliberately regex-based, not AST-based — the point is a conservative
 * deny-list, not a full type system. False positives here are a fine
 * trade: a skill that looks suspicious should fail loud at load time.
 */
export const FORBIDDEN_SOURCE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bchild_process\b/, reason: 'child_process is not allowed in synthesized skills' },
  { pattern: /\bnode:child_process\b/, reason: 'node:child_process is not allowed' },
  { pattern: /\bprocess\.exit\b/, reason: 'process.exit is not allowed' },
  { pattern: /\beval\s*\(/, reason: 'eval() is not allowed' },
  { pattern: /\bnew\s+Function\s*\(/, reason: 'new Function() is not allowed' },
  { pattern: /\bnode:vm\b/, reason: 'node:vm is not allowed' },
  { pattern: /\brequire\s*\(/, reason: 'CommonJS require() is not allowed (use ESM imports)' },
  { pattern: /\bfs\.unlink|fs\.rm\b|fs\.rmdir\b/, reason: 'destructive fs operations are not allowed' },
  { pattern: /\bnode:net\b|\bnode:dgram\b|\bnode:http\s/, reason: 'raw network sockets are not allowed (use fetch)' },
  // Chrome-profile pinning: in a multi-profile debug Chrome the first
  // enumerated BrowserContext is NOT the signed-in profile on most
  // machines. `.contexts()[0]` / `.contexts()[ 0 ]` and `context.newPage()`
  // silently land on the wrong profile and then `goto('https://x.com/...')`
  // renders a logged-out window — confirmed live 2026-04-16 as the driver
  // behind the "unauthed chromium tried to post to X" loop. Synthesized
  // skills that touch playwright-core MUST flatten pages across contexts
  // (or pin via the routing helper) instead. This rejects the anti-pattern
  // at load time so stale skill files from older template generations
  // never get registered.
  {
    pattern: /\.contexts\s*\(\s*\)\s*\[\s*0\s*\]/,
    reason: '.contexts()[0] is not allowed — it picks an arbitrary Chrome profile. Flatten with `browser.contexts().flatMap((c) => c.pages())` and pick by URL.',
  },
  {
    pattern: /\.newPage\s*\(\s*\)/,
    reason: 'context.newPage() creates a tab in an arbitrary Chrome profile — refuse. Let the orchestrator open a profile-pinned tab and reuse an existing page instead.',
  },
];

/**
 * Scan a TypeScript skill source for forbidden patterns. Exported so
 * the synthesis generator can lint its own output before writing a
 * single byte to disk — defense in depth on top of the lint that runs
 * here at load time.
 */
export function lintSkillSource(
  source: string,
  scriptPath: string,
): { ok: true } | { ok: false; reason: string } {
  for (const { pattern, reason } of FORBIDDEN_SOURCE_PATTERNS) {
    if (pattern.test(source)) {
      return { ok: false, reason: `${scriptPath}: ${reason}` };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Module-scoped pointer to the currently-running loader instance.
 * The daemon only ever creates one per process, so one slot is enough.
 * Exposed so the synthesis generator can trigger an immediate load
 * after writing a new `.ts` file without waiting for the fs.watch
 * debounce — the generator imports `getActiveRuntimeSkillLoader()`
 * and calls `.loadFile(path)` synchronously in line.
 *
 * The setter is a free function (not a `const self = this` pattern
 * inside the class) so the @typescript-eslint/no-this-alias rule
 * stays quiet without disable comments. The class's `start`/`stop`
 * forward `this` as a call argument, which is idiomatic.
 */
let activeLoader: RuntimeSkillLoader | null = null;

export function getActiveRuntimeSkillLoader(): RuntimeSkillLoader | null {
  return activeLoader;
}

function setActiveLoader(loader: RuntimeSkillLoader | null): void {
  activeLoader = loader;
}

function isActiveLoader(loader: RuntimeSkillLoader): boolean {
  return activeLoader === loader;
}

export class RuntimeSkillLoader {
  private watcher: FSWatcher | null = null;
  private started = false;
  /** Debounce map: slug → timeout handle. fs.watch fires twice per write on some platforms. */
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly opts: RuntimeSkillLoaderOptions) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    setActiveLoader(this);

    await mkdir(this.opts.skillsDir, { recursive: true });
    await mkdir(this.opts.compiledDir, { recursive: true });
    ensureNodeModulesSymlink(this.opts.compiledDir);

    // Initial scan: load every .ts file that already exists.
    try {
      const entries = await readdir(this.opts.skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || extname(entry.name) !== '.ts') continue;
        const tsPath = resolve(this.opts.skillsDir, entry.name);
        await this.loadFile(tsPath).catch((err) => {
          logger.warn(
            { err: err instanceof Error ? err.message : err, tsPath },
            '[runtime-skill-loader] initial load failed',
          );
        });
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, skillsDir: this.opts.skillsDir },
        '[runtime-skill-loader] initial scan failed',
      );
    }

    // Watch for changes. Non-recursive on purpose — the `.compiled/`
    // subdir should never trigger reload events.
    try {
      this.watcher = watch(this.opts.skillsDir, { persistent: false }, (eventType, fileName) => {
        if (!fileName) return;
        if (extname(fileName) !== '.ts') return;
        const slug = slugForPath(fileName);
        const existing = this.pending.get(slug);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          this.pending.delete(slug);
          const fullPath = resolve(this.opts.skillsDir, fileName);
          this.handleWatcherEvent(eventType, fullPath).catch((err) => {
            logger.warn(
              { err: err instanceof Error ? err.message : err, fullPath, eventType },
              '[runtime-skill-loader] watcher handler crashed',
            );
          });
        }, 120);
        this.pending.set(slug, timer);
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, skillsDir: this.opts.skillsDir },
        '[runtime-skill-loader] could not start fs.watch',
      );
    }

    logger.info(
      { skillsDir: this.opts.skillsDir, registered: runtimeToolRegistry.size() },
      '[runtime-skill-loader] started',
    );
  }

  stop(): void {
    if (!this.started) return;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.watcher?.close();
    this.watcher = null;
    this.started = false;
    if (isActiveLoader(this)) setActiveLoader(null);
  }

  /** Test-only: directly set this instance as the active loader. */
  _setAsActive(): void {
    setActiveLoader(this);
  }

  private async handleWatcherEvent(eventType: string, tsPath: string): Promise<void> {
    // `fs.watch` fires `rename` when a file is created OR deleted, and
    // `change` when its contents change. We disambiguate by checking
    // whether the file currently exists.
    try {
      await stat(tsPath);
    } catch {
      runtimeToolRegistry.unregisterByScriptPath(tsPath);
      logger.info({ tsPath }, '[runtime-skill-loader] skill unregistered (file gone)');
      return;
    }
    await this.loadFile(tsPath);
  }

  /**
   * Compile one `.ts` file to `.mjs`, dynamic-import it, validate the
   * shape, and register with the runtime tool registry. Also resolves
   * the backing `agent_workforce_skills` row to attach skill_id +
   * probation to the definition. If the skill row is missing, the
   * tool is NOT registered — we refuse to surface a handler that has
   * no persistent record.
   */
  async loadFile(tsPath: string): Promise<void> {
    const slug = slugForPath(tsPath);

    const source = await readFile(tsPath, 'utf8');
    const lint = lintSkillSource(source, tsPath);
    if (!lint.ok) {
      logger.error({ tsPath, reason: lint.reason }, '[runtime-skill-loader] lint rejected');
      runtimeToolRegistry.unregisterByScriptPath(tsPath);
      return;
    }

    const outFile = join(this.opts.compiledDir, `${slug}.mjs`);
    try {
      await esbuildBuild({
        entryPoints: [tsPath],
        outfile: outFile,
        bundle: false,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        sourcemap: 'inline',
        logLevel: 'silent',
      });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err, tsPath },
        '[runtime-skill-loader] esbuild compile failed',
      );
      return;
    }

    const mtime = (await stat(outFile)).mtimeMs;
    const specifier = `${pathToFileURL(outFile).href}?v=${mtime}`;
    let loaded: LoadedModule;
    try {
      loaded = (await import(specifier)) as LoadedModule;
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err, outFile, specifier },
        '[runtime-skill-loader] dynamic import failed',
      );
      return;
    }

    const validated = validateLoadedModule(loaded, tsPath);
    if (!validated.ok) {
      logger.error({ tsPath, reason: validated.reason }, '[runtime-skill-loader] invalid shape');
      return;
    }

    const skillRow = await this.findSkillRow(tsPath);
    if (!skillRow) {
      logger.warn(
        { tsPath, name: validated.def.name },
        '[runtime-skill-loader] no agent_workforce_skills row for script, skipping',
      );
      return;
    }

    const def: RuntimeToolDefinition = {
      ...validated.def,
      handler: validated.handler,
      skillId: skillRow.id,
      scriptPath: tsPath,
      probation: !skillRow.promoted_at,
    };

    // If a different slug previously owned this tool name, unregister
    // it first so the Map throws only on genuine collisions.
    const existingByName = runtimeToolRegistry.get(def.name);
    if (existingByName && existingByName.scriptPath !== tsPath) {
      logger.warn(
        { name: def.name, oldPath: existingByName.scriptPath, newPath: tsPath },
        '[runtime-skill-loader] tool name collision, replacing',
      );
      runtimeToolRegistry.unregister(def.name);
    }

    runtimeToolRegistry.register(def);
    logger.info(
      { name: def.name, skillId: def.skillId, probation: def.probation, tsPath },
      '[runtime-skill-loader] skill registered',
    );
  }

  private async findSkillRow(
    tsPath: string,
  ): Promise<{ id: string; promoted_at: string | null } | null> {
    const result = await this.opts.db
      .from('agent_workforce_skills')
      .select('id, promoted_at')
      .eq('workspace_id', this.opts.workspaceId)
      .eq('script_path', tsPath)
      .eq('skill_type', 'code')
      .eq('is_active', 1)
      .limit(1);
    const rows = (result.data ?? []) as Array<{ id: string; promoted_at: string | null }>;
    return rows[0] ?? null;
  }
}
