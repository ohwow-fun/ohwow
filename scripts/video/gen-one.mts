/**
 * Generate one video clip via the OSS fal adapter.
 * Drop-in single-clip test harness: uses the same code path the router uses at
 * render time, so if it works here it works in production.
 *
 * Credentials: reads ~/.ohwow/config.json falKey / falVideoModel (env overrides
 * via FAL_KEY / FAL_VIDEO_MODEL). Key never logged.
 *
 * Usage:
 *   npx tsx scripts/video/gen-one.mts "<prompt>" [--duration=5] [--aspect=9:16] [--seed=<n>] [--open]
 *
 * Output: /tmp/video-<seed>.mp4 (also retained in ~/.ohwow/media/cache/video/)
 */
import { copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { falProvider } from '../../src/media/video-clip-providers/fal-adapter.js';

type Aspect = '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9';
const VALID_ASPECTS: ReadonlySet<string> = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']);

function parseArgs(argv: string[]): { prompt: string; durationSeconds: number; aspectRatio: Aspect; seed: number; openResult: boolean } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) flags[m[1]] = m[2] ?? true;
    else positional.push(arg);
  }

  const prompt = positional[0];
  if (!prompt) {
    console.error('Usage: npx tsx scripts/video/gen-one.mts "<prompt>" [--duration=5] [--aspect=9:16] [--seed=<n>] [--open]');
    process.exit(2);
  }

  const durationSeconds = flags.duration ? parseInt(String(flags.duration), 10) : 5;
  if (!Number.isFinite(durationSeconds) || durationSeconds < 2 || durationSeconds > 15) {
    console.error(`invalid --duration (must be 2-15, got ${flags.duration})`);
    process.exit(2);
  }

  const aspectRaw = flags.aspect ? String(flags.aspect) : '9:16';
  if (!VALID_ASPECTS.has(aspectRaw)) {
    console.error(`invalid --aspect "${aspectRaw}". Accepted: ${[...VALID_ASPECTS].join(', ')}`);
    process.exit(2);
  }
  const aspectRatio = aspectRaw as Aspect;

  const seed = flags.seed ? parseInt(String(flags.seed), 10) : Math.floor(Math.random() * 1_000_000);
  if (!Number.isFinite(seed)) {
    console.error(`invalid --seed "${flags.seed}"`);
    process.exit(2);
  }

  const openResult = flags.open === true || process.env.OPEN_RESULT === '1';

  return { prompt, durationSeconds, aspectRatio, seed, openResult };
}

async function main(): Promise<void> {
  const { prompt, durationSeconds, aspectRatio, seed, openResult } = parseArgs(process.argv.slice(2));
  const available = await falProvider.isAvailable();
  if (!available) {
    console.error('fal adapter unavailable. Set FAL_KEY env var or add falKey to ~/.ohwow/config.json.');
    process.exit(1);
  }

  console.log(`seed=${seed} duration=${durationSeconds}s aspect=${aspectRatio}`);
  console.log(`prompt: "${prompt.length > 140 ? prompt.slice(0, 137) + '...' : prompt}"`);

  const t0 = Date.now();
  const result = await falProvider.generate({ prompt, durationSeconds, aspectRatio, seed });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`${result.cached ? 'cache hit' : 'generated'} in ${elapsed}s`);
  console.log(`cache:  ${result.path}`);

  const out = `/tmp/video-${seed}.mp4`;
  await copyFile(result.path, out);
  console.log(`tmp:    ${out}`);

  if (openResult) {
    spawn('open', [out], { stdio: 'ignore', detached: true }).unref();
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
