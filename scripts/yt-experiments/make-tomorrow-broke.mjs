#!/usr/bin/env node
/**
 * make-tomorrow-broke — deterministic Tomorrow Broke episode pipeline
 *
 * Reads a minimal episode definition and runs the full pipeline without
 * any AI-inferred decisions. Every brand, style, transition, and audio
 * choice is hardcoded here.
 *
 * Steps:
 *  1. Generate Seedance Lite clips (sequential, resumable)
 *  2. Generate TTS via OpenRouter onyx (sequential, resumable)
 *  3. Generate outro sting via Lyria (once, cached forever)
 *  4. Build full VideoSpec with all Tomorrow Broke defaults
 *  5. Render with Remotion
 *
 * Usage: node scripts/yt-experiments/make-tomorrow-broke.mjs path/to/episode.json
 *
 * Episode format: see tomorrow-broke-episode.schema.json
 * Progress is saved to specs/tomorrow-broke-<slug>.progress.json after each
 * successful clip and voice file, so re-running resumes from last checkpoint.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync, spawn } from 'node:child_process';

// ─── Paths ────────────────────────────────────────────────────────────────
const REPO_ROOT  = path.resolve(import.meta.dirname, '../..');
const VIDEO_PKG  = path.join(REPO_ROOT, 'packages', 'video');
const SPECS_DIR  = path.join(REPO_ROOT, 'scripts/yt-experiments/specs');
const CLIPS_DIR  = path.join(VIDEO_PKG, 'public', 'clips');
const VOICE_DIR  = path.join(VIDEO_PKG, 'public', 'voice');
const AUDIO_DIR  = path.join(VIDEO_PKG, 'public', 'audio');
const OUT_DIR    = path.join(os.homedir(), '.ohwow', 'media', 'videos');
const STING_PATH = path.join(AUDIO_DIR, 'tomorrow-broke-sting.mp3');

for (const d of [CLIPS_DIR, VOICE_DIR, OUT_DIR, SPECS_DIR]) fs.mkdirSync(d, { recursive: true });

// ─── Config ───────────────────────────────────────────────────────────────
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ohwow', 'config.json'), 'utf8')); }
  catch { return {}; }
}
const cfg = loadConfig();
const FAL_KEY        = process.env.FAL_KEY             || cfg.falKey             || '';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY  || cfg.openRouterApiKey   || '';
const FAL_MODEL      = 'fal-ai/bytedance/seedance/v1/lite/text-to-video';

if (!FAL_KEY)        { console.error('Missing FAL_KEY');          process.exit(1); }
if (!OPENROUTER_KEY) { console.error('Missing OPENROUTER_API_KEY'); process.exit(1); }

// ─── Hardcoded Tomorrow Broke brand ───────────────────────────────────────
const TB_BRAND = {
  colors: {
    bg: '#050510', surface: 'rgba(12, 8, 28, 0.8)',
    accent: '#ff2d9c', accentDeep: '#a0126a', accentGlow: '#7c3aed',
    text: '#f4f1ff', textMuted: '#8d86b8', textDim: 'rgba(244, 241, 255, 0.35)',
    neonCyan: '#22d3ee', neonMagenta: '#ff2d9c',
  },
  fonts: {
    sans: 'Inter, system-ui, -apple-system, sans-serif',
    mono: 'JetBrains Mono, SF Mono, Menlo, monospace',
    display: "'Smooch Sans', system-ui, sans-serif",
  },
  glass: {
    background: 'rgba(12, 8, 28, 0.6)',
    border: '1px solid rgba(255, 45, 156, 0.25)',
    borderRadius: 2,
    backdropFilter: 'blur(24px)',
  },
};

// ─── Hardcoded timing constants ───────────────────────────────────────────
const FPS        = 30;
const VOICE_LEAD = 5;   // frames before voiceover starts inside each scene
const VOICE_TAIL = 20;  // frames after voiceover ends
const SCENE_MIN  = 90;  // minimum scene length in frames

// ─── Overlay layers auto-applied to every episode scene ───────────────────
// Vignette and grain intensify for the final two scenes (more cinematic weight).
function overlayLayers(isLast, isSecondToLast) {
  return [
    { primitive: 'film-grain', params: { intensity: isLast ? 0.35 : isSecondToLast ? 0.32 : 0.3 } },
    { primitive: 'scan-line',  params: {} },
    { primitive: 'vignette',   params: { intensity: isLast ? 0.85 : isSecondToLast ? 0.8 : 0.7 } },
  ];
}

// ─── Standard outro scene builder (150 frames = 5s, auto-appended) ──────────
// Fully grayscale. ohwow.fun logo + Smooch Sans display with wide tracking.
// Shows series name + chapter title + "BY OHWOW.FUN" subtitle.
function buildOutroScene(seriesName, chapterTitle) {
  return {
    id: 'outro',
    kind: 'composable',
    durationInFrames: 150,
    params: {
      mood: 'dark',
      pacing: 'reflective',
      visualLayers: [
        { primitive: 'gradient-wash', params: { colors: ['#000000', '#111111', '#000000'], speed: 0.002, opacity: 1 } },
        { primitive: 'glow-orb',      params: { cx: 0.5, cy: 0.32, size: 180, color: '#ffffff', pulseSpeed: 0.2 } },
        { primitive: 'image',         params: { src: 'ohwow-fun-logo.png', width: 64, height: 64, cx: 0.5, cy: 0.32, fadeIn: 25, opacity: 0.85 } },
        { primitive: 'film-grain',    params: { intensity: 0.18 } },
        { primitive: 'vignette',      params: { intensity: 0.92 } },
      ],
      text: {
        content:            `${seriesName}\n${chapterTitle.toUpperCase()}`,
        subtitle:           'BY OHWOW.FUN',
        animation:          'letter-scatter',
        position:           'center',
        fontSize:           52,
        fontWeight:         800,
        fontFamily:         'display',
        color:              '#ffffff',
        accentColor:        '#cccccc',
        letterSpacing:      '0.12em',
        filter:             'grayscale(1)',
        lineColors:         ['#ffffff', '#a0a0a0'],
        lineFontSizeRatios: [1, 0.72],
      },
    },
  };
}

// ─── Fal.ai Seedance Lite clip generation ─────────────────────────────────
const FAL_BASE  = 'https://queue.fal.run';
const POLL_MS   = 4000;
const MAX_POLLS = 300;

async function generateClip(sceneId, prompt) {
  console.log(`  [clip] ${sceneId}: submitting to Seedance Lite…`);
  const submitResp = await fetch(`${FAL_BASE}/${FAL_MODEL}`, {
    method: 'POST',
    headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, duration: '5', aspect_ratio: '16:9', resolution: '720p', seed: 0 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!submitResp.ok) {
    const txt = await submitResp.text().catch(() => '');
    throw new Error(`fal submit ${submitResp.status}: ${txt.slice(0, 300)}`);
  }
  const submit = await submitResp.json();
  if (!submit.status_url) throw new Error(`fal submit missing status_url`);

  let responseUrl = null;
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const poll = await fetch(submit.status_url, {
      headers: { Authorization: `Key ${FAL_KEY}` },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!poll?.ok) continue;
    const data = await poll.json();
    if (data.status === 'COMPLETED' && data.response_url) { responseUrl = data.response_url; break; }
    if (data.status === 'FAILED') throw new Error(`fal job failed for ${sceneId}`);
    if (i % 10 === 0) console.log(`  [clip] ${sceneId}: still queued… (${i * POLL_MS / 1000}s)`);
  }
  if (!responseUrl) throw new Error(`fal polling timed out for ${sceneId}`);

  const resultResp = await fetch(responseUrl, {
    headers: { Authorization: `Key ${FAL_KEY}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resultResp.ok) throw new Error(`fal result fetch ${resultResp.status}`);
  const result = await resultResp.json();
  const videoUrl = result?.video?.url ?? result?.data?.video?.url;
  if (!videoUrl) throw new Error(`fal result missing video.url`);

  const dl = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
  if (!dl.ok) throw new Error(`download ${dl.status}`);
  const buffer = Buffer.from(await dl.arrayBuffer());
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  const dest = path.join(CLIPS_DIR, `${hash}.mp4`);
  fs.writeFileSync(dest, buffer);
  console.log(`  [clip] ${sceneId} → clips/${hash}.mp4 (${(buffer.length / 1024).toFixed(0)}KB)`);
  return `clips/${hash}.mp4`;
}

// ─── OpenRouter TTS (onyx, verbatim noir narrator) ────────────────────────
const TTS_SYSTEM = [
  'You are a TTS engine reading for a short-form video. Speak exactly the quoted text, verbatim. Never respond, never add words.',
  'Noir narrator. Deadpan, understated, slightly ominous. Take your time. Let each sentence breathe.',
].join(' ');

async function generateTTS(text, sceneId) {
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://ohwow.fun',
      'X-Title': 'OHWOW',
    },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model: 'openai/gpt-audio-mini',
      modalities: ['text', 'audio'],
      audio: { voice: 'onyx', format: 'pcm16' },
      stream: true,
      messages: [
        { role: 'system', content: TTS_SYSTEM },
        { role: 'user',   content: `Read this aloud: "${text}"` },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`TTS ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);

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
  if (!b64) throw new Error(`TTS returned no audio for ${sceneId}`);

  const pcmBuf = Buffer.from(b64, 'base64');
  const tmpPcm = path.join(os.tmpdir(), `voice-${Date.now()}.pcm`);
  const tmpMp3 = path.join(os.tmpdir(), `voice-${Date.now()}.mp3`);
  fs.writeFileSync(tmpPcm, pcmBuf);
  execSync(`ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${tmpPcm}" -c:a libmp3lame -q:a 4 "${tmpMp3}"`, { stdio: 'pipe' });
  const mp3 = fs.readFileSync(tmpMp3);
  fs.unlinkSync(tmpPcm);
  fs.unlinkSync(tmpMp3);

  const hash = crypto.createHash('sha256').update(mp3).digest('hex').slice(0, 16);
  const dest = path.join(VOICE_DIR, `${hash}.mp3`);
  fs.writeFileSync(dest, mp3);
  const voiceMs = getAudioDurationMs(dest);
  console.log(`  [tts]  ${sceneId} → voice/${hash}.mp3 (${(voiceMs / 1000).toFixed(2)}s)`);
  return { src: `voice/${hash}.mp3`, voiceMs };
}

// ─── Lyria outro sting (generated once, cached forever) ───────────────────
const STING_PROMPT = 'Cinematic micro-stinger for a dark ambient YouTube series about automation and labor. '
  + 'A single deep resonant bass note with shimmering high-frequency overtones. '
  + 'Sustained minor chord slowly decaying to silence. Electronic ambient. '
  + 'Piano with reverb, cello drone. No percussion, no melody, no vocals.';

async function ensureOustroSting() {
  if (fs.existsSync(STING_PATH)) {
    console.log(`  [sting] cached → audio/tomorrow-broke-sting.mp3 (${(getAudioDurationMs(STING_PATH) / 1000).toFixed(2)}s)`);
    return 'audio/tomorrow-broke-sting.mp3';
  }
  console.log(`  [sting] generating via Lyria (first-time, will cache)…`);

  let b64 = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://ohwow.fun',
        'X-Title': 'OHWOW',
      },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: 'google/lyria-3-clip-preview',
        messages: [{ role: 'user', content: STING_PROMPT }],
        modalities: ['audio'],
        audio: { format: 'mp3' },
        stream: true,
      }),
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      throw new Error(`Lyria ${resp.status}: ${err.slice(0, 200)}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let sseBuf = '';
    b64 = '';
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
    // drain any partial SSE line left in buffer
    if (sseBuf.startsWith('data: ')) {
      try {
        const chunk = JSON.parse(sseBuf.slice(6).trim());
        const audio = chunk.choices?.[0]?.delta?.audio ?? chunk.choices?.[0]?.message?.audio;
        if (audio?.data) b64 += audio.data;
      } catch {}
    }

    if (b64.length > 0) break;
    console.log(`  [sting] empty response, retrying (${attempt + 1}/3)…`);
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!b64) throw new Error('Lyria returned no audio after 3 attempts');

  const rawMp3 = Buffer.from(b64, 'base64');
  const tmpRaw = path.join(os.tmpdir(), `sting-raw-${Date.now()}.mp3`);
  fs.writeFileSync(tmpRaw, rawMp3);

  // Trim the 30s Lyria clip to 3.5 seconds with fade in/out
  execSync(
    `ffmpeg -y -i "${tmpRaw}" -t 3.5 -af "afade=t=in:st=0:d=0.2,afade=t=out:st=3.0:d=0.5" "${STING_PATH}"`,
    { stdio: 'pipe' },
  );
  fs.unlinkSync(tmpRaw);

  const stingMs = getAudioDurationMs(STING_PATH);
  console.log(`  [sting] → audio/tomorrow-broke-sting.mp3 (${(stingMs / 1000).toFixed(2)}s)`);
  return 'audio/tomorrow-broke-sting.mp3';
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function getAudioDurationMs(filePath) {
  try {
    const out = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`,
      { timeout: 5000, encoding: 'utf8' },
    );
    return Math.round(parseFloat(out.trim()) * 1000);
  } catch { return 0; }
}

function loadProgress(slug) {
  const f = path.join(SPECS_DIR, `tomorrow-broke-${slug}.progress.json`);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; }
}

function saveProgress(slug, progress) {
  const f = path.join(SPECS_DIR, `tomorrow-broke-${slug}.progress.json`);
  fs.writeFileSync(f, JSON.stringify(progress, null, 2));
}

// ─── Main ─────────────────────────────────────────────────────────────────
const episodeFile = process.argv[2];
if (!episodeFile) {
  console.error('Usage: node scripts/yt-experiments/make-tomorrow-broke.mjs path/to/episode.json');
  process.exit(1);
}

const episode = JSON.parse(fs.readFileSync(episodeFile, 'utf8'));
const {
  episode: slug,
  title,
  scenes,
  music       = 'audio/ambient-noir.mp3',
  seriesName  = 'IF IT GOES WRONG',
} = episode;

if (!slug || !title || !Array.isArray(scenes) || scenes.length === 0) {
  console.error('Invalid episode file — must have episode, title, and scenes[]');
  process.exit(1);
}

console.log(`\n== Tomorrow Broke: ${title} ==`);
console.log(`Scenes: ${scenes.length}  |  Slug: ${slug}  |  Music: ${music}\n`);

const progress = loadProgress(slug);
console.log(`  Loaded progress: ${Object.keys(progress).length} scenes already done.\n`);

// ── Step 1: Generate Seedance Lite clips ──────────────────────────────────
console.log('[1/5] Generating Seedance clips (sequential)…');
const clipByScene = new Map();
for (const scene of scenes) {
  const saved = progress[scene.id]?.clipSrc;
  if (saved && fs.existsSync(path.join(VIDEO_PKG, 'public', saved))) {
    console.log(`  [clip] ${scene.id} → ${saved} (cached)`);
    clipByScene.set(scene.id, saved);
    continue;
  }
  try {
    const src = await generateClip(scene.id, scene.videoPrompt);
    clipByScene.set(scene.id, src);
    progress[scene.id] = { ...progress[scene.id], clipSrc: src };
    saveProgress(slug, progress);
  } catch (e) {
    console.error(`  [clip] ${scene.id} FAILED: ${e.message}`);
  }
}
console.log(`  ${clipByScene.size}/${scenes.length} clips ready.\n`);

// ── Step 2: Generate TTS ──────────────────────────────────────────────────
console.log('[2/5] Generating TTS (sequential)…');
const voiceByScene = new Map();
for (const scene of scenes) {
  const text = (scene.narration || '').trim();
  if (!text) continue;
  const savedVoice = progress[scene.id]?.voiceSrc;
  const savedMs    = progress[scene.id]?.voiceMs;
  if (savedVoice && savedMs && fs.existsSync(path.join(VIDEO_PKG, 'public', savedVoice))) {
    console.log(`  [tts]  ${scene.id} → ${savedVoice} (cached, ${(savedMs / 1000).toFixed(2)}s)`);
    voiceByScene.set(scene.id, { src: savedVoice, voiceMs: savedMs });
    continue;
  }
  try {
    const result = await generateTTS(text, scene.id);
    voiceByScene.set(scene.id, result);
    progress[scene.id] = { ...progress[scene.id], voiceSrc: result.src, voiceMs: result.voiceMs };
    saveProgress(slug, progress);
  } catch (e) {
    console.error(`  [tts] ${scene.id} FAILED: ${e.message}`);
  }
}
console.log(`  ${voiceByScene.size}/${scenes.filter(s => s.narration).length} voice clips ready.\n`);

// ── Step 3: Outro sting ───────────────────────────────────────────────────
console.log('[3/5] Outro sting…');
const stingSrc = await ensureOustroSting();
const stingMs  = getAudioDurationMs(STING_PATH);
console.log();

// ── Step 4: Build VideoSpec ───────────────────────────────────────────────
console.log('[4/5] Building VideoSpec…');
const n = scenes.length;

const builtScenes = scenes.map((scene, i) => {
  const isLast          = i === n - 1;
  const isSecondToLast  = i === n - 2;
  const clipSrc         = clipByScene.get(scene.id);
  const voice           = voiceByScene.get(scene.id);

  const voiceFrames     = voice ? Math.ceil((voice.voiceMs / 1000) * FPS) : 0;
  const durationInFrames = Math.max(SCENE_MIN, VOICE_LEAD + voiceFrames + VOICE_TAIL);

  return {
    id: scene.id,
    kind: 'composable',
    durationInFrames,
    narration: scene.narration,
    ...(voice ? { metadata: { voiceDurationMs: voice.voiceMs } } : {}),
    params: {
      mood: 'noir',
      visualLayers: [
        {
          primitive: 'video-clip',
          params: {
            prompt: scene.videoPrompt,
            durationSeconds: 5,
            aspectRatio: '16:9',
            opacity: 1,
            fit: 'cover',
            ...(clipSrc ? { src: clipSrc } : {}),
          },
        },
        ...overlayLayers(isLast, isSecondToLast),
      ],
    },
  };
});

// Standard outro always appended last
const allScenes = [...builtScenes, buildOutroScene(seriesName, title)];

// N-1 transitions for N scenes; all fades at 15 frames
const transitions = allScenes.slice(0, -1).map(() => ({ kind: 'fade', durationInFrames: 15 }));

// Voiceover timeline — cursor tracks absolute frame position
const voiceovers = [];
let cursor = 0;
for (let i = 0; i < allScenes.length; i++) {
  const scene          = allScenes[i];
  const voice          = voiceByScene.get(scene.id);
  const nextTransition = transitions[i];
  const nextOverlap    = nextTransition?.kind !== 'none' ? (nextTransition?.durationInFrames ?? 0) : 0;

  if (scene.id === 'outro') {
    voiceovers.push({
      src:            stingSrc,
      startFrame:     cursor + 5,
      durationFrames: Math.ceil((stingMs / 1000) * FPS),
      volume:         0.4,
    });
  } else if (voice) {
    voiceovers.push({
      src:            voice.src,
      startFrame:     cursor + VOICE_LEAD,
      durationFrames: Math.ceil((voice.voiceMs / 1000) * FPS),
      volume:         1.0,
    });
  }

  cursor += scene.durationInFrames - nextOverlap;
}

const spec = {
  id:          `tomorrow-broke-${slug}-v1`,
  version:     1,
  fps:         FPS,
  width:       1920,
  height:      1080,
  brandKitRef: 'tomorrow-broke',
  brand:       TB_BRAND,
  palette:     { seedHue: 315, harmony: 'split', mood: 'midnight' },
  music:       { src: music, startFrame: 0, volume: 0.9 },
  voiceovers,
  transitions,
  scenes:      allScenes,
};

const specOut = path.join(os.tmpdir(), `tb-${slug}-${Date.now()}.json`);
fs.writeFileSync(specOut, JSON.stringify(spec, null, 2));
console.log(`  Spec written → ${specOut}\n`);

// ── Step 5: Render ────────────────────────────────────────────────────────
const videoOut = path.join(OUT_DIR, `tomorrow-broke-${slug}-${Date.now()}.mp4`);
console.log('[5/5] Rendering…');
console.log(`  Output → ${videoOut}\n`);

await new Promise((resolve, reject) => {
  const child = spawn('npx', [
    'remotion', 'render', 'src/index.ts', 'SpecDriven', videoOut,
    `--props=${specOut}`,
  ], {
    cwd: VIDEO_PKG,
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Remotion exited ${code}`)));
});

console.log(`\n✓ Done: ${videoOut}`);
execSync(`open "${videoOut}"`);
