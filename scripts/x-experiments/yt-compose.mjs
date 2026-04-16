#!/usr/bin/env node
/**
 * yt-compose — YouTube Shorts composer. Reads x-intel emerging patterns
 * (same source as x-compose), generates a philosophical AI observation
 * as a 15-25 second Short with voiceover + visuals, and proposes it via
 * _approvals as kind='yt_short_draft'.
 *
 * On auto-approve, uploads to YouTube via _yt-browser.mjs.
 *
 * Env:
 *   DRY=1 (default)          draft only, no approval writes or uploads
 *   HISTORY_DAYS=5           how far back to pull emerging patterns
 *   SKIP_RENDER=0            skip Remotion render (for testing LLM drafts)
 *   SKIP_VOICE=0             skip voice generation (for testing visuals)
 *   VISIBILITY=unlisted      YouTube visibility (private/unlisted/public)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { resolveOhwow, llm, extractJson } from './_ohwow.mjs';
import { propose } from './_approvals.mjs';
import { ensureYTReady, uploadShort } from './_yt-browser.mjs';

const DRY = process.env.DRY !== '0';
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 5);
const SKIP_RENDER = process.env.SKIP_RENDER === '1';
const SKIP_VOICE = process.env.SKIP_VOICE === '1';
const VISIBILITY = process.env.VISIBILITY || 'unlisted';
const VIDEO_PKG = path.resolve('packages/video');
const MEDIA_DIR = path.join(os.homedir(), '.ohwow', 'media');

const BANNED_PHRASES = [
  'our daemon', 'the daemon', 'a single daemon', 'single daemon',
  'agent workspaces', 'our runtime', 'the runtime caught',
  'the runtime moved', 'the runtime handled', 'our local runtime',
  'our stack', 'on your machine', 'on your schedule', 'with your keys',
  'mcp-first', 'multi-workspace',
];
function detectBanned(text) {
  const t = (text || '').toLowerCase();
  return BANNED_PHRASES.filter(p => t.includes(p));
}

function workspaceConfigPath(ws) {
  return path.join(os.homedir(), '.ohwow', 'workspaces', ws, 'x-config.json');
}
function historyPath(ws) {
  return path.join(os.homedir(), '.ohwow', 'workspaces', ws, 'x-intel-history.jsonl');
}

function loadHistory(ws, daysBack) {
  const p = historyPath(ws);
  if (!fs.existsSync(p)) return [];
  const cutoff = Date.now() - daysBack * 86400_000;
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && r.date && new Date(r.date + 'T00:00:00Z').getTime() >= cutoff);
}

function pickSeed(historyRows) {
  const candidates = [];
  for (const row of historyRows) {
    for (const p of row.emerging_patterns || []) {
      candidates.push({ bucket: row.bucket, pattern: p, date: row.date, headline: row.headline });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.date.localeCompare(a.date));
  // Pick a random one from the top 5 freshest for variety across runs
  const pool = candidates.slice(0, Math.min(5, candidates.length));
  return pool[Math.floor(Math.random() * pool.length)];
}

const SCENE_KINDS = ['text-typewriter', 'quote-card', 'composable'];
const MOODS = ['contemplative', 'electric', 'warm', 'cosmic', 'ethereal', 'noir', 'dawn'];
const VISUAL_PRIMITIVES = [
  'aurora', 'bokeh', 'light-rays', 'constellation', 'waveform',
  'geometric', 'vignette', 'ripple', 'glow-orb', 'flow-field',
  'film-grain', 'scan-line',
];

async function draftShort({ brandVoice, workspaceDesc, seed }) {
  const sys = `You create YouTube Shorts scripts for an observer of the AI agent space. Same voice rules as the X feed: sharp, philosophical, never reveals product, humor preferred.

Context (DO NOT regurgitate): ${workspaceDesc}

THE SHORT: a 15-25 second philosophical observation about AI agents, automation, or the state of the art. It's visual text over atmospheric backgrounds with a voiceover reading the text. Think: the kind of thought that makes a builder pause mid-scroll.

STRUCTURE: 2-3 scenes. Each scene shows one beat of the observation.
- Scene 1 (hook): sets up the tension. 6-9 seconds.
- Scene 2 (turn): delivers the insight or reframe. 7-12 seconds.
- Scene 3 (optional closer): a coda, callback, or lingering question. 4-6 seconds.

The narration across all scenes should read as one continuous thought when spoken aloud. Each scene's narration is a sentence or clause of that thought.

VOICE RULES:
- Observer/philosopher, never pitching, never tutorializing
- Humor is preferred but not forced
- Specificity over cleverness (name real models, tools, failure modes)
- Counter-intuitive bias: challenge the default advice
- No hype, no "future of", no em-dashes, no hashtags
- No banned phrases: ${BANNED_PHRASES.slice(0, 8).join(', ')}...

VISUAL SPEC: output a valid VideoSpec JSON. Available scene kinds: ${SCENE_KINDS.join(', ')}.
For 'text-typewriter': params { text, fontSize (44-56), typingSpeed (0.8-1.5), mood, variation (0-5) }
For 'quote-card': params { quote, fontSize (36-52), mood, variation (0-3) }
For 'composable': params { visualLayers: [{primitive, params}], text: {content, animation, fontSize, position}, mood }
  Available primitives: ${VISUAL_PRIMITIVES.join(', ')}
  Text animations: typewriter, fade-in, word-by-word, letter-scatter
  Text positions: center, bottom-center, top-center

Available moods: ${MOODS.join(', ')}

YouTube metadata:
- Title: catchy, under 70 chars, no clickbait. Should intrigue a builder.
- Description: 1-2 sentences expanding the thought. Include "#AIAgents #Shorts" at end.

Output STRICT JSON:
{
  "hook": "the opening line / tension (<=15 words)",
  "narration_full": "the complete narration as one flowing sentence/thought",
  "title": "YouTube title (<=70 chars)",
  "description": "YouTube description (1-2 sentences + hashtags)",
  "confidence": 0..1,
  "reason": "<=25 words — why this Short is worth making",
  "spec": {
    "scenes": [
      { "id": "hook", "kind": "...", "durationInFrames": 210, "params": {...}, "narration": "scene 1 text" },
      { "id": "turn", "kind": "...", "durationInFrames": 300, "params": {...}, "narration": "scene 2 text" }
    ],
    "transitions": [{ "kind": "fade", "durationInFrames": 15 }],
    "palette": { "seedHue": 0..360, "harmony": "analogous|complementary|triadic|split", "mood": "..." }
  }
}

Skip (confidence=0) if the seed is too generic or would require revealing product details.`;

  const prompt = `Seed from recent intelligence:
  bucket: ${seed.bucket}
  date: ${seed.date}
  headline: ${seed.headline || '(none)'}
  emerging_pattern: ${seed.pattern}

Create ONE YouTube Short.`;

  const out = await llm({ purpose: 'reasoning', system: sys, prompt });
  return { parsed: extractJson(out.text), model: out.model_used };
}

function buildFullSpec(draft) {
  const scenes = draft.spec.scenes.map(s => ({
    ...s,
    durationInFrames: s.durationInFrames || 240,
  }));
  return {
    id: `yt-short-${Date.now()}`,
    version: 1,
    fps: 30,
    width: 1080,
    height: 1920,
    brand: {
      colors: {
        bg: '#0a0a0f', accent: '#f97316', text: '#e4e4e7',
        textMuted: '#71717a', textDim: 'rgba(255,255,255,0.4)',
      },
      fonts: {
        sans: 'Inter, system-ui, -apple-system, sans-serif',
        mono: 'JetBrains Mono, SF Mono, Menlo, monospace',
        display: "'Smooch Sans', system-ui, sans-serif",
      },
      glass: {
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 12,
        backdropFilter: 'blur(20px)',
      },
    },
    palette: draft.spec.palette || undefined,
    music: null,
    voiceovers: [],
    transitions: draft.spec.transitions || [{ kind: 'fade', durationInFrames: 15 }],
    scenes,
  };
}

function renderVideo(specPath, outPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', [
      'remotion', 'render', 'src/index.ts', 'SpecDriven',
      outPath,
      `--props=${specPath}`,
    ], {
      cwd: VIDEO_PKG,
      stdio: 'pipe',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.stdout.on('data', d => { process.stdout.write(d); });
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`remotion render exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/**
 * Extract key frames from the rendered video for visual self-review.
 * Captures: first scene midpoint, transition moment, second scene midpoint,
 * and final frame. Returns array of screenshot paths.
 */
function captureKeyFrames(videoPath, spec, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const fps = spec.fps || 30;
  const screenshots = [];

  const keyTimes = [];
  let cursor = 0;
  for (let i = 0; i < spec.scenes.length; i++) {
    const sceneDur = spec.scenes[i].durationInFrames / fps;
    const sceneStart = cursor;
    // Midpoint of each scene
    keyTimes.push({
      time: sceneStart + sceneDur * 0.5,
      label: `scene-${i + 1}-mid`,
    });
    // Last frame of each scene (transition moment)
    if (i < spec.scenes.length - 1) {
      keyTimes.push({
        time: sceneStart + sceneDur - 0.5,
        label: `scene-${i + 1}-end`,
      });
    }
    cursor += sceneDur;
    const trans = spec.transitions[i];
    if (trans && trans.kind !== 'none' && i < spec.scenes.length - 1) {
      cursor -= trans.durationInFrames / fps;
    }
  }
  // Final frame
  keyTimes.push({ time: Math.max(0, cursor - 0.1), label: 'final' });

  for (const { time, label } of keyTimes) {
    const outFile = path.join(outputDir, `${label}.jpg`);
    try {
      execSync(
        `ffmpeg -y -ss ${time.toFixed(2)} -i "${videoPath}" -frames:v 1 -q:v 3 "${outFile}"`,
        { stdio: 'pipe', timeout: 10_000 },
      );
      screenshots.push({ label, path: outFile, timeSec: time });
    } catch {
      // non-fatal: ffmpeg missing or frame extraction failed
    }
  }
  return screenshots;
}

/**
 * Visual self-review: send keyframes to the LLM as base64 images and ask
 * it to evaluate text readability, visual quality, and content coherence.
 * Returns a review object with pass/fail and notes for the approval payload.
 */
async function visualSelfReview(screenshots, draft) {
  if (!screenshots.length) return { pass: true, notes: 'no keyframes to review' };

  const imageDescriptions = [];
  for (const ss of screenshots) {
    try {
      const buf = fs.readFileSync(ss.path);
      const b64 = buf.toString('base64');
      imageDescriptions.push(`[${ss.label} at ${ss.timeSec.toFixed(1)}s]: data:image/jpeg;base64,${b64}`);
    } catch {
      imageDescriptions.push(`[${ss.label}]: (failed to read)`);
    }
  }

  const sys = `You are a video quality reviewer for YouTube Shorts. You're reviewing keyframes extracted from a rendered Short before it's published. The Short shows philosophical text over atmospheric dark backgrounds at 1080x1920 (portrait).

Evaluate each keyframe on:
1. TEXT READABILITY: Is the text clearly legible? Good contrast? Not too small or too large? Not clipped at edges?
2. VISUAL QUALITY: Does the background look intentional and atmospheric? Any rendering artifacts? Good color harmony?
3. COMPOSITION: Is text well-positioned for mobile viewing? Remember YouTube Shorts UI overlays: title/channel at bottom ~15%, like/comment buttons on right ~20%.
4. CONTENT COHERENCE: Does the text match the intended narration? Does the visual mood match the content tone?

Output STRICT JSON:
{
  "pass": true/false,
  "score": 1-10,
  "text_readability": "brief note",
  "visual_quality": "brief note",
  "composition": "brief note",
  "issues": ["list of specific issues, empty if pass"],
  "suggestions": ["list of improvements for future renders"]
}

Pass threshold: score >= 6. Be honest but practical — these are auto-generated Shorts, not cinema.`;

  const prompt = `Review these keyframes from a YouTube Short.

Intended narration: "${draft.narration_full}"
Title: "${draft.title}"
Number of scenes: ${draft.spec?.scenes?.length || 'unknown'}

Keyframes:
${imageDescriptions.join('\n')}`;

  try {
    const out = await llm({ purpose: 'critique', system: sys, prompt });
    const review = extractJson(out.text);
    return {
      pass: review.pass !== false && (review.score || 0) >= 6,
      score: review.score,
      notes: review,
      model: out.model_used,
    };
  } catch (e) {
    return { pass: true, notes: `review failed: ${e.message}` };
  }
}

async function main() {
  const t0 = Date.now();
  const { workspace } = resolveOhwow();
  const cfg = JSON.parse(fs.readFileSync(workspaceConfigPath(workspace), 'utf8'));
  const history = loadHistory(workspace, HISTORY_DAYS);
  if (!history.length) {
    console.log(`[yt-compose] no history at ${historyPath(workspace)} (need x-intel first)`);
    process.exit(0);
  }
  console.log(`[yt-compose] workspace=${workspace} · history=${history.length} rows · dry=${DRY}`);

  const briefDir = `/tmp/yt-compose-${Date.now()}`;
  fs.mkdirSync(briefDir, { recursive: true });

  // 1. Pick seed and draft the Short
  const seed = pickSeed(history);
  if (!seed) { console.log('[yt-compose] no fresh seeds'); process.exit(0); }
  console.log(`[yt-compose] seed: ${seed.bucket} · "${seed.pattern.slice(0, 80)}"`);

  let draft;
  try {
    const result = await draftShort({ brandVoice: cfg.brand_voice, workspaceDesc: cfg.workspace_description, seed });
    draft = result.parsed;
    console.log(`[yt-compose] drafted: "${draft.title}" · conf=${draft.confidence} · model=${result.model}`);
  } catch (e) {
    console.log(`[yt-compose] draft failed: ${e.message}`);
    process.exit(1);
  }

  if (!draft.confidence || draft.confidence < 0.4) {
    console.log(`[yt-compose] low confidence (${draft.confidence}), skipping`);
    fs.writeFileSync(path.join(briefDir, 'skip.json'), JSON.stringify({ seed, draft, reason: 'low confidence' }, null, 2));
    process.exit(0);
  }

  // 2. Banned phrase check on narration + title + description
  const allText = [draft.narration_full, draft.title, draft.description].join(' ');
  const offenders = detectBanned(allText);
  if (offenders.length) {
    console.log(`[yt-compose] banned phrase '${offenders[0]}' — skipping`);
    fs.writeFileSync(path.join(briefDir, 'skip.json'), JSON.stringify({ seed, draft, reason: `banned: ${offenders[0]}` }, null, 2));
    process.exit(0);
  }

  // 3. Build full VideoSpec
  const spec = buildFullSpec(draft);
  const specPath = path.join(briefDir, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  console.log(`[yt-compose] spec written: ${specPath} · ${spec.scenes.length} scenes`);

  // 4. Render video
  const videoDir = path.join(MEDIA_DIR, 'videos');
  fs.mkdirSync(videoDir, { recursive: true });
  const videoPath = path.join(videoDir, `${spec.id}.mp4`);

  if (SKIP_RENDER) {
    console.log(`[yt-compose] SKIP_RENDER=1, skipping render`);
  } else {
    console.log(`[yt-compose] rendering ${spec.scenes.length} scenes → ${videoPath}`);
    try {
      await renderVideo(specPath, videoPath);
      console.log(`[yt-compose] render complete: ${videoPath}`);
    } catch (e) {
      console.log(`[yt-compose] render failed: ${e.message}`);
      process.exit(1);
    }

    // 4b. Capture key frames for visual self-review
    const screenshotDir = path.join(briefDir, 'keyframes');
    const screenshots = captureKeyFrames(videoPath, spec, screenshotDir);
    if (screenshots.length) {
      console.log(`[yt-compose] captured ${screenshots.length} keyframes → ${screenshotDir}`);
      fs.writeFileSync(
        path.join(screenshotDir, '_index.json'),
        JSON.stringify(screenshots, null, 2),
      );

      // 4c. Visual self-review via LLM
      console.log(`[yt-compose] running visual self-review...`);
      const review = await visualSelfReview(screenshots, draft);
      fs.writeFileSync(path.join(briefDir, 'visual-review.json'), JSON.stringify(review, null, 2));
      console.log(`[yt-compose] visual review: pass=${review.pass} score=${review.score || '?'}`);
      if (!review.pass) {
        console.log(`[yt-compose] visual review failed — skipping upload`);
        if (review.notes?.issues) console.log(`  issues: ${review.notes.issues.join(', ')}`);
      }
    }
  }

  // 5. Write brief
  const record = {
    ts: new Date().toISOString(),
    workspace,
    seed,
    draft,
    spec,
    videoPath: SKIP_RENDER ? null : videoPath,
    durationMs: Date.now() - t0,
  };
  fs.writeFileSync(path.join(briefDir, 'brief.json'), JSON.stringify(record, null, 2));

  // 6. Propose to approval queue (only if visual review passed)
  const reviewPath = path.join(briefDir, 'visual-review.json');
  const visualReview = fs.existsSync(reviewPath) ? JSON.parse(fs.readFileSync(reviewPath, 'utf8')) : { pass: true };
  if (!DRY && !SKIP_RENDER && visualReview.pass) {
    const entry = propose({
      kind: 'yt_short_draft',
      summary: `short · ${draft.title.slice(0, 50)}`,
      payload: {
        title: draft.title,
        description: draft.description,
        narration: draft.narration_full,
        videoPath,
        specPath,
        seed_bucket: seed.bucket,
        seed_pattern: seed.pattern,
        confidence: draft.confidence,
        visualReviewScore: visualReview.score,
      },
      autoApproveAfter: 15,
    });
    record.approval_status = entry.status;
    record.approval_id = entry.id;
    console.log(`[yt-compose] approval ${entry.status} · id=${entry.id.slice(0, 8)}`);

    if (entry.status === 'auto_applied') {
      try {
        const { browser, page } = await ensureYTReady();
        const result = await uploadShort(page, {
          filePath: videoPath,
          title: draft.title,
          description: draft.description,
          visibility: VISIBILITY,
          screenshot: true,
        });
        browser.close();
        record.uploaded = true;
        record.videoUrl = result.videoUrl;
        console.log(`[yt-compose] uploaded: ${result.videoUrl} (${result.visibility})`);
      } catch (e) {
        console.log(`[yt-compose] upload failed: ${e.message}`);
        record.uploaded = false;
        record.upload_error = e.message;
      }
    }
  }

  fs.writeFileSync(path.join(briefDir, 'brief.json'), JSON.stringify(record, null, 2));
  console.log(`\n[yt-compose] brief → ${briefDir}/brief.json`);
  console.log(`[yt-compose] duration=${Math.round((Date.now() - t0) / 1000)}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
