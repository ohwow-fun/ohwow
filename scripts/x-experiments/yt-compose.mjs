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
 *   VOICE_PROVIDER=openrouter (default) | kokoro
 *   VOICE_NAME=onyx          voice preset (openrouter: alloy/ash/ballad/coral/
 *                            echo/fable/nova/onyx/sage/shimmer/verse)
 *   VISIBILITY=unlisted      YouTube visibility (private/unlisted/public)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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
  // First-person product framing: observer voice means no ownership claims
  'my agent', 'my agents', 'my ai', 'our agent', 'our agents',
  'we built', 'we ship', 'we run', 'we use', 'i built', 'i ship',
  'local-first', 'orchestration layer',
];
function detectBanned(text) {
  const t = (text || '').toLowerCase();
  return BANNED_PHRASES.filter(p => t.includes(p));
}

function readOpenRouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ohwow', 'config.json'), 'utf8'));
    return cfg.openRouterApiKey || null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Voice generation — OpenRouter gpt-audio-mini (primary) or Kokoro (local)
// ---------------------------------------------------------------------------
// VOICE_PROVIDER=openrouter (default) uses openai/gpt-audio-mini via OpenRouter.
// VOICE_PROVIDER=kokoro uses a locally-running Kokoro FastAPI server on :8880.
// VOICE_NAME overrides the default voice preset for the active provider.
const VOICE_PROVIDER = process.env.VOICE_PROVIDER || 'openrouter';
const OPENROUTER_DEFAULT_VOICE = 'onyx';
const KOKORO_DEFAULT_VOICE = 'af_heart';
const VOICE_NAME = process.env.VOICE_NAME
  || (VOICE_PROVIDER === 'kokoro' ? KOKORO_DEFAULT_VOICE : OPENROUTER_DEFAULT_VOICE);
const VOICE_SPEED = 1.0;
const VOICE_LEAD_FRAMES = 5;
const VOICE_TAIL_FRAMES = 20;
const SCENE_MIN_FRAMES = 90;
const KOKORO_URL = 'http://127.0.0.1:8880';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TTS_MODEL = 'openai/gpt-audio-mini';

// Strict system prompt that turns the conversational gpt-audio model into a
// verbatim TTS engine. Without this the model answers the input as dialog.
const TTS_SYSTEM_PROMPT =
  'You are a TTS engine. The user will send text in quotes. You must speak ' +
  'exactly the quoted text, verbatim, with natural prosody. Never respond, ' +
  'never acknowledge, never add words. Just read what is between the quotes.';

async function kokoroAvailable() {
  try {
    const r = await fetch(`${KOKORO_URL}/v1/audio/voices`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

/**
 * Save an MP3 buffer under ~/.ohwow/media/audio/ with a content-addressable
 * filename (first 16 hex of sha256). Returns the absolute path.
 */
function saveVoiceMp3(buffer) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const audioDir = path.join(os.homedir(), '.ohwow', 'media', 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const filePath = path.join(audioDir, `voice-${hash.slice(0, 16)}.mp3`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * Generate voiceover via Kokoro FastAPI (local, free). Returns null if the
 * server is not reachable on localhost:8880.
 */
async function generateVoiceKokoro(text, voice, speed = VOICE_SPEED) {
  if (!(await kokoroAvailable())) {
    console.log('[yt-compose] kokoro not available on :8880');
    return null;
  }
  const resp = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'kokoro', input: text, voice, speed, response_format: 'mp3' }),
  });
  if (!resp.ok) throw new Error(`Kokoro TTS ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  const filePath = saveVoiceMp3(buffer);
  console.log(`[yt-compose] voice (kokoro ${voice}): ${Math.round(buffer.length / 1024)}KB → ${filePath}`);
  return filePath;
}

/**
 * Generate voiceover via OpenRouter gpt-audio-mini. The model requires
 * streaming + pcm16 output; we transcode to MP3 via ffmpeg after collecting
 * the raw PCM buffer (24kHz mono 16-bit).
 */
async function generateVoiceOpenRouter(text, voice) {
  const apiKey = readOpenRouterKey();
  if (!apiKey) {
    console.log('[yt-compose] no OpenRouter API key, skipping voiceover');
    return null;
  }
  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://ohwow.fun',
      'X-Title': 'OHWOW',
    },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model: TTS_MODEL,
      modalities: ['text', 'audio'],
      audio: { voice, format: 'pcm16' },
      stream: true,
      messages: [
        { role: 'system', content: TTS_SYSTEM_PROMPT },
        { role: 'user', content: `Read this aloud: "${text}"` },
      ],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`OpenRouter TTS ${resp.status}: ${err.slice(0, 200)}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let sseBuf = '', b64 = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuf += decoder.decode(value, { stream: true });
    const lines = sseBuf.split('\n');
    sseBuf = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const chunk = JSON.parse(payload);
        const audio = chunk.choices?.[0]?.delta?.audio ?? chunk.choices?.[0]?.message?.audio;
        if (audio?.data) b64 += audio.data;
      } catch {}
    }
  }
  if (!b64) throw new Error('OpenRouter TTS returned no audio');

  // pcm16 @ 24kHz mono → mp3 via ffmpeg. Use a temp pcm file to avoid ffmpeg stdin buffering.
  const pcmBuffer = Buffer.from(b64, 'base64');
  const tmpPcm = path.join(os.tmpdir(), `voice-${Date.now()}.pcm`);
  fs.writeFileSync(tmpPcm, pcmBuffer);
  const tmpMp3 = path.join(os.tmpdir(), `voice-${Date.now()}.mp3`);
  execSync(
    `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${tmpPcm}" -c:a libmp3lame -q:a 4 "${tmpMp3}"`,
    { stdio: 'pipe' },
  );
  const mp3Buffer = fs.readFileSync(tmpMp3);
  fs.unlinkSync(tmpPcm);
  fs.unlinkSync(tmpMp3);

  const filePath = saveVoiceMp3(mp3Buffer);
  const durSec = pcmBuffer.length / 2 / 24000;
  console.log(`[yt-compose] voice (openrouter ${voice}): ${durSec.toFixed(2)}s, ${Math.round(mp3Buffer.length / 1024)}KB → ${filePath}`);
  return filePath;
}

/**
 * Unified voiceover generator. Routes to the configured provider and falls
 * back to Kokoro if OpenRouter is selected but no API key is configured.
 */
async function generateVoiceOver(text, voice = VOICE_NAME) {
  try {
    if (VOICE_PROVIDER === 'kokoro') return await generateVoiceKokoro(text, voice);
    const result = await generateVoiceOpenRouter(text, voice);
    if (result) return result;
    // OpenRouter unavailable → try Kokoro as last resort
    console.log('[yt-compose] OpenRouter TTS unavailable, trying Kokoro...');
    return await generateVoiceKokoro(text, KOKORO_DEFAULT_VOICE);
  } catch (e) {
    console.log(`[yt-compose] voice generation failed: ${e.message}`);
    return null;
  }
}

function stageVoiceFile(srcPath) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(srcPath)).digest('hex');
  const voiceDir = path.join(VIDEO_PKG, 'public', 'voice');
  fs.mkdirSync(voiceDir, { recursive: true });
  const staged = path.join(voiceDir, `${hash.slice(0, 16)}.mp3`);
  if (!fs.existsSync(staged)) fs.copyFileSync(srcPath, staged);
  return `voice/${hash.slice(0, 16)}.mp3`;
}

function getAudioDurationMs(filePath) {
  try {
    const out = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`,
      { timeout: 5000, encoding: 'utf8' },
    );
    return Math.round(parseFloat(out.trim()) * 1000);
  } catch {
    return null;
  }
}

function alignSceneDurations(scenes, audioDurationMs, fps = 30) {
  const totalAudioFrames = Math.ceil((audioDurationMs / 1000) * fps);
  const words = scenes.map(s => (s.narration || s.params?.text || '').split(/\s+/).filter(Boolean).length);
  const totalWords = words.reduce((a, b) => a + b, 0) || 1;
  const padding = VOICE_LEAD_FRAMES + VOICE_TAIL_FRAMES;
  const usableFrames = totalAudioFrames + padding * scenes.length;

  return scenes.map((s, i) => {
    const proportion = (words[i] || 1) / totalWords;
    const rawFrames = Math.round(proportion * totalAudioFrames) + padding;
    return {
      ...s,
      durationInFrames: Math.max(SCENE_MIN_FRAMES, rawFrames),
    };
  });
}

// ---------------------------------------------------------------------------
// Visual self-review — OpenRouter vision API (cheap Gemini Flash Lite)
// ---------------------------------------------------------------------------
const REVIEW_MODEL = 'google/gemini-2.5-flash-lite';

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
  // Diversify across buckets: group by bucket, pick a random bucket first,
  // then pick a random pattern from it. Prevents all Shorts from clustering
  // on the most populated bucket.
  const byBucket = {};
  for (const c of candidates) {
    (byBucket[c.bucket] ??= []).push(c);
  }
  const buckets = Object.keys(byBucket);
  const bucket = buckets[Math.floor(Math.random() * buckets.length)];
  const pool = byBucket[bucket];
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
  const sys = `You write YouTube Shorts scripts. You are a sharp observer of the AI agent space who NEVER reveals what they build.

Context (DO NOT regurgitate or reference): ${workspaceDesc}

SHORTS PSYCHOLOGY (non-negotiable):
1. CURIOSITY GAP in first 1.5 seconds. The hook MUST be incomplete, counterintuitive, or provoke disagreement. The viewer stays because they NEED the resolution. "Everyone assumes X" works. "X is interesting" does not.
2. PATTERN INTERRUPT between scenes. Each scene shift must feel like a gear change: mood shift, visual contrast, pacing change. Monotone = swipe.
3. EMOTIONAL VALENCE over information. Shorts that provoke (surprise, recognition, disagreement, dark humor) get shared. Informational ones get scrolled past. You're not teaching. You're making someone feel something.
4. ESCALATION. Each beat hits harder than the last. Hook → escalate → land. Never plateau.
5. BREVITY IS THE FORM. 5-12 words per scene. If you need a paragraph, it's not a Short. The constraint is the style. White space is your friend.
6. REWATCH VALUE. The punchline should recontextualize the hook. A viewer who watches twice catches something they missed.
7. VISCERAL > CEREBRAL. "The agent deleted its own context window" hits harder than "context management is a challenge." Show the moment, not the analysis.

STRUCTURE: exactly 2 scenes, occasionally 3. Total 12-20 seconds (360-600 frames at 30fps).
- Scene 1 (hook): the setup, the assumption, the thing everyone believes. 4-7 seconds (120-210 frames). SHORT text, BIG font.
- Scene 2 (turn): the twist, the reframe, the punchline. 6-10 seconds (180-300 frames). Mood MUST contrast scene 1.
- Scene 3 (optional coda): only if the joke needs a callback or the thought needs a lingering beat. 3-5 seconds (90-150 frames). One line max.

WORD LIMITS PER SCENE (HARD):
- Scene text: 5-12 words. NEVER more than 15. If you wrote more, you failed.
- Total narration: under 30 words for 2 scenes, under 40 for 3.

VOICE: an insider at a dinner party who has opinions on everything in AI agents. Not pitching, not teaching. Just being interesting. Wry, observational, occasionally dark.
- NEVER reference your own product, stack, architecture, tools, or infrastructure
- NEVER use: "local-first", "orchestration", "runtime", "workspaces", "daemon", "our", "we built", "my agent", "my agents", "mine", "I built", "I run"
- NEVER claim ownership of agents, tools, or infrastructure. You OBSERVE. You don't OWN.
- Think in universal AI/agent concepts any builder would recognize
- Humor preferred. If you can land the joke, always land it.
- No banned phrases: ${BANNED_PHRASES.join(', ')}

MOOD CONTRAST is mandatory. Scene 1 and Scene 2 must use DIFFERENT moods. Vary across runs.
Good contrasts: contemplative → electric, warm → noir, cosmic → dawn, ethereal → electric, dawn → noir.
Do NOT always default to contemplative → noir. Surprise with the mood pairing.

VISUAL SPEC: output a valid VideoSpec JSON. Available scene kinds: ${SCENE_KINDS.join(', ')}.
For 'text-typewriter': params { text, fontSize (48-64 for short text), typingSpeed (1.0-2.0), mood, variation (0-5) }
For 'quote-card': params { quote, fontSize (40-60), mood, variation (0-3) }
For 'composable': params { visualLayers: [{primitive, params}], text: {content, animation, fontSize (40-52), position, maxWidth (800)}, mood }
  Available primitives: ${VISUAL_PRIMITIVES.join(', ')}
  Text animations: typewriter, fade-in, word-by-word, letter-scatter
  Text positions: center, bottom-center, top-center
  VISUAL DEPTH: composable scenes MUST have 2-4 visual layers. Single glow-orb backgrounds look cheap. Layer for depth:
    - Base atmosphere: aurora, flow-field, or constellation (slow, fills the frame)
    - Mid accent: bokeh, light-rays, or waveform (movement, draws eye)
    - Top texture: film-grain or scan-line (grounds the image, adds production value)
    - Optional: vignette or ripple for focus/emphasis
  Good combos: aurora+bokeh+film-grain, constellation+light-rays+vignette, flow-field+geometric+scan-line

Available moods: ${MOODS.join(', ')}

FONT SIZE RULE: shorter text = bigger font. 5-7 words → fontSize 56-64. 8-12 words → fontSize 44-52. This is mobile at 1080px wide with 120px padding each side (840px text area). Words longer than 8 chars will wrap if fontSize is too large. For composable scenes, use maxWidth: 800 and fontSize 40-48 to prevent mid-word breaks.

YouTube metadata:
- Title: curiosity-driven, under 60 chars, makes someone tap. Not a summary.
- Description: 1-2 sentences. "#AIAgents #Shorts" at end.

Output STRICT JSON:
{
  "hook": "the opening line / tension (<=12 words)",
  "narration_full": "complete narration, all scenes joined (<=40 words total)",
  "title": "YouTube title (<=60 chars)",
  "description": "YouTube description",
  "confidence": 0..1,
  "reason": "<=20 words — what emotion this provokes and why someone rewatches",
  "spec": {
    "scenes": [
      { "id": "hook", "kind": "...", "durationInFrames": 150, "params": {...}, "narration": "5-12 words" },
      { "id": "turn", "kind": "...", "durationInFrames": 240, "params": {...}, "narration": "5-12 words" }
    ],
    "transitions": [{ "kind": "fade", "durationInFrames": 12 }],
    "palette": { "seedHue": 0..360, "harmony": "analogous|complementary|triadic|split", "mood": "..." }
  }
}

SELF-CHECK before outputting: count words per scene. If any scene > 15 words, rewrite it shorter. If total > 40 words, cut. If both scenes use the same mood, change one.

Skip (confidence=0) if: the seed is too generic, would reveal product, or the best version is still boring.`;

  const prompt = `Seed from recent intelligence:
  bucket: ${seed.bucket}
  date: ${seed.date}
  headline: ${seed.headline || '(none)'}
  emerging_pattern: ${seed.pattern}

Create ONE YouTube Short.`;

  const out = await llm({ purpose: 'reasoning', system: sys, prompt });
  return { parsed: extractJson(out.text), model: out.model_used };
}

function enrichVisualLayers(scene) {
  if (scene.kind !== 'composable') return scene;
  const layers = scene.params?.visualLayers || [];
  if (layers.length >= 2) return scene;
  const existing = new Set(layers.map(l => l.primitive));
  const defaults = [
    { primitive: 'film-grain', params: { opacity: 0.3 } },
    { primitive: 'vignette', params: { intensity: 0.6 } },
  ];
  const toAdd = defaults.filter(d => !existing.has(d.primitive)).slice(0, 2 - layers.length);
  return {
    ...scene,
    params: { ...scene.params, visualLayers: [...layers, ...toAdd] },
  };
}

const AMBIENT_MOOD_MAP = {
  contemplative: 'ambient-contemplative.mp3',
  cosmic:        'ambient-cosmic.mp3',
  electric:      'ambient-electric.mp3',
  dawn:          'ambient-electric.mp3',
  warm:          'ambient-warm.mp3',
  noir:          'ambient-noir.mp3',
  ethereal:      'ambient-cosmic.mp3',
};
const AMBIENT_FALLBACK = 'ambient.mp3';

function pickAmbientTrack(paletteMood) {
  const mood = (paletteMood || '').toLowerCase();
  const file = AMBIENT_MOOD_MAP[mood];
  if (file && fs.existsSync(path.join(VIDEO_PKG, 'public', 'audio', file))) return `audio/${file}`;
  return `audio/${AMBIENT_FALLBACK}`;
}

function buildFullSpec(draft, { voiceoverRef = null, audioDurationMs = null } = {}) {
  let scenes = draft.spec.scenes.map(s => enrichVisualLayers({
    ...s,
    durationInFrames: s.durationInFrames || 240,
  }));

  if (audioDurationMs && audioDurationMs > 0) {
    scenes = alignSceneDurations(scenes, audioDurationMs);
    console.log(`[yt-compose] aligned scene durations to ${audioDurationMs}ms audio: ${scenes.map(s => s.durationInFrames).join('+')}`);
  }

  const voiceovers = voiceoverRef
    ? [{ src: voiceoverRef, startFrame: VOICE_LEAD_FRAMES, volume: 0.9 }]
    : [];

  const ambientSrc = pickAmbientTrack(draft.spec.palette?.mood);
  console.log(`[yt-compose] ambient track: ${ambientSrc} (palette mood: ${draft.spec.palette?.mood || 'none'})`);

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
    music: { src: ambientSrc, startFrame: 0, volume: 0.15 },
    voiceovers,
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

  const apiKey = readOpenRouterKey();
  if (!apiKey) {
    console.log('[yt-compose] no OpenRouter API key, skipping visual review');
    return { pass: true, notes: 'no API key for vision review' };
  }

  const content = [];
  content.push({
    type: 'text',
    text: `Review these keyframes from a YouTube Short.\n\nIntended narration: "${draft.narration_full}"\nTitle: "${draft.title}"\nScenes: ${draft.spec?.scenes?.length || 'unknown'}`,
  });

  for (const ss of screenshots) {
    try {
      const buf = fs.readFileSync(ss.path);
      content.push({ type: 'text', text: `\n[${ss.label} at ${ss.timeSec.toFixed(1)}s]:` });
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` },
      });
    } catch {}
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

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://ohwow.fun',
        'X-Title': 'OHWOW',
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: REVIEW_MODEL,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content },
        ],
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`OpenRouter ${resp.status}: ${errText.slice(0, 200)}`);
    }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '';
    const review = extractJson(text);
    return {
      pass: review.pass !== false && (review.score || 0) >= 6,
      score: review.score,
      notes: review,
      model: REVIEW_MODEL,
    };
  } catch (e) {
    console.log(`[yt-compose] visual review error: ${e.message}`);
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

  // 3. Generate voiceover (before spec build so duration informs scene timing)
  let voiceoverRef = null;
  let audioDurationMs = null;
  if (!SKIP_VOICE && draft.narration_full) {
    const voicePath = await generateVoiceOver(draft.narration_full);
    if (voicePath) {
      voiceoverRef = stageVoiceFile(voicePath);
      audioDurationMs = getAudioDurationMs(voicePath);
      console.log(`[yt-compose] voiceover: ${voiceoverRef} · ${audioDurationMs}ms`);
    }
  } else if (SKIP_VOICE) {
    console.log('[yt-compose] SKIP_VOICE=1, skipping voiceover');
  }

  // 4. Build full VideoSpec (scene durations aligned to audio if available)
  const spec = buildFullSpec(draft, { voiceoverRef, audioDurationMs });
  const specPath = path.join(briefDir, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  console.log(`[yt-compose] spec written: ${specPath} · ${spec.scenes.length} scenes`);

  // 5. Render video
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

    // 5b. Capture key frames for visual self-review
    const screenshotDir = path.join(briefDir, 'keyframes');
    const screenshots = captureKeyFrames(videoPath, spec, screenshotDir);
    if (screenshots.length) {
      console.log(`[yt-compose] captured ${screenshots.length} keyframes → ${screenshotDir}`);
      fs.writeFileSync(
        path.join(screenshotDir, '_index.json'),
        JSON.stringify(screenshots, null, 2),
      );

      // 5c. Visual self-review via OpenRouter vision
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

  // 6. Write brief
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

  // 7. Propose to approval queue (only if visual review passed)
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
