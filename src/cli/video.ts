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

import { isAbsolute, resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { runVideoGeneration, runVideoPreview, type VideoSkillProgress } from '../execution/skills/video_generation.js';
import { list as listCache, prune as pruneCache, type CacheModality } from '../media/asset-cache.js';
import {
  authorWorkspaceVideoSpec,
  BUILTIN_TEMPLATES,
  selectTtsProvider,
  makeOpenAiProvider,
  type SceneBrief,
} from '../execution/skills/video_workspace_author.js';
import type { VideoClipProviderName } from '../media/video-clip-provider.js';
import { generateClip } from '../media/video-clip-router.js';
import { LyriaOpenRouterBridge } from '../media/lyria-openrouter-bridge.js';
import { generateAvatarVideo } from '../media/video-clip-providers/heygen-adapter.js';

const CLIP_PROVIDER_NAMES: ReadonlySet<VideoClipProviderName> = new Set([
  'openrouter-veo',
  'fal',
  'replicate',
  'custom-http',
  'higgsfield',
  'heygen',
]);

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

async function cmdLint(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const specArg = positional[0];
  if (!specArg) {
    console.error('Usage: ohwow video lint <spec.json> [--strict]');
    process.exit(1);
  }
  const specPath = resolveSpec(specArg);
  const strict = flags.strict === true;
  const packageDir = resolvePackageDir();
  const runnerPath = join(packageDir, 'scripts', 'lint-cli.cts');

  const childArgs = ['tsx', runnerPath, specPath];
  if (strict) childArgs.push('--strict');

  const exitCode = await new Promise<number>((resolvePromise, rejectPromise) => {
    const child = spawn('npx', childArgs, {
      cwd: packageDir,
      stdio: 'inherit',
      env: { ...process.env },
    });
    child.on('error', rejectPromise);
    child.on('close', code => resolvePromise(code ?? 0));
  });
  process.exit(exitCode);
}

function loadConfigSafe(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.ohwow', 'config.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function mask(value: string | undefined): string {
  if (!value) return 'unset';
  return `set (len=${value.length})`;
}

async function cmdTts(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const text = positional[0];
  if (!text) {
    console.error('Usage: ohwow video tts "<text>" [--voice=<v>] [--out=<path>] [--speed=<n>]');
    process.exit(1);
  }
  const voice = typeof flags.voice === 'string' ? flags.voice : 'onyx';
  const speed = typeof flags.speed === 'string' ? Number(flags.speed) : 1.0;
  const outRaw = typeof flags.out === 'string' ? flags.out : `tts-${Date.now()}.mp3`;
  const outPath = isAbsolute(outRaw) ? outRaw : resolve(process.cwd(), outRaw);

  const provider = await selectTtsProvider({ openAiApiKey: process.env.OPENAI_API_KEY });
  const audio = await provider.synthesize({ text, voice, speed });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, audio);
  console.log(`Output: ${outPath}`);
  console.log(`Size:   ${(audio.byteLength / 1024).toFixed(1)}KB`);
  console.log(`Voice:  ${voice} (provider: ${provider.name})`);
}

async function cmdMusic(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const prompt = positional[0];
  if (!prompt) {
    console.error('Usage: ohwow video music "<prompt>" [--duration=<s>] [--genre=<g>] [--mood=<m>] [--bpm=<n>]');
    process.exit(1);
  }
  const duration = typeof flags.duration === 'string' ? Number(flags.duration) : 15;
  const genre = typeof flags.genre === 'string' ? flags.genre : undefined;
  const mood = typeof flags.mood === 'string' ? flags.mood : undefined;
  const bpm = typeof flags.bpm === 'string' ? Number(flags.bpm) : undefined;

  const apiKey = loadOpenRouterKey();
  const bridge = new LyriaOpenRouterBridge({ apiKey });
  const result = await bridge.generateMusic({
    prompt,
    durationSeconds: duration,
    genre,
    mood,
    bpm,
  });
  console.log(`Output: ${result.path}`);
  console.log(`Size:   ${(result.sizeBytes / 1024).toFixed(1)}KB`);
  console.log(`Mime:   ${result.mimeType}`);
}

async function cmdClip(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const prompt = positional[0];
  if (!prompt) {
    console.error('Usage: ohwow video clip "<prompt>" [--duration=<s>] [--aspect=<a>] [--provider=<p>] [--seed=<n>] [--max-cost=<cents>] [--dry-run]');
    process.exit(1);
  }
  const durationSeconds = typeof flags.duration === 'string' ? Number(flags.duration) : 5;
  const aspectRaw = typeof flags.aspect === 'string' ? flags.aspect : '16:9';
  if (!['16:9', '9:16', '1:1'].includes(aspectRaw)) {
    console.error(`Unknown --aspect "${aspectRaw}". Use 16:9, 9:16, or 1:1.`);
    process.exit(1);
  }
  const aspectRatio = aspectRaw as '16:9' | '9:16' | '1:1';
  const seed = typeof flags.seed === 'string' ? Number(flags.seed) : undefined;
  const provider = typeof flags.provider === 'string' ? (flags.provider as VideoClipProviderName) : undefined;
  const maxCostCents = typeof flags['max-cost'] === 'string' ? Number(flags['max-cost']) : undefined;
  const dryRun = flags['dry-run'] === true;

  if (provider && !CLIP_PROVIDER_NAMES.has(provider)) {
    console.error(`Unknown --provider "${provider}". Available: ${Array.from(CLIP_PROVIDER_NAMES).join(', ')}`);
    process.exit(1);
  }

  const result = await generateClip(
    { prompt, durationSeconds, aspectRatio, seed },
    { forceProvider: provider, maxCostCents, dryRun },
  );

  if (result.skipped === 'dry-run') {
    console.log(`[dry-run] would pick: ${result.chosen ?? '(none)'}`);
    for (const p of result.preview) {
      console.log(`  ${p.name.padEnd(16)}priority=${p.priority}  estCost=${p.estimatedCostCents}¢`);
    }
    return;
  }
  if (result.skipped === 'no-provider') {
    console.error('No clip provider available. Configure FAL_KEY, REPLICATE_API_TOKEN, OPENROUTER_API_KEY, or OHWOW_VIDEO_HTTP_URL.');
    process.exit(1);
  }
  if (!result.result) {
    console.error('Clip generation returned no result.');
    process.exit(1);
  }
  console.log(`Output:  ${result.result.path}`);
  console.log(`Chosen:  ${result.chosen}`);
  console.log(`Cached:  ${result.result.cached}`);
  console.log(`GenTime: ${(result.result.generationMs / 1000).toFixed(1)}s`);
}

async function cmdAvatar(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const script = positional[0];
  if (!script) {
    console.error('Usage: ohwow video avatar "<script>" [--avatar=<id>] [--voice=<id>] [--aspect=16:9|9:16|1:1] [--out=<path>]');
    process.exit(1);
  }

  const cfg = loadConfigSafe();
  const apiKey = process.env.HEYGEN_API_KEY || (cfg.heygenApiKey as string | undefined) || '';
  const avatarId = typeof flags.avatar === 'string'
    ? flags.avatar
    : process.env.HEYGEN_AVATAR_ID || (cfg.heygenAvatarId as string | undefined) || '';

  if (!apiKey) {
    console.error('No HeyGen API key. Set HEYGEN_API_KEY or configure heygenApiKey in ~/.ohwow/config.json.');
    process.exit(1);
  }
  if (!avatarId) {
    console.error('No avatar ID. Set HEYGEN_AVATAR_ID, configure heygenAvatarId in ~/.ohwow/config.json, or pass --avatar=<id>.');
    process.exit(1);
  }

  const voiceId = typeof flags.voice === 'string' ? flags.voice : undefined;
  const aspectRaw = typeof flags.aspect === 'string' ? flags.aspect : '16:9';
  if (!['16:9', '9:16', '1:1'].includes(aspectRaw)) {
    console.error(`Unknown --aspect "${aspectRaw}". Use 16:9, 9:16, or 1:1.`);
    process.exit(1);
  }
  const aspectRatio = aspectRaw as '16:9' | '9:16' | '1:1';
  const outRaw = typeof flags.out === 'string' ? flags.out : `avatar-${Date.now()}.mp4`;
  const { isAbsolute: isAbs, resolve: res } = await import('node:path');
  const outPath = isAbs(outRaw) ? outRaw : res(process.cwd(), outRaw);

  console.log(`Generating HeyGen avatar video (avatar: ${avatarId})...`);
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');

  try {
    const { buffer, videoId } = await generateAvatarVideo({ apiKey, avatarId, voiceId, script, aspectRatio });
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, buffer);
    console.log(`Output:   ${outPath}`);
    console.log(`VideoID:  ${videoId}`);
    console.log(`Size:     ${(buffer.byteLength / 1024).toFixed(1)}KB`);
  } catch (err) {
    console.error('Avatar generation failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

function cmdStatus(): void {
  const cfg = loadConfigSafe();
  console.log('== ohwow video-gen status ==\n');
  console.log('config.json:');
  console.log(`  falKey:            ${mask(cfg.falKey as string | undefined)}`);
  console.log(`  falVideoModel:     ${cfg.falVideoModel ?? '(default fal-ai/luma-dream-machine)'}`);
  console.log(`  openRouterApiKey:  ${mask(cfg.openRouterApiKey as string | undefined)}`);
  console.log(`  replicateApiToken: ${mask(cfg.replicateApiToken as string | undefined)}`);
  console.log(`  higgsfieldApiKey:  ${mask(cfg.higgsfieldApiKey as string | undefined)}`);
  console.log(`  heygenApiKey:      ${mask(cfg.heygenApiKey as string | undefined)}`);
  console.log(`  heygenAvatarId:    ${cfg.heygenAvatarId ?? 'unset'}`);
  console.log('');
  console.log('env overrides:');
  console.log(`  FAL_KEY:              ${mask(process.env.FAL_KEY)}`);
  console.log(`  FAL_VIDEO_MODEL:      ${process.env.FAL_VIDEO_MODEL ?? 'unset'}`);
  console.log(`  OPENROUTER_API_KEY:   ${mask(process.env.OPENROUTER_API_KEY)}`);
  console.log(`  OPENAI_API_KEY:       ${mask(process.env.OPENAI_API_KEY)}`);
  console.log(`  REPLICATE_API_TOKEN:  ${mask(process.env.REPLICATE_API_TOKEN)}`);
  console.log(`  OHWOW_VIDEO_HTTP_URL: ${process.env.OHWOW_VIDEO_HTTP_URL ?? 'unset'}`);
  console.log(`  HIGGSFIELD_API_KEY:   ${mask(process.env.HIGGSFIELD_API_KEY)}`);
  console.log(`  HEYGEN_API_KEY:       ${mask(process.env.HEYGEN_API_KEY)}`);
  console.log(`  HEYGEN_AVATAR_ID:     ${process.env.HEYGEN_AVATAR_ID ?? 'unset'}`);
  console.log('');
  const hasFal = process.env.FAL_KEY || cfg.falKey;
  const hasOr = process.env.OPENROUTER_API_KEY || cfg.openRouterApiKey;
  const hasRep = process.env.REPLICATE_API_TOKEN || cfg.replicateApiToken;
  const hasHttp = process.env.OHWOW_VIDEO_HTTP_URL;
  const hasHiggs = process.env.HIGGSFIELD_API_KEY || cfg.higgsfieldApiKey;
  const hasHeygen = (process.env.HEYGEN_API_KEY || cfg.heygenApiKey) && (process.env.HEYGEN_AVATAR_ID || cfg.heygenAvatarId);
  const available = [
    hasFal && 'fal',
    hasHiggs && 'higgsfield',
    hasOr && 'openrouter-veo',
    hasRep && 'replicate',
    hasHttp && 'custom-http',
    hasHeygen && 'heygen',
  ].filter(Boolean);
  console.log(`available clip providers: ${available.length ? available.join(', ') : 'NONE'}`);
}

function cmdSwapModel(args: string[]): void {
  const model = args[0];
  if (!model) {
    console.error('Usage: ohwow video swap-model <model-slug>');
    console.error('  e.g., fal-ai/kling-video/v2.1/master/text-to-video');
    process.exit(1);
  }
  const configPath = join(homedir(), '.ohwow', 'config.json');
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // new config
  }
  cfg.falVideoModel = model;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`Updated ${configPath}: falVideoModel = ${model}`);
}

function cmdLintPrompt(args: string[]): void {
  const prompt = args[0];
  if (!prompt) {
    console.error('Usage: ohwow video lint-prompt "<prompt>"');
    process.exit(2);
  }

  const CAMERA = /dolly|push(-| )?in|pull(-| )?back|pan(s|ning)?|track(s|ing)?|orbit(s|ing)?|drone|crane|tilt(s|ing)?|glide|zoom|static frame|handheld|follow(s|ing)?|circl(es|ing)/i;
  const SUBJECT = /drift(s|ing)?|ris(es|ing)|fall(s|ing)?|rustl(es|ing)|flow(s|ing)?|billow(s|ing)?|shatter(s|ing)?|pour(s|ing)?|run(s|ning)?|walk(s|ing)?|gallop(s|ing)?|spin(s|ning)?|rippl(es|ing)|stream(s|ing)?|smoke|steam|mist|spray|dust motes|leaves/i;
  const STYLE = /photorealistic|documentary|shot on|35mm|iPhone|Sony|cinematic|film grain/i;
  const OVERLOAD = /anamorphic|lens flare|film grain|color grade|chiaroscuro|volumetric|vignette|bokeh|180[- ]degree shutter/gi;
  const PAST_TENSE = /\b(walked|ran|moved|turned|flew|sat|stood)\b/;

  const warnings: string[] = [];
  const hits: string[] = [];

  function check(pattern: RegExp, label: string, example: string): void {
    if (pattern.test(prompt)) hits.push(`ok  ${label}`);
    else warnings.push(`MISSING: ${label} (try: ${example})`);
  }

  console.log('== prompt lint ==\n');
  check(CAMERA, 'camera-motion cue', 'slow dolly-in, tracking shot, aerial drone');
  check(SUBJECT, 'subject-motion cue', 'steam rising, mist drifting, hands pouring');
  check(STYLE, 'style/realism anchor', 'shot on iPhone, 35mm film, documentary');

  const words = prompt.trim().split(/\s+/).filter(Boolean).length;
  if (words < 40) warnings.push(`SHORT: ${words} words (target 60-200; LTX/Seedance reward detail)`);
  else if (words > 220) warnings.push(`LONG: ${words} words (target 60-200; model ignores tail tokens)`);
  else hits.push(`ok  word count ${words}`);

  const overload = (prompt.match(OVERLOAD) ?? []).length;
  if (overload > 3) warnings.push(`STYLE OVERLOAD: ${overload} stacked modifiers (drop to <=3)`);
  else hits.push(`ok  style modifier count ${overload} (<=3)`);

  if (PAST_TENSE.test(prompt)) {
    warnings.push("TENSE: past-tense verbs detected. LTX/Seedance reward present tense ('walks' not 'walked')");
  } else {
    hits.push('ok  tense (no past-tense verbs)');
  }

  for (const h of hits) console.log(`  ${h}`);
  if (warnings.length > 0) {
    console.log('');
    for (const w of warnings) console.log(`  ${w}`);
    console.log(`\n${warnings.length} warning${warnings.length === 1 ? '' : 's'}.`);
    process.exit(1);
  } else {
    console.log('\nPrompt looks shot-ready.');
  }
}

async function cmdBlocks(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || !['list', 'get', 'add', 'new'].includes(sub)) {
    console.error('Usage: ohwow video blocks <list|get|add|new> [args]');
    process.exit(1);
  }
  const packageDir = resolvePackageDir();
  const runnerPath = join(packageDir, 'scripts', 'blocks-cli.cts');
  const exitCode = await new Promise<number>((resolvePromise, rejectPromise) => {
    const child = spawn('npx', ['tsx', runnerPath, ...args], {
      cwd: packageDir,
      stdio: 'inherit',
      env: { ...process.env },
    });
    child.on('error', rejectPromise);
    child.on('close', code => resolvePromise(code ?? 0));
  });
  process.exit(exitCode);
}

async function cmdAdd(args: string[]): Promise<void> {
  // Shortcut for `blocks add`.
  await cmdBlocks(['add', ...args]);
}

async function cmdList(args: string[]): Promise<void> {
  const kind = args[0];
  if (!kind || !['primitives', 'scenes', 'transitions'].includes(kind)) {
    console.error('Usage: ohwow video list <primitives|scenes|transitions>');
    process.exit(1);
  }
  const packageDir = resolvePackageDir();
  const runnerPath = join(packageDir, 'scripts', 'list-cli.cts');

  const exitCode = await new Promise<number>((resolvePromise, rejectPromise) => {
    const child = spawn('npx', ['tsx', runnerPath, kind], {
      cwd: packageDir,
      stdio: 'inherit',
      env: { ...process.env },
    });
    child.on('error', rejectPromise);
    child.on('close', code => resolvePromise(code ?? 0));
  });
  process.exit(exitCode);
}

async function cmdPreview(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const specArg = positional[0];
  if (!specArg) {
    console.error('Usage: ohwow video preview <spec.json> [--port=<port>]');
    process.exit(1);
  }
  const specPath = resolveSpec(specArg);
  const port = typeof flags.port === 'string' ? Number(flags.port) : undefined;
  const packageDir = resolvePackageDir();

  console.log(`Opening Remotion Studio with ${specPath}...`);
  try {
    await runVideoPreview({ specPath, packageDir, port });
  } catch (err) {
    console.error('Studio exited with error:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
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
  const extraBrief = typeof flags.brief === 'string' ? flags.brief : undefined;
  const scenesFlag = typeof flags.scenes === 'string' ? flags.scenes : undefined;
  const template = typeof flags.template === 'string'
    ? flags.template
    : (extraBrief || scenesFlag ? undefined : 'classic-demo');
  const dryRun = flags['dry-run'] === true;
  const preview = flags.preview === true;
  const previewPort = typeof flags.port === 'string' ? Number(flags.port) : undefined;
  const outputPath = typeof flags.out === 'string' ? flags.out : undefined;

  const clipsEnabled = flags.clips === true || typeof flags.clips === 'string';
  const clipsProviderRaw = typeof flags['clips-provider'] === 'string' ? flags['clips-provider'] : undefined;
  if (clipsProviderRaw && !CLIP_PROVIDER_NAMES.has(clipsProviderRaw as VideoClipProviderName)) {
    console.error(`Unknown --clips-provider "${clipsProviderRaw}". Available: ${Array.from(CLIP_PROVIDER_NAMES).join(', ')}`);
    process.exit(1);
  }
  const clipsMaxCostCents = typeof flags['clips-max-cost'] === 'string' ? Number(flags['clips-max-cost']) : undefined;
  if (clipsMaxCostCents != null && !Number.isFinite(clipsMaxCostCents)) {
    console.error('--clips-max-cost must be a number (cents).');
    process.exit(1);
  }
  const clipsDryRun = flags['clips-dry-run'] === true;

  let briefs: SceneBrief[] | undefined;
  if (scenesFlag) {
    const tmplKey = template ?? 'classic-demo';
    const sourceTemplate = BUILTIN_TEMPLATES[tmplKey] ?? BUILTIN_TEMPLATES['classic-demo'];
    const wanted = scenesFlag.split(',').map(s => s.trim()).filter(Boolean);
    briefs = wanted.map(kind => {
      const match = sourceTemplate.find((b: SceneBrief) => b.kind === kind);
      if (match) return match;
      return { kind, theme: `Scene about "${kind}".`, targetSeconds: 6 };
    });
  }

  if (template && !BUILTIN_TEMPLATES[template] && !briefs) {
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
      clips: clipsEnabled
        ? {
            enabled: true,
            provider: clipsProviderRaw as VideoClipProviderName | undefined,
            maxCostCents: clipsMaxCostCents,
            dryRun: clipsDryRun,
          }
        : undefined,
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

  if (preview) {
    console.log('\nOpening Remotion Studio...');
    await runVideoPreview({ specPath: author.specPath, packageDir, port: previewPort });
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
  console.log('  ohwow video preview <spec.json> [--port=<port>]       open in Remotion Studio');
  console.log('  ohwow video lint <spec.json> [--strict]               validate shape + cross-field rules');
  console.log('  ohwow video list <primitives|scenes|transitions>      introspect the registry');
  console.log('  ohwow video blocks list [--category=<c>]              browse the block catalog');
  console.log('  ohwow video blocks get <id>                           show details for one block');
  console.log('  ohwow video add <id> [--dest=<path>]                  copy a block source into your repo');
  console.log('  ohwow video blocks new <id> [--category=<c>] [--dest=<path>]  scaffold a new block');
  console.log('  ohwow video tts "<text>" [--voice=<v>] [--out=<path>] [--speed=<n>]');
  console.log('  ohwow video music "<prompt>" [--duration=<s>] [--genre=<g>] [--mood=<m>] [--bpm=<n>]');
  console.log('  ohwow video clip "<prompt>" [--duration=<s>] [--aspect=<a>] [--provider=<p>] [--seed=<n>] [--max-cost=<cents>] [--dry-run]');
  console.log('  ohwow video avatar "<script>" [--avatar=<id>] [--voice=<id>] [--aspect=<a>] [--out=<path>]');
  console.log('  ohwow video status                                    show active provider config');
  console.log('  ohwow video swap-model <model-slug>                   set falVideoModel in ~/.ohwow/config.json');
  console.log('  ohwow video lint-prompt "<prompt>"                    static check for text-to-video prompts');
  console.log('  ohwow video workspace [--workspace=<name>] [--template=<t>] [--scenes=<k1,k2,...>]');
  console.log('                        [--brief="free-text direction"] [--voice=<v>] [--copy-model=<m>]');
  console.log('                        [--dry-run] [--preview] [--port=<port>] [--out=<path>]');
  console.log('                        [--clips] [--clips-provider=<name>] [--clips-max-cost=<cents>] [--clips-dry-run]');
  console.log(`      templates: ${Object.keys(BUILTIN_TEMPLATES).join(', ')}`);
  console.log(`      clip providers: ${Array.from(CLIP_PROVIDER_NAMES).join(', ')}`);
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
  } else if (sub === 'preview') {
    await cmdPreview(args.slice(1));
  } else if (sub === 'lint') {
    await cmdLint(args.slice(1));
  } else if (sub === 'list') {
    await cmdList(args.slice(1));
  } else if (sub === 'blocks') {
    await cmdBlocks(args.slice(1));
  } else if (sub === 'add') {
    await cmdAdd(args.slice(1));
  } else if (sub === 'tts') {
    await cmdTts(args.slice(1));
  } else if (sub === 'music') {
    await cmdMusic(args.slice(1));
  } else if (sub === 'clip') {
    await cmdClip(args.slice(1));
  } else if (sub === 'avatar') {
    await cmdAvatar(args.slice(1));
  } else if (sub === 'status') {
    cmdStatus();
  } else if (sub === 'swap-model') {
    cmdSwapModel(args.slice(1));
  } else if (sub === 'lint-prompt') {
    cmdLintPrompt(args.slice(1));
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
