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

import { isAbsolute, resolve } from 'node:path';
import { runVideoGeneration, type VideoSkillProgress } from '../execution/skills/video_generation.js';
import { list as listCache, prune as pruneCache, type CacheModality } from '../media/asset-cache.js';

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

function usage(): void {
  console.log('Usage:');
  console.log('  ohwow video render <spec.json> [--out=<path>]');
  console.log('  ohwow video generate <spec.json> [--out=<path>]   (alias of render in v1)');
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
  } else if (sub === 'cache') {
    await cmdCache(args.slice(1));
  } else {
    console.error(`Unknown video subcommand: ${sub}`);
    usage();
    process.exit(1);
  }
  process.exit(0);
}
