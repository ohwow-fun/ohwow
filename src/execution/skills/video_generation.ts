/**
 * Video Generation Skill
 *
 * Composed skill that turns a VideoSpec (JSON) into an MP4 on disk. Deterministic
 * by construction: same spec + same asset cache = same output. Orchestrates the
 * @ohwow/video Remotion package via child process, checkpoints progress, and
 * stores the final artifact under ~/.ohwow/media/videos/.
 *
 * v1 contract: pre-authored spec → MP4. Voice/music generation hooks are exposed
 * for callers but optional; scripts can pre-bake audio into the spec or wire up
 * generation themselves via the existing generate_voice / generate_music tools.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, stat, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { logger } from '../../lib/logger.js';

export type VideoSkillStage =
  | 'prepare'
  | 'resolve-assets'
  | 'render'
  | 'store'
  | 'done';

export interface VideoSkillProgress {
  stage: VideoSkillStage;
  pct: number;
  message: string;
}

export interface VideoGenerationOptions {
  /** Absolute path to a VideoSpec JSON file. Required. */
  specPath: string;
  /**
   * Directory containing the @ohwow/video Remotion package. Defaults to
   * OHWOW_VIDEO_PKG_DIR, then <repoRoot>/packages/video if runnable.
   */
  packageDir?: string;
  /** Optional explicit output path. Default: ~/.ohwow/media/videos/video-<ts>.mp4. */
  outputPath?: string;
  /** Stream progress updates. */
  onProgress?: (p: VideoSkillProgress) => void;
  /** Extra props to merge over the spec at render time (templating). */
  overrides?: Record<string, unknown>;
  /** Log level passed to Remotion ('error' | 'warn' | 'info' | 'verbose'). */
  remotionLogLevel?: 'error' | 'warn' | 'info' | 'verbose';
}

export interface VideoGenerationResult {
  path: string;
  filename: string;
  sizeBytes: number;
  durationMs: number;
  specHash: string;
  specPath: string;
}

export interface VideoPreviewOptions {
  specPath: string;
  packageDir?: string;
  port?: number;
}

export async function runVideoPreview(opts: VideoPreviewOptions): Promise<void> {
  const specPath = isAbsolute(opts.specPath) ? opts.specPath : resolve(opts.specPath);
  await stat(specPath);
  const packageDir = opts.packageDir ?? defaultPackageDir();

  const args = [
    'remotion',
    'studio',
    'src/index.ts',
    `--props=${specPath}`,
  ];
  if (opts.port) args.push(`--port=${opts.port}`);

  const child = spawn('npx', args, {
    cwd: packageDir,
    stdio: 'inherit',
    env: { ...process.env },
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    child.on('error', rejectPromise);
    child.on('close', code => {
      if (code === 0 || code === null) resolvePromise();
      else rejectPromise(new Error(`remotion studio exited ${code}`));
    });
  });
}

function mediaVideosDir(): string {
  return join(homedir(), '.ohwow', 'media', 'videos');
}

function defaultPackageDir(): string {
  if (process.env.OHWOW_VIDEO_PKG_DIR) return process.env.OHWOW_VIDEO_PKG_DIR;
  // Repo dev layout: <repoRoot>/packages/video. Start from cwd and walk up.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'packages', 'video');
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'Could not locate @ohwow/video package. Set OHWOW_VIDEO_PKG_DIR or run from the monorepo root.',
  );
}

async function hashFile(path: string): Promise<string> {
  const buf = await readFile(path);
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(buf).digest('hex');
}

function emit(
  onProgress: VideoGenerationOptions['onProgress'],
  p: VideoSkillProgress,
): void {
  logger.info(`[video-gen] ${p.stage} ${p.pct}% — ${p.message}`);
  onProgress?.(p);
}

/**
 * Run a full VideoSpec → MP4 pipeline. Throws on failure; checkpoints via
 * onProgress callbacks so callers can persist stages (video_jobs table).
 */
export async function runVideoGeneration(
  opts: VideoGenerationOptions,
): Promise<VideoGenerationResult> {
  const start = Date.now();
  const { onProgress } = opts;

  // ── 1. prepare: validate spec path, resolve package directory
  emit(onProgress, { stage: 'prepare', pct: 0, message: 'validating inputs' });
  const specPath = isAbsolute(opts.specPath) ? opts.specPath : resolve(opts.specPath);
  await stat(specPath); // throws if missing
  const specHash = await hashFile(specPath);
  const packageDir = opts.packageDir ?? defaultPackageDir();
  await stat(join(packageDir, 'package.json'));

  // ── 2. resolve-assets: future hook for cache:// rewriting. No-op in v1.
  emit(onProgress, {
    stage: 'resolve-assets',
    pct: 10,
    message: 'spec assets resolved (v1: no cache:// rewriting)',
  });

  // ── 3. render: spawn `npx remotion render` in the package dir
  await mkdir(mediaVideosDir(), { recursive: true });
  const outputPath =
    opts.outputPath ?? join(mediaVideosDir(), `video-${Date.now()}.mp4`);
  await mkdir(dirname(outputPath), { recursive: true });

  const args = [
    'remotion',
    'render',
    'src/index.ts',
    'SpecDriven',
    outputPath,
    `--props=${specPath}`,
    `--log=${opts.remotionLogLevel ?? 'error'}`,
  ];

  emit(onProgress, {
    stage: 'render',
    pct: 15,
    message: `spawning remotion render in ${packageDir}`,
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn('npx', args, {
      cwd: packageDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stderr = '';
    child.stdout.on('data', chunk => {
      const line = chunk.toString();
      const match = /Rendered\s+(\d+)\/(\d+)/.exec(line);
      if (match) {
        const pct = Math.min(90, 15 + Math.floor((Number(match[1]) / Number(match[2])) * 70));
        emit(onProgress, {
          stage: 'render',
          pct,
          message: `rendered ${match[1]}/${match[2]} frames`,
        });
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', err => rejectPromise(err));
    child.on('close', code => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`remotion render exited ${code}: ${stderr.slice(-500)}`));
    });
  });

  // ── 4. store: place under ~/.ohwow/media/videos/ (already rendered there if outputPath was default)
  emit(onProgress, { stage: 'store', pct: 95, message: 'finalising output path' });
  let finalPath = outputPath;
  if (!finalPath.startsWith(mediaVideosDir())) {
    const target = join(mediaVideosDir(), `video-${Date.now()}.mp4`);
    await rename(finalPath, target);
    finalPath = target;
  }

  const finalStat = await stat(finalPath);
  const filename = finalPath.split('/').pop() ?? 'video.mp4';

  const durationMs = Date.now() - start;
  emit(onProgress, {
    stage: 'done',
    pct: 100,
    message: `video ready: ${filename} (${finalStat.size} bytes, ${durationMs}ms)`,
  });

  return {
    path: finalPath,
    filename,
    sizeBytes: finalStat.size,
    durationMs,
    specHash,
    specPath,
  };
}
