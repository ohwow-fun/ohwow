/**
 * yt-compose-core — the mechanical YouTube Shorts pipeline, parameterized
 * by series. Thin per-series wrappers (yt-compose-<slug>.mjs) call
 * composeEpisode({slug, env, workspace}).
 *
 * Pipeline:
 *   1. Resolve series config + prompt module + brand kit (via tsx-imported TS).
 *   2. Pick seed via the series' seed adapter.
 *   3. Draft via llm() using the series' system + user prompt.
 *   4. Banned-phrase check (global + series).
 *   5. Generate voiceover via the series' voice config.
 *   6. Build VideoSpec, merging the brand kit into spec.brand + brandKitRef.
 *   7. Render via Remotion.
 *   8. Capture keyframes → Gemini visual self-review.
 *   9. Write brief.json, propose to approval queue with series.approvalKind.
 *  10. On auto-approve + !dry: upload with series.defaultVisibility.
 *
 * This script expects to be run with `node --import tsx` so it can import
 * the series registry, prompt modules, and brand-kit loader from TS.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, spawn } from 'node:child_process';

import { llm, extractJson, resolveOhwow } from '../x-experiments/_ohwow.mjs';
import { propose } from '../x-experiments/_approvals.mjs';
import { ensureYTReady, uploadShort } from '../x-experiments/_yt-browser.mjs';
import { getSeedAdapter } from './seed-adapters/index.mjs';

// TS imports from src/ — tsx loader resolves .js → .ts at runtime.
import { getSeries, assertSeriesEnabled } from '../../src/integrations/youtube/series/registry.js';
import { getPromptModule } from '../../src/integrations/youtube/series/script-prompts/index.js';

// Brand-kit loader lives in packages/video (CommonJS). Dynamic import +
// dereference the named export via .default or directly — tsx's ESM/CJS
// interop makes the named-import form flaky here.
const brandKitsModule = await import('../../packages/video/src/brand-kits/index.js');
const loadBrandKit = brandKitsModule.loadBrandKit || brandKitsModule.default?.loadBrandKit;
if (typeof loadBrandKit !== 'function') {
  throw new Error('brand-kit loader could not be resolved from packages/video');
}

// ---------------------------------------------------------------------------
// Paths + constants
// ---------------------------------------------------------------------------
const VIDEO_PKG = path.resolve('packages/video');
const MEDIA_DIR = path.join(os.homedir(), '.ohwow', 'media');
const KOKORO_URL = 'http://127.0.0.1:8880';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TTS_MODEL = 'openai/gpt-audio-mini';
const REVIEW_MODEL = 'google/gemini-2.5-flash-lite';
const VOICE_LEAD_FRAMES = 5;
const VOICE_TAIL_FRAMES = 20;
const SCENE_MIN_FRAMES = 90;

// Global banned phrases that apply to every series. Scoped narrowly to
// catch OHWOW self-references only — NOT general tech vocabulary. E.g.
// "local-first" (bare) is a legit category (Qwen running locally);
// "local-first ai runtime" is OHWOW-specific. Be precise.
const GLOBAL_BANNED_PHRASES = [
  'our daemon',
  'agent workspaces',
  'our runtime',
  'ohwow runs',
  'ohwow uses',
  'mcp-first routing',
  'multi-workspace daemon',
  'local-first ai runtime',
  'local-first runtime',
  'orchestration layer',
];

// Ambient mood → music track map. Kit default drives the pick when the
// draft's palette.mood doesn't provide one.
const AMBIENT_MOOD_MAP = {
  contemplative: 'ambient-contemplative.mp3',
  cosmic: 'ambient-cosmic.mp3',
  electric: 'ambient-electric.mp3',
  dawn: 'ambient-electric.mp3',
  warm: 'ambient-warm.mp3',
  noir: 'ambient-noir.mp3',
  ethereal: 'ambient-cosmic.mp3',
};
const AMBIENT_FALLBACK = 'ambient.mp3';

// ---------------------------------------------------------------------------
// OpenRouter key
// ---------------------------------------------------------------------------
function readOpenRouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ohwow', 'config.json'), 'utf8'));
    return cfg.openRouterApiKey || null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Voice — series' voice config wins. Provider=openrouter default, kokoro fallback.
// ---------------------------------------------------------------------------
async function kokoroAvailable() {
  try {
    const r = await fetch(`${KOKORO_URL}/v1/audio/voices`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

function saveVoiceMp3(buffer) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const audioDir = path.join(MEDIA_DIR, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const filePath = path.join(audioDir, `voice-${hash.slice(0, 16)}.mp3`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function generateVoiceKokoro(text, voice, speed) {
  if (!(await kokoroAvailable())) return null;
  const resp = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'kokoro', input: text, voice, speed, response_format: 'mp3' }),
  });
  if (!resp.ok) throw new Error(`Kokoro TTS ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  return saveVoiceMp3(buffer);
}

async function generateVoiceOpenRouter(text, voice, prosodyPrompt) {
  const apiKey = readOpenRouterKey();
  if (!apiKey) return null;
  // Strict TTS system prompt + series-specific prosody layered on top.
  const sys = [
    'You are a TTS engine reading for a short-form video. Speak exactly the quoted text, verbatim. Never respond, never add words.',
    prosodyPrompt,
  ].filter(Boolean).join(' ');
  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
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
        { role: 'system', content: sys },
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
  return saveVoiceMp3(mp3Buffer);
}

async function generateVoiceOver({ text, voiceConfig }) {
  const { provider, voiceName, speed, prosodyPrompt } = voiceConfig;
  try {
    if (provider === 'kokoro') return await generateVoiceKokoro(text, voiceName, speed);
    const result = await generateVoiceOpenRouter(text, voiceName, prosodyPrompt);
    if (result) return result;
    return await generateVoiceKokoro(text, 'af_heart', speed);
  } catch (e) {
    console.log(`[compose-core] voice generation failed: ${e.message}`);
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
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Scene alignment
// ---------------------------------------------------------------------------
function alignSceneDurations(scenes, audioDurationMs, fps = 30) {
  const totalAudioFrames = Math.ceil((audioDurationMs / 1000) * fps);
  // Character count correlates with TTS time better than word count.
  // "20.9GB GGUF format quantized by Unsloth" has ~6 words but TTS
  // reads the numbers/acronyms slowly — character count gets us closer.
  // Strip whitespace so indentation/padding doesn't skew distribution.
  const chars = scenes.map((s) => (s.narration || s.params?.text || '').replace(/\s+/g, ' ').trim().length);
  const totalChars = chars.reduce((a, b) => a + b, 0) || 1;
  const padding = VOICE_LEAD_FRAMES + VOICE_TAIL_FRAMES;
  return scenes.map((s, i) => {
    const proportion = (chars[i] || 1) / totalChars;
    const rawFrames = Math.round(proportion * totalAudioFrames) + padding;
    return { ...s, durationInFrames: Math.max(SCENE_MIN_FRAMES, rawFrames) };
  });
}

function pickAmbientTrack(mood) {
  const file = AMBIENT_MOOD_MAP[(mood || '').toLowerCase()];
  if (file && fs.existsSync(path.join(VIDEO_PKG, 'public', 'audio', file))) return `audio/${file}`;
  return `audio/${AMBIENT_FALLBACK}`;
}

function enrichVisualLayers(scene, primitivePalette) {
  if (scene.kind !== 'composable') return scene;
  const layers = scene.params?.visualLayers || [];
  if (layers.length >= 2) return scene;
  const existing = new Set(layers.map((l) => l.primitive));
  const defaults = [
    ...primitivePalette.slice(0, 2).map((p) => ({ primitive: p })),
    { primitive: 'film-grain', params: { opacity: 0.3 } },
    { primitive: 'vignette', params: { intensity: 0.6 } },
  ];
  const toAdd = defaults.filter((d) => !existing.has(d.primitive)).slice(0, Math.max(0, 2 - layers.length));
  return { ...scene, params: { ...scene.params, visualLayers: [...layers, ...toAdd] } };
}

/**
 * Merge the brand kit into the draft's spec and produce a final VideoSpec.
 * The kit overrides: brand.colors, brand.fonts, brand.glass. The kit's
 * paletteHue + paletteHarmony + ambientMoodDefault set the palette when
 * the draft hasn't supplied its own. brandKitRef records the kit slug for
 * provenance. Aspect ratio is driven by the series config (vertical Shorts
 * vs horizontal playlist video).
 */
function buildFullSpec({ draft, voiceoverRef, audioDurationMs, kit, series }) {
  let scenes = (draft.spec?.scenes || []).map((s) => enrichVisualLayers({
    ...s,
    durationInFrames: s.durationInFrames || 240,
  }, kit.primitivePalette || []));
  if (audioDurationMs && audioDurationMs > 0) {
    scenes = alignSceneDurations(scenes, audioDurationMs);
  }

  const voiceovers = voiceoverRef
    ? [{ src: voiceoverRef, startFrame: VOICE_LEAD_FRAMES, volume: 0.9 }]
    : [];
  const mood = draft.spec?.palette?.mood || kit.ambientMoodDefault;
  const ambientSrc = pickAmbientTrack(mood);

  const isHorizontal = series?.format?.aspectRatio === 'horizontal';
  const width = isHorizontal ? 1920 : 1080;
  const height = isHorizontal ? 1080 : 1920;
  const idPrefix = isHorizontal ? 'yt-video' : 'yt-short';

  return {
    id: `${idPrefix}-${Date.now()}`,
    version: 1,
    fps: 30,
    width,
    height,
    brandKitRef: kit.slug,
    brand: {
      colors: kit.colors,
      fonts: kit.fonts,
      glass: kit.glass,
    },
    palette: draft.spec?.palette || {
      seedHue: kit.paletteHue,
      harmony: kit.paletteHarmony,
      mood: kit.ambientMoodDefault,
    },
    music: { src: ambientSrc, startFrame: 0, volume: 0.15 },
    voiceovers,
    transitions: draft.spec?.transitions || [{ kind: 'fade', durationInFrames: 15 }],
    scenes,
  };
}

// ---------------------------------------------------------------------------
// Render + keyframes + visual review
// ---------------------------------------------------------------------------
function renderVideo(specPath, outPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', [
      'remotion', 'render', 'src/index.ts', 'SpecDriven', outPath, `--props=${specPath}`,
    ], { cwd: VIDEO_PKG, stdio: 'pipe', env: { ...process.env, FORCE_COLOR: '0' } });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => { process.stdout.write(d); });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`remotion render exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

function captureKeyFrames(videoPath, spec, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const fps = spec.fps || 30;
  const screenshots = [];
  let cursor = 0;
  const times = [];
  for (let i = 0; i < spec.scenes.length; i++) {
    const dur = spec.scenes[i].durationInFrames / fps;
    times.push({ time: cursor + dur * 0.5, label: `scene-${i + 1}-mid` });
    if (i < spec.scenes.length - 1) times.push({ time: cursor + dur - 0.5, label: `scene-${i + 1}-end` });
    cursor += dur;
    const trans = spec.transitions[i];
    if (trans && trans.kind !== 'none' && i < spec.scenes.length - 1) {
      cursor -= (trans.durationInFrames || 0) / fps;
    }
  }
  times.push({ time: Math.max(0, cursor - 0.1), label: 'final' });
  for (const { time, label } of times) {
    const outFile = path.join(outputDir, `${label}.jpg`);
    try {
      execSync(
        `ffmpeg -y -ss ${time.toFixed(2)} -i "${videoPath}" -frames:v 1 -q:v 3 "${outFile}"`,
        { stdio: 'pipe', timeout: 10_000 },
      );
      screenshots.push({ label, path: outFile, timeSec: time });
    } catch {}
  }
  return screenshots;
}

async function visualSelfReview({ screenshots, draft, series }) {
  if (!screenshots.length) return { pass: true, notes: 'no keyframes' };
  const apiKey = readOpenRouterKey();
  if (!apiKey) return { pass: true, notes: 'no API key for review' };

  const content = [
    { type: 'text', text: `Review these keyframes from a ${series.displayName} YouTube Short.\nIntended narration: "${draft.narration_full}"\nTitle: "${draft.title}"` },
  ];
  for (const ss of screenshots) {
    try {
      const buf = fs.readFileSync(ss.path);
      content.push({ type: 'text', text: `\n[${ss.label} at ${ss.timeSec.toFixed(1)}s]:` });
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` } });
    } catch {}
  }

  const sys = `You're a quality reviewer for a ${series.displayName} YouTube Short at 1080x1920. Evaluate: text readability on mobile, visual quality, composition (title bar at bottom 15%, action buttons on right 20%), content coherence with the narration, brand consistency (does it feel like ${series.displayName}?).

Output STRICT JSON: {
  "pass": true/false,
  "score": 1-10,
  "text_readability": "note",
  "visual_quality": "note",
  "composition": "note",
  "brand_fit": "note — does this look like ${series.displayName}?",
  "issues": ["specific issues, empty if pass"],
  "suggestions": ["improvements for future renders"]
}
Pass threshold: score >= 6.`;

  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://ohwow.fun',
        'X-Title': 'OHWOW',
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: REVIEW_MODEL,
        max_tokens: 1024,
        messages: [{ role: 'system', content: sys }, { role: 'user', content }],
      }),
    });
    if (!resp.ok) throw new Error(`OpenRouter ${resp.status}`);
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
    return { pass: true, notes: `review failed: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Pre-flight: YT account flags kill-switch
// ---------------------------------------------------------------------------
async function preflightAccountFlags(workspace) {
  try {
    const { ensureYTStudio } = await import('../../src/integrations/youtube/session.js');
    const { healthCheck } = await import('../../src/integrations/youtube/session.js');
    const session = await ensureYTStudio({ workspaceId: workspace });
    const health = await healthCheck(session.page);
    if (session.ownsBrowser) session.browser.close();
    const flags = health?.accountFlags || {};
    if (flags.hasUnacknowledgedCopyrightTakedown) {
      throw new Error('PREFLIGHT: unacknowledged copyright takedown — compose refused');
    }
    if (flags.hasUnacknowledgedTouStrike) {
      throw new Error('PREFLIGHT: unacknowledged ToS strike — compose refused');
    }
    return health;
  } catch (e) {
    // If the YT session can't be probed (e.g., Chrome not running in dry
    // mode), log but don't block — the UPLOAD step will refuse anyway if
    // the session is broken.
    console.log(`[compose-core] preflight skipped: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry point — callable from per-series wrappers.
// ---------------------------------------------------------------------------
export async function composeEpisode({ slug, env = {} }) {
  const t0 = Date.now();
  const series = getSeries(slug);
  assertSeriesEnabled(slug);

  const dry = env.DRY !== '0';
  const skipRender = env.SKIP_RENDER === '1';
  const skipVoice = env.SKIP_VOICE === '1';
  const visibility = env.VISIBILITY || series.defaultVisibility;

  const { workspace } = resolveOhwow();
  console.log(`[compose-core] series=${slug} workspace=${workspace} dry=${dry} visibility=${visibility}`);

  // 0. Preflight account flags — don't compose if the channel is sanctioned.
  if (!dry) {
    await preflightAccountFlags(workspace);
  }

  // 1. Series assets.
  const promptModule = getPromptModule(slug);
  const kit = loadBrandKit(series.brandKitFile.replace(/\.json$/, ''));
  const pickSeed = getSeedAdapter(slug);

  const briefDir = `/tmp/yt-compose-${slug}-${Date.now()}`;
  fs.mkdirSync(briefDir, { recursive: true });

  // 2. Seed.
  const seed = await pickSeed({ workspace, historyDays: Number(env.HISTORY_DAYS || 5) });
  if (!seed) {
    console.log(`[compose-core] no fresh seed for ${slug} — skipping`);
    return { status: 'no_seed', briefDir };
  }
  console.log(`[compose-core] seed: ${seed.title.slice(0, 80)}`);

  // 3. Draft via llm(). The compose pipeline auto-shrinks scene
  //    durations via alignSceneDurations to match actual voice audio,
  //    so a draft that comes in at 75-90 words (vs the ideal 100-130)
  //    just produces a tighter 35-40s Short rather than dead air in a
  //    45s container. We only retry on extreme under-delivery (<65
  //    words) where the content is genuinely too thin to be useful.
  const userPrompt = promptModule.buildUserPrompt(seed);
  const WORD_COUNT_FLOOR = 65;
  let draft;
  try {
    const out = await llm({ purpose: 'reasoning', system: promptModule.systemPrompt, prompt: userPrompt });
    draft = extractJson(out.text);
    const words = (draft?.narration_full || '').trim().split(/\s+/).filter(Boolean).length;
    console.log(`[compose-core] drafted: "${draft.title}" conf=${draft.confidence} words=${words} model=${out.model_used}`);

    if (words > 0 && words < WORD_COUNT_FLOOR && draft.confidence >= 0.4) {
      console.log(`[compose-core] narration too thin (${words} < ${WORD_COUNT_FLOOR}) — regenerating with feedback`);
      const feedback = `Your previous draft was TOO THIN at ${words} words — the story isn't developed enough to fill a 30-45s Short. Rewrite the same story: keep the actor + artifact + hook + takeaway template, but expand the Fact scene to include a second concrete specific (a second number, a named contrast, a specific timeline) AND expand the Implication to name a specific builder segment with a specific timeframe and consequence. Target 100-120 words total. Return the same JSON schema.\n\nSEED:\n${userPrompt}\n\nYOUR PREVIOUS THIN DRAFT (rewrite this fuller):\n${JSON.stringify(draft, null, 2)}`;
      const retry = await llm({ purpose: 'reasoning', system: promptModule.systemPrompt, prompt: feedback });
      const retryDraft = extractJson(retry.text);
      const retryWords = (retryDraft?.narration_full || '').trim().split(/\s+/).filter(Boolean).length;
      if (retryWords >= WORD_COUNT_FLOOR && retryWords <= 160) {
        console.log(`[compose-core] regenerated: words=${retryWords} (was ${words})`);
        draft = retryDraft;
      } else {
        console.log(`[compose-core] retry produced ${retryWords} words — keeping original`);
      }
    }
  } catch (e) {
    console.log(`[compose-core] draft failed: ${e.message}`);
    return { status: 'draft_failed', briefDir, error: e.message };
  }

  const floor = promptModule.confidenceFloor ?? 0.4;
  if (!draft.confidence || draft.confidence < floor) {
    console.log(`[compose-core] confidence ${draft.confidence} < floor ${floor} — skipping`);
    fs.writeFileSync(path.join(briefDir, 'skip.json'), JSON.stringify({ seed, draft, reason: 'low confidence' }, null, 2));
    return { status: 'low_confidence', briefDir };
  }

  // 4. Banned-phrase check.
  const allBanned = [...GLOBAL_BANNED_PHRASES, ...promptModule.bannedPhrases];
  const corpus = [draft.narration_full, draft.title, draft.description].join(' ').toLowerCase();
  const offender = allBanned.find((p) => corpus.includes(p));
  if (offender) {
    console.log(`[compose-core] banned phrase '${offender}' — skipping`);
    fs.writeFileSync(path.join(briefDir, 'skip.json'), JSON.stringify({ seed, draft, reason: `banned: ${offender}` }, null, 2));
    return { status: 'banned', briefDir, offender };
  }

  // 5. Voice.
  let voiceoverRef = null, audioDurationMs = null;
  if (!skipVoice && draft.narration_full) {
    const voicePath = await generateVoiceOver({ text: draft.narration_full, voiceConfig: series.voice });
    if (voicePath) {
      voiceoverRef = stageVoiceFile(voicePath);
      audioDurationMs = getAudioDurationMs(voicePath);
      console.log(`[compose-core] voice: ${voiceoverRef} · ${audioDurationMs}ms`);
    }
  }

  // 6. Spec.
  const spec = buildFullSpec({ draft, voiceoverRef, audioDurationMs, kit, series });

  // Programmatic-only guard: the Briefing (and any series with
  // format.aspectRatio='horizontal' newsroom format) uses ONLY the
  // programmatic primitives. AI video clips (Seedance, Fal Luma) are
  // expensive and off-brand for a news format. Strip video-clip layers
  // if they sneak in — belt-and-suspenders; the prompt and brand kit
  // both already exclude them, but a future prompt regression shouldn't
  // accidentally burn $$.
  if (series?.format?.aspectRatio === 'horizontal') {
    let strippedCount = 0;
    for (const sc of spec.scenes) {
      const layers = sc.params?.visualLayers;
      if (Array.isArray(layers)) {
        const before = layers.length;
        sc.params.visualLayers = layers.filter((l) => l?.primitive !== 'video-clip');
        strippedCount += before - sc.params.visualLayers.length;
      }
    }
    if (strippedCount > 0) {
      console.log(`[compose-core] ⚠ stripped ${strippedCount} video-clip primitive(s) — briefing is programmatic-only`);
    }
  }

  const specPath = path.join(briefDir, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  console.log(`[compose-core] spec: ${spec.scenes.length} scenes, kit=${spec.brandKitRef}`);

  // 7. Render + review.
  const videoDir = path.join(MEDIA_DIR, 'videos');
  fs.mkdirSync(videoDir, { recursive: true });
  const videoPath = path.join(videoDir, `${spec.id}.mp4`);
  let visualReview = { pass: true };

  if (!skipRender) {
    try {
      console.log(`[compose-core] rendering → ${videoPath}`);
      await renderVideo(specPath, videoPath);
    } catch (e) {
      console.log(`[compose-core] render failed: ${e.message}`);
      return { status: 'render_failed', briefDir, error: e.message };
    }

    const ssDir = path.join(briefDir, 'keyframes');
    const screenshots = captureKeyFrames(videoPath, spec, ssDir);
    if (screenshots.length) {
      visualReview = await visualSelfReview({ screenshots, draft, series });
      fs.writeFileSync(path.join(briefDir, 'visual-review.json'), JSON.stringify(visualReview, null, 2));
      console.log(`[compose-core] visual review: pass=${visualReview.pass} score=${visualReview.score ?? '?'}`);
    }

    // 7b. Thumbnail — only for horizontal briefing-style videos; Shorts
    // use YouTube's auto-generated thumbnails.
    if (series?.format?.aspectRatio === 'horizontal') {
      try {
        const { generateThumbnail } = await import('./_thumbnail.mjs');
        const thumbPath = path.join(briefDir, 'thumbnail.jpg');
        const result = generateThumbnail({
          videoPath,
          draft,
          outPath: thumbPath,
          keyframeSeconds: 6,
        });
        if (result.ok) {
          console.log(`[compose-core] thumbnail: ${thumbPath}`);
        } else {
          console.log(`[compose-core] thumbnail failed: ${result.error}`);
        }
      } catch (e) {
        console.log(`[compose-core] thumbnail error: ${e.message}`);
      }
    }
  }

  // 8. Brief.
  const thumbnailPath = path.join(briefDir, 'thumbnail.jpg');
  const record = {
    ts: new Date().toISOString(),
    workspace,
    series: slug,
    seed,
    draft,
    spec,
    videoPath: skipRender ? null : videoPath,
    thumbnailPath: !skipRender && fs.existsSync(thumbnailPath) ? thumbnailPath : null,
    visualReview,
    durationMs: Date.now() - t0,
  };
  fs.writeFileSync(path.join(briefDir, 'brief.json'), JSON.stringify(record, null, 2));

  // 9. Propose to approval queue.
  if (!dry && !skipRender && visualReview.pass) {
    const entry = propose({
      kind: series.approvalKind,
      summary: `${series.displayName} · ${draft.title.slice(0, 50)}`,
      bucketBy: 'series',
      bucketValue: slug,
      payload: {
        series: slug,
        title: draft.title,
        description: draft.description,
        narration: draft.narration_full,
        videoPath,
        specPath,
        confidence: draft.confidence,
        visualReviewScore: visualReview.score,
      },
      autoApproveAfter: 15,
    });
    record.approval_status = entry.status;
    record.approval_id = entry.id;
    console.log(`[compose-core] approval ${entry.status} id=${entry.id.slice(0, 8)}`);

    // 10. Upload if auto-approved.
    if (entry.status === 'auto_applied') {
      try {
        const { browser, page } = await ensureYTReady();
        const result = await uploadShort(page, {
          filePath: videoPath,
          title: draft.title,
          description: draft.description,
          visibility,
          screenshot: true,
        });
        browser.close();
        record.uploaded = true;
        record.videoUrl = result.videoUrl;
        console.log(`[compose-core] uploaded ${result.videoUrl} (${result.visibility})`);
      } catch (e) {
        console.log(`[compose-core] upload failed: ${e.message}`);
        record.uploaded = false;
        record.upload_error = e.message;
      }
    }
  }

  fs.writeFileSync(path.join(briefDir, 'brief.json'), JSON.stringify(record, null, 2));
  console.log(`[compose-core] done in ${Math.round((Date.now() - t0) / 1000)}s · ${briefDir}/brief.json`);
  return { status: 'ok', briefDir, record };
}
