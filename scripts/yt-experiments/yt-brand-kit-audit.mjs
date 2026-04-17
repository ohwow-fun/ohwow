#!/usr/bin/env node
/**
 * yt-brand-kit-audit — render one sample scene per enabled series to
 * surface visual drift. Inputs are hardcoded placeholder text so the
 * ONLY variable is the brand kit — if two outputs look the same, the
 * kits are not pulling their weight.
 *
 * Outputs: one MP4 per enabled series under ~/.ohwow/media/brand-audit/,
 * plus a keyframe JPG next to each for quick side-by-side review.
 *
 * Run with `node --import tsx scripts/yt-experiments/yt-brand-kit-audit.mjs`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';

import { listSeries } from '../../src/integrations/youtube/series/registry.js';

const brandKits = await import('../../packages/video/src/brand-kits/index.js');
const loadBrandKit = brandKits.loadBrandKit || brandKits.default?.loadBrandKit;

const VIDEO_PKG = path.resolve('packages/video');
const OUT_DIR = path.join(os.homedir(), '.ohwow', 'media', 'brand-audit');
fs.mkdirSync(OUT_DIR, { recursive: true });

function sampleSpec(kit) {
  return {
    id: `brand-audit-${kit.slug}-${Date.now()}`,
    version: 1,
    fps: 30,
    width: 1080,
    height: 1920,
    brandKitRef: kit.slug,
    brand: {
      colors: kit.colors,
      fonts: kit.fonts,
      glass: kit.glass,
    },
    palette: {
      seedHue: kit.paletteHue,
      harmony: kit.paletteHarmony,
      mood: kit.ambientMoodDefault,
    },
    voiceovers: [],
    transitions: [{ kind: 'fade', durationInFrames: 10 }],
    scenes: [
      {
        id: 'brand-audit',
        kind: 'composable',
        durationInFrames: 90,
        params: {
          visualLayers: (kit.primitivePalette || []).slice(0, 3).map((p) => ({ primitive: p })),
          text: {
            content: kit.displayName.toUpperCase(),
            animation: 'fade-in',
            fontSize: 64,
            position: 'center',
            maxWidth: 800,
          },
        },
        narration: kit.displayName,
      },
    ],
  };
}

function renderSpec(specPath, outPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', [
      'remotion', 'render', 'src/index.ts', 'SpecDriven', outPath, `--props=${specPath}`,
    ], { cwd: VIDEO_PKG, stdio: 'pipe', env: { ...process.env, FORCE_COLOR: '0' } });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`remotion exit ${code}: ${stderr.slice(-300)}`));
    });
  });
}

async function main() {
  const series = listSeries({ onlyEnabled: true });
  console.log(`[brand-audit] rendering ${series.length} sample scenes → ${OUT_DIR}`);
  const results = [];
  for (const s of series) {
    const kit = loadBrandKit(s.brandKitFile.replace(/\.json$/, ''));
    const spec = sampleSpec(kit);
    const specPath = path.join(OUT_DIR, `${s.slug}.spec.json`);
    const mp4Path = path.join(OUT_DIR, `${s.slug}.mp4`);
    const jpgPath = path.join(OUT_DIR, `${s.slug}.jpg`);
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
    try {
      console.log(`  ${s.slug} → ${mp4Path}`);
      await renderSpec(specPath, mp4Path);
      // First-frame JPG for side-by-side review.
      execSync(`ffmpeg -y -ss 0.5 -i "${mp4Path}" -frames:v 1 -q:v 3 "${jpgPath}"`, { stdio: 'pipe' });
      results.push({ slug: s.slug, mp4: mp4Path, jpg: jpgPath, ok: true });
    } catch (e) {
      console.log(`  ${s.slug} FAILED: ${e.message}`);
      results.push({ slug: s.slug, error: e.message, ok: false });
    }
  }

  const summary = path.join(OUT_DIR, 'summary.json');
  fs.writeFileSync(summary, JSON.stringify(results, null, 2));
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n[brand-audit] ${ok}/${results.length} series rendered successfully`);
  console.log(`  eyeball: open ${OUT_DIR}`);
  process.exit(ok === results.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
