/**
 * HandlerSchemaDriftExperiment — wraps the E5 schema↔handler audit
 * (src/orchestrator/self-bench/schema-handler-audit.ts) as a scheduled
 * experiment so contract drift between tool schemas and their
 * handler bodies lands in the findings ledger automatically.
 *
 * What counts as drift:
 *   - major:  schema marks a property required but the handler never
 *             reads it. The model WILL trip this — passing the value
 *             and having it silently discarded is how S3.12 found
 *             `create_task.response_type`.
 *   - minor:  one-sided drift (declared_not_read OR read_not_declared).
 *             Design smell; not blocking.
 *   - clean:  the handler reads every required schema property and
 *             the declared surface matches the body.
 *
 * The audit walks the real tool registry + tool-definitions array at
 * probe time. It needs source files on disk — production daemons
 * that don't ship src/ cannot run this audit. When the registry file
 * or schema catalog is unreachable the probe returns a benign skip
 * row (pass) rather than erroring; operators running a dev-mode
 * daemon get the full audit.
 *
 * No intervene — contract mismatches are code-level bugs. The fix
 * is either editing the handler to read the field or editing the
 * schema to drop the declaration. Neither is safe to automate.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';

import type {
  Experiment,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import {
  runAudit,
  type HandlerAuditInput,
} from '../../orchestrator/self-bench/schema-handler-audit.js';
import {
  ORCHESTRATOR_TOOL_DEFINITIONS,
  COS_EXTENSION_TOOL_DEFINITIONS,
  LSP_TOOL_DEFINITIONS,
} from '../../orchestrator/tool-definitions.js';
import { logger } from '../../lib/logger.js';

/**
 * Resolve the repo root once at module load. The source file lives
 * at `src/self-bench/experiments/handler-schema-drift.ts`, so we
 * walk three levels up to reach the repo. When the compiled JS runs
 * from `dist/self-bench/experiments/`, three levels up lands on
 * `dist/`, not the repo — the probe detects this by looking for
 * `src/orchestrator/tools/registry.ts` and walking up further if
 * that file is missing. Two levels of fallback cover both shapes.
 */
function resolveRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../..'),
    resolve(here, '../../../..'),
    process.cwd(),
  ];
  for (const candidate of candidates) {
    try {
      statSync(join(candidate, 'src/orchestrator/tools/registry.ts'));
      return candidate;
    } catch { /* try next */ }
  }
  // No candidate has the source tree on disk. Fall back to cwd — the
  // probe will short-circuit with a skip finding when the registry
  // file can't be read.
  return process.cwd();
}

const REPO_ROOT = resolveRepoRoot();
const REGISTRY_FILE = join(REPO_ROOT, 'src/orchestrator/tools/registry.ts');
const TOOLS_SEARCH_DIRS = [
  join(REPO_ROOT, 'src/orchestrator/tools'),
  join(REPO_ROOT, 'src/execution/filesystem'),
  join(REPO_ROOT, 'src/execution/bash'),
];

interface RegistryEntry {
  tool: string;
  handlerExportName: string;
}

/** Parse `['tool_name', (ctx, input) => handlerFn(ctx, input)],` rows. */
function parseRegistry(source: string): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  const re = /^\s*\['([a-z_]+)',\s*\([^)]*\)\s*=>\s*([a-zA-Z_]+)\s*\(/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    entries.push({ tool: match[1], handlerExportName: match[2] });
  }
  return entries;
}

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
      if (st.isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}

function findHandlerFile(handlerExportName: string): string | null {
  const needles = [
    `export async function ${handlerExportName}(`,
    `export function ${handlerExportName}(`,
    `export const ${handlerExportName}:`,
    `export const ${handlerExportName} =`,
    `export const ${handlerExportName}=`,
  ];
  for (const dir of TOOLS_SEARCH_DIRS) {
    for (const file of listSourceFiles(dir)) {
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

const ALL_SCHEMAS: Tool[] = [
  ...ORCHESTRATOR_TOOL_DEFINITIONS,
  ...COS_EXTENSION_TOOL_DEFINITIONS,
  ...LSP_TOOL_DEFINITIONS,
];

function extractSchemaShape(tool: Tool): { properties: string[]; required: string[] } | null {
  const schema = tool.input_schema as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined;
  if (!schema) return null;
  return {
    properties: schema.properties ? Object.keys(schema.properties) : [],
    required: Array.isArray(schema.required) ? schema.required : [],
  };
}

interface SchemaDriftEvidence extends Record<string, unknown> {
  total: number;
  clean: number;
  minor: number;
  major: number;
  skipped: number;
  majors: Array<{ tool: string; required_not_read: string[]; verdict: string }>;
  minors: Array<{ tool: string; verdict: string }>;
  unresolved: string[];
  missing_schemas: string[];
  skip_reason: string | null;
}

function emptyEvidence(skipReason: string | null): SchemaDriftEvidence {
  return {
    total: 0,
    clean: 0,
    minor: 0,
    major: 0,
    skipped: 0,
    majors: [],
    minors: [],
    unresolved: [],
    missing_schemas: [],
    skip_reason: skipReason,
  };
}

export class HandlerSchemaDriftExperiment implements Experiment {
  id = 'handler-schema-drift';
  name = 'Tool handler schema↔body contract audit';
  category = 'handler_audit' as const;
  hypothesis =
    'Every tool handler reads the input fields its declared schema marks as required, and the declared surface matches what the handler body actually touches — no required-not-read, no read-not-declared.';
  cadence = { everyMs: 24 * 60 * 60 * 1000, runOnBoot: false };

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    let registrySource: string;
    try {
      registrySource = readFileSync(REGISTRY_FILE, 'utf-8');
    } catch (err) {
      logger.debug({ err, REGISTRY_FILE }, '[handler-schema-drift] registry not readable');
      return {
        subject: null,
        summary: 'skipped — tool registry source not on disk (non-dev daemon)',
        evidence: emptyEvidence('registry source not readable'),
      };
    }

    const registryEntries = parseRegistry(registrySource);
    const inputs: HandlerAuditInput[] = [];
    const unresolved: string[] = [];
    const missingSchema: string[] = [];

    for (const { tool, handlerExportName } of registryEntries) {
      const schemaTool = ALL_SCHEMAS.find((t) => t.name === tool);
      if (!schemaTool) {
        missingSchema.push(tool);
        continue;
      }
      const shape = extractSchemaShape(schemaTool);
      if (!shape) {
        missingSchema.push(`${tool} (unparseable)`);
        continue;
      }
      const handlerFile = findHandlerFile(handlerExportName);
      if (!handlerFile) {
        unresolved.push(`${tool} → ${handlerExportName}`);
        continue;
      }
      inputs.push({
        tool,
        schemaProperties: shape.properties,
        schemaRequired: shape.required,
        handlerFile,
        handlerExportName,
      });
    }

    const run = runAudit(inputs);

    const majors = run.results
      .filter((r) => r.handlerFound && r.severity === 'major')
      .map((r) => ({
        tool: r.tool,
        required_not_read: r.requiredNotRead,
        verdict: r.verdict,
      }));
    const minors = run.results
      .filter((r) => r.handlerFound && r.severity === 'minor')
      .map((r) => ({ tool: r.tool, verdict: r.verdict }));

    const evidence: SchemaDriftEvidence = {
      total: run.summary.total,
      clean: run.summary.clean,
      minor: run.summary.minor,
      major: run.summary.major,
      skipped: run.summary.skipped,
      majors,
      minors,
      unresolved,
      missing_schemas: missingSchema,
      skip_reason: null,
    };

    const summary = run.summary.major > 0
      ? `${run.summary.major} major contract mismatch(es) — required schema field never read by handler`
      : run.summary.minor > 0
        ? `${run.summary.minor} minor drift(s); ${run.summary.clean} clean of ${run.summary.total}`
        : `all ${run.summary.total} handler(s) clean`;

    const subject = majors.length > 0
      ? `handler:${majors[0].tool}`
      : minors.length > 0
        ? `handler:${minors[0].tool}`
        : null;

    return { subject, summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as SchemaDriftEvidence;
    if (ev.skip_reason) return 'pass';
    if (ev.major > 0) return 'fail';
    if (ev.minor > 0) return 'warning';
    return 'pass';
  }
}
