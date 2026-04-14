/**
 * Live pass of the schema↔handler audit. Enumerates every entry in
 * the real `toolRegistry`, resolves each handler to its source
 * file, looks up its declared schema from ORCHESTRATOR_TOOL_DEFINITIONS
 * + COS_EXTENSION_TOOL_DEFINITIONS + LSP_TOOL_DEFINITIONS, and runs
 * the AST walker over every pair.
 *
 * This test is designed to FAIL with a structured report whenever
 * the audit finds a major contract mismatch (required field never
 * read). Minor findings (declared_not_read, read_not_declared) are
 * printed but don't fail the test — they're design smells that
 * warrant a separate cleanup commit rather than a bench stop.
 *
 * Skipped by default. Set OHWOW_BENCH_LIVE=1 to run:
 *
 *   OHWOW_BENCH_LIVE=1 npx vitest run src/orchestrator/self-bench/__tests__/schema-handler-audit-live.test.ts
 *
 * The enumeration resolves handler source locations by reading
 * `src/orchestrator/tools/registry.ts` directly and matching
 * `['tool_name', (ctx, input) => handlerFn(ctx, input)]` pairs,
 * then greps the `tools/` directory for the handler's export. This
 * is the same approach the S3.12 bug-bounty bench used manually;
 * making it automatic is the whole point of E5.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';

import { runAudit, formatAuditReport, type HandlerAuditInput } from '../schema-handler-audit.js';
import { ORCHESTRATOR_TOOL_DEFINITIONS, COS_EXTENSION_TOOL_DEFINITIONS, LSP_TOOL_DEFINITIONS } from '../../tool-definitions.js';

const LIVE = process.env.OHWOW_BENCH_LIVE === '1';

const REPO_ROOT = resolve(__dirname, '../../../..');
const REGISTRY_FILE = join(REPO_ROOT, 'src/orchestrator/tools/registry.ts');
const TOOLS_SEARCH_DIRS = [
  join(REPO_ROOT, 'src/orchestrator/tools'),
  join(REPO_ROOT, 'src/execution/filesystem'),
  join(REPO_ROOT, 'src/execution/bash'),
];

// ----------------------------------------------------------------------
// REGISTRY PARSE — extract tool_name → handler_export_name mapping
// ----------------------------------------------------------------------

interface RegistryEntry {
  tool: string;
  handlerExportName: string;
}

/**
 * Parse registry.ts lines of the shape:
 *
 *   ['list_agents', (ctx) => listAgents(ctx)],
 *   ['update_agent_status', (ctx, input) => updateAgentStatus(ctx, input)],
 *   ['openclaw_list_skills', (ctx) => openclawListSkills(ctx, {})],
 *
 * The capture group grabs the function name that the arrow body
 * calls. That's the exported symbol we pass to the AST walker.
 */
function parseRegistry(source: string): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  const re = /^\s*\['([a-z_]+)',\s*\([^)]*\)\s*=>\s*([a-zA-Z_]+)\s*\(/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    entries.push({ tool: match[1], handlerExportName: match[2] });
  }
  return entries;
}

// ----------------------------------------------------------------------
// HANDLER FILE DISCOVERY — find the .ts file that exports the symbol
// ----------------------------------------------------------------------

/**
 * Walk a directory recursively, collecting all `.ts` source files
 * (skipping `__tests__/` and `.test.ts` files — handlers never live
 * there and test mocks would produce noise).
 */
function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === '__tests__' || name === 'node_modules') continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Find the file that exports `handlerExportName`. Looks for either
 * `export async function handlerExportName` or
 * `export const handlerExportName` patterns. First hit wins.
 */
function findHandlerFile(handlerExportName: string, searchDirs: string[]): string | null {
  const needles = [
    `export async function ${handlerExportName}(`,
    `export function ${handlerExportName}(`,
    `export const ${handlerExportName}:`,
    `export const ${handlerExportName} =`,
    `export const ${handlerExportName}=`,
  ];
  for (const dir of searchDirs) {
    const files = listSourceFiles(dir);
    for (const file of files) {
      let content: string;
      try {
        content = readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      if (needles.some((n) => content.includes(n))) return file;
    }
  }
  return null;
}

// ----------------------------------------------------------------------
// SCHEMA LOOKUP — find a tool by name across all definition arrays
// ----------------------------------------------------------------------

const ALL_SCHEMAS: Tool[] = [
  ...ORCHESTRATOR_TOOL_DEFINITIONS,
  ...COS_EXTENSION_TOOL_DEFINITIONS,
  ...LSP_TOOL_DEFINITIONS,
];

interface SchemaShape {
  properties: string[];
  required: string[];
}

function extractSchemaShape(tool: Tool): SchemaShape | null {
  const schema = tool.input_schema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  if (!schema) return null;
  const properties = schema.properties ? Object.keys(schema.properties) : [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  return { properties, required };
}

// ----------------------------------------------------------------------
// TEST
// ----------------------------------------------------------------------

describe.skipIf(!LIVE)('schema↔handler audit against the live tool catalog', () => {
  it('reports every major contract mismatch with a structured verdict', () => {
    const registrySource = readFileSync(REGISTRY_FILE, 'utf-8');
    const registryEntries = parseRegistry(registrySource);

    expect(registryEntries.length).toBeGreaterThan(100);

    const auditInputs: HandlerAuditInput[] = [];
    const unresolved: string[] = [];
    const missingSchema: string[] = [];

    for (const { tool, handlerExportName } of registryEntries) {
      const toolSchema = ALL_SCHEMAS.find((t) => t.name === tool);
      if (!toolSchema) {
        // Missing schema is its own class of finding — the S3.12
        // bug-bounty pattern. The audit test isn't the right place
        // to fail on it (we already have commit 031942d covering
        // that), but we log it for visibility.
        missingSchema.push(tool);
        continue;
      }
      const shape = extractSchemaShape(toolSchema);
      if (!shape) {
        missingSchema.push(`${tool} (schema present but unparseable)`);
        continue;
      }

      const handlerFile = findHandlerFile(handlerExportName, TOOLS_SEARCH_DIRS);
      if (!handlerFile) {
        unresolved.push(`${tool} → ${handlerExportName}`);
        continue;
      }

      auditInputs.push({
        tool,
        schemaProperties: shape.properties,
        schemaRequired: shape.required,
        handlerFile,
        handlerExportName,
      });
    }

    if (missingSchema.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`\n[audit] ${missingSchema.length} tools in the registry had no schema: ${missingSchema.join(', ')}`);
    }
    if (unresolved.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`\n[audit] ${unresolved.length} handlers could not be resolved to a source file: ${unresolved.join(', ')}`);
    }

    const run = runAudit(auditInputs);

    // eslint-disable-next-line no-console
    console.log('\n' + formatAuditReport(run) + '\n');

    // Surface-level summary for the test output
    // eslint-disable-next-line no-console
    console.log(
      `[audit summary] total=${run.summary.total} clean=${run.summary.clean} minor=${run.summary.minor} ` +
      `major=${run.summary.major} skipped=${run.summary.skipped}\n`,
    );

    // The assertion: zero MAJOR findings. Minor findings are printed
    // above but don't fail the test — they're design smells to
    // clean up in a separate commit cycle rather than a bench stop.
    expect(
      run.summary.major,
      `schema↔handler audit found ${run.summary.major} major contract mismatches (required field declared but never read). See report above.`,
    ).toBe(0);
  });
});
