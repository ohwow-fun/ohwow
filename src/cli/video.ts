/* eslint-disable no-console */
/**
 * `ohwow video` subcommand.
 *
 *   ohwow video render <spec.json> [--out=<path>]   direct render (no DB, no skill)
 *   ohwow video generate <spec.json> [--out=<path>] full skill path; progress + stored MP4
 *   ohwow video cache ls [--modality=<m>]           list cached assets
 *   ohwow video cache prune --older-than=<days>     evict old cache entries
 *
 * Kept deliberately thin — the CLI is for authors and CI. Agent-driven
 * generation flows through the `generate_video_from_spec` orchestrator tool.
 */

import { isAbsolute, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { runVideoGeneration, type VideoSkillProgress } from '../execution/skills/video_generation.js';
import { list as listCache, prune as pruneCache, type CacheModality } from '../media/asset-cache.js';
import {
  authorWorkspaceVideoSpec,
  BUILTIN_TEMPLATES,
  type SceneBrief,
} from '../execution/skills/video_workspace_author.js';

function parseFlags(args: string[]): {
  positional: string[];
  flags: Record<string, string | true>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [k, v] = arg.slice(2).split('=');
      flags[k] = v ?? true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function resolveSpec(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function renderProgress(p: VideoSkillProgress): void {
  const bar = '▰'.repeat(Math.floor(p.pct / 5)) + '▱'.repeat(20 - Math.floor(p.pct / 5));
  process.stdout.write(`\r  ${bar} ${String(p.pct).padStart(3)}%  ${p.stage.padEnd(16)} ${p.message.slice(0, 60)}`);
  if (p.stage === 'done') process.stdout.write('\n');
}

async function cmdRender(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const specArg = positional[0];
  if (!specArg) {
    console.error('Usage: ohwow video render <spec.json> [--out=<path>]');
    process.exit(1);
  }
  const specPath = resolveSpec(specArg);
  const outputPath = typeof flags.out === 'string' ? flags.out : undefined;

  console.log(`Rendering ${specPath}...`);
  try {
    const result = await runVideoGeneration({
      specPath,
      outputPath,
      onProgress: renderProgress,
    });
    console.log(`\nOutput: ${result.path}`);
    console.log(`Size:   ${(result.sizeBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Time:   ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`Hash:   ${result.specHash.slice(0, 16)}...`);
  } catch (err) {
    console.error('\nRender failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

async function cmdCacheLs(flags: Record<string, string | true>): Promise<void> {
  const modality = typeof flags.modality === 'string' ? (flags.modality as CacheModality) : undefined;
  const entries = await listCache(modality);
  if (entries.length === 0) {
    console.log('Cache empty.');
    return;
  }
  console.log('modality   hash              size        created              inputs');
  console.log('─────────  ────────────────  ──────────  ───────────────────  ──────');
  for (const e of entries) {
    const size = e.sizeBytes > 1024 * 1024
      ? `${(e.sizeBytes / 1024 / 1024).toFixed(1)}MB`
      : `${(e.sizeBytes / 1024).toFixed(0)}KB`;
    const preview = JSON.stringify(e.inputs).slice(0, 40);
    console.log(`${e.modality.padEnd(9)}  ${e.hash.slice(0, 16)}  ${size.padStart(10)}  ${e.createdAt.slice(0, 19)}  ${preview}`);
  }
  console.log(`\n${entries.length} entries.`);
}

async function cmdCachePrune(flags: Record<string, string | true>): Promise<void> {
  const days = typeof flags['older-than'] === 'string' ? Number(flags['older-than']) : NaN;
  if (!Number.isFinite(days) || days <= 0) {
    console.error('Usage: ohwow video cache prune --older-than=<days>');
    process.exit(1);
  }
  const removed = await pruneCache(days * 24 * 60 * 60 * 1000);
  console.log(`Removed ${removed} cache entries older than ${days} day${days === 1 ? '' : 's'}.`);
}

async function cmdCache(args: string[]): Promise<void> {
  const sub = args[0];
  const { flags } = parseFlags(args.slice(1));
  if (sub === 'ls') {
    await cmdCacheLs(flags);
  } else if (sub === 'prune') {
    await cmdCachePrune(flags);
  } else {
    console.error('Usage: ohwow video cache <ls|prune> [flags]');
    process.exit(1);
  }
}

function resolveWorkspaceDir(name: string): string {
  return join(homedir(), '.ohwow', 'workspaces', name);
}

function resolvePackageDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = join(dir, 'packages', 'video', 'package.json');
      readFileSync(pkg, 'utf8');
      return join(dir, 'packages', 'video');
    } catch {
      const parent = dir.replace(/\/[^/]+$/, '');
      if (!parent || parent === dir) break;
      dir = parent;
    }
  }
  throw new Error('Could not locate packages/video. Set OHWOW_VIDEO_PKG_DIR or run from the repo.');
}

function loadOpenRouterKey(): string {
  const fromEnv = process.env.OPENROUTER_API_KEY;
  if (fromEnv) return fromEnv;
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.ohwow', 'config.json'), 'utf8')) as { openRouterApiKey?: string };
    if (config.openRouterApiKey) return config.openRouterApiKey;
  } catch { /* ignore */ }
  throw new Error('No OpenRouter API key. Set OPENROUTER_API_KEY or configure openRouterApiKey in ~/.ohwow/config.json.');
}

async function cmdWorkspace(args: string[]): Promise<void> {
  const { flags } = parseFlags(args);
  const workspace = typeof flags.workspace === 'string' ? flags.workspace : 'default';
  const voice = typeof flags.voice === 'string' ? flags.voice : 'onyx';
  const copyModel = typeof flags['copy-model'] === 'string' ? flags['copy-model'] : undefined;
  const template = typeof flags.template === 'string' ? flags.template : 'classic-demo';
  const extraBrief = typeof flags.brief === 'string' ? flags.brief : undefined;
  const scenesFlag = typeof flags.scenes === 'string' ? flags.scenes : undefined;
  const dryRun = flags['dry-run'] === true;
  const outputPath = typeof flags.out === 'string' ? flags.out : undefined;

  let briefs: SceneBrief[] | undefined;
  if (scenesFlag) {
    const sourceTemplate = BUILTIN_TEMPLATES[template] ?? BUILTIN_TEMPLATES['classic-demo'];
    const wanted = scenesFlag.split(',').map(s => s.trim()).filter(Boolean);
    briefs = wanted.map(kind => {
      const match = sourceTemplate.find(b => b.kind === kind);
      if (match) return match;
      return { kind: kind as SceneBrief['kind'], theme: `Scene about "${kind}".`, targetSeconds: 6 };
    });
  }

  if (!BUILTIN_TEMPLATES[template] && !briefs) {
    console.error(`Unknown template "${template}". Available: ${Object.keys(BUILTIN_TEMPLATES).join(', ')}`);
    process.exit(1);
  }

  const workspaceDataDir = resolveWorkspaceDir(workspace);
  const packageDir = resolvePackageDir();
  const openRouterApiKey = loadOpenRouterKey();

  console.log(`Authoring video for workspace "${workspace}" (template: ${briefs ? 'custom' : template})...`);
  const author = await authorWorkspaceVideoSpec(
    {
      workspaceDataDir,
      openRouterApiKey,
      openAiApiKey: process.env.OPENAI_API_KEY,
      packageDir,
      voice,
      copyModel,
      template: briefs ? undefined : (template as keyof typeof BUILTIN_TEMPLATES),
      briefs,
      extraBrief,
      scriptsOnly: dryRun,
    },
    msg => console.log(`  ${msg}`),
  );

  console.log('\nWorkspace facts:');
  const f = author.facts;
  console.log(`  ${f.agentCount} agents, ${f.taskCount} tasks, ${f.memories} memories`);
  if (f.topAgentRoles.length) console.log(`  roles: ${f.topAgentRoles.slice(0, 3).join(', ')}`);
  console.log('\nGenerated scripts:');
  author.scripts.forEach((s, i) => {
    console.log(`  ${i + 1}. [${s.kind}] ${s.script}`);
  });
  console.log(`\nVoice durations: ${author.voiceDurationsMs.map(d => (d / 1000).toFixed(1) + 's').join(' | ')}`);
  console.log(`Total: ${author.totalFrames} frames (${(author.totalFrames / 30).toFixed(1)}s)`);
  console.log(`Spec:  ${author.specPath}`);

  if (dryRun) {
    console.log('\n[dry-run] Skipping render.');
    return;
  }

  console.log('\nRendering...');
  const result = await runVideoGeneration({
    specPath: author.specPath,
    outputPath,
    packageDir,
    onProgress: renderProgress,
  });
  console.log(`\nOutput: ${result.path}`);
  console.log(`Size:   ${(result.sizeBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Time:   ${(result.durationMs / 1000).toFixed(1)}s`);
}

function usage(): void {
  console.log('Usage:');
  console.log('  ohwow video render <spec.json> [--out=<path>]');
  console.log('  ohwow video generate <spec.json> [--out=<path>]       (alias of render in v1)');
  console.log('  ohwow video workspace [--workspace=<name>] [--template=<t>] [--scenes=<k1,k2,...>]');
  console.log('                        [--brief="free-text direction"] [--voice=<v>] [--copy-model=<m>]');
  console.log('                        [--dry-run] [--out=<path>]');
  console.log(`      templates: ${Object.keys(BUILTIN_TEMPLATES).join(', ')}`);
  console.log('  ohwow video cache ls [--modality=<voice|music|image|video>]');
  console.log('  ohwow video cache prune --older-than=<days>');
}

export async function runVideoCli(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    usage();
    process.exit(sub ? 0 : 1);
  }
  if (sub === 'render' || sub === 'generate') {
    await cmdRender(args.slice(1));
  } else if (sub === 'workspace') {
    await cmdWorkspace(args.slice(1));
  } else if (sub === 'cache') {
    await cmdCache(args.slice(1));
  } else {
    console.error(`Unknown video subcommand: ${sub}`);
    usage();
    process.exit(1);
  }
  process.exit(0);
}
