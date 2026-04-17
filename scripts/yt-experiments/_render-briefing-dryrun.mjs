#!/usr/bin/env node
/**
 * Dry-run harness for the signature Briefing treatment. Takes the
 * briefing-dryrun.json spec, generates voice from the scene narrations,
 * stages it under packages/video/public/voice, writes an updated spec
 * alongside the source, and renders to packages/video/out.
 *
 * This does NOT use compose-core's seed → LLM → draft pipeline — it
 * exists so we can inspect the visual treatment with realistic voice
 * when no fresh news seed is available. The voice generation logic
 * mirrors compose-core's OpenRouter TTS path (model: gpt-audio-mini,
 * voice: alloy, briefing prosody prompt).
 *
 * Run: node --import tsx scripts/yt-experiments/_render-briefing-dryrun.mjs
 *
 * Flags (all optional):
 *   --publish   after render, chain to _publish-briefing.mjs (dry-run of
 *               the upload wizard by default — add --yes --publish to live)
 *   --yes       passthrough to publish step
 *   --public    passthrough (requires 5 prior unlisted applied runs)
 *   --identity  passthrough
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, spawn } from 'node:child_process';

const VIDEO_PKG = path.resolve('packages/video');
const SPEC_IN = path.join(VIDEO_PKG, 'specs/briefing-dryrun.json');
const SPEC_OUT = path.join(VIDEO_PKG, 'specs/briefing-dryrun.compiled.json');
const VIDEO_OUT = path.join(VIDEO_PKG, 'out/briefing-dryrun-v4.mp4');

const MEDIA_DIR = path.join(os.homedir(), '.ohwow', 'media');
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TTS_MODEL = 'openai/gpt-audio-mini';
const VOICE_NAME = 'alloy';
// Kinetic title needs ~3s to spring in before the anchor speaks the intro
// narration. Applied only to the intro scene.
const INTRO_VOICE_LEAD_FRAMES = 90;
// Breathing room at the end of each narrated scene so the voice doesn't
// clip right up against the transition. ~500ms @ 30fps.
const SCENE_TAIL_PAD_FRAMES = 15;
// Extra dwell at the very end of the outro for a music swell after the
// anchor signs off.
const OUTRO_MUSIC_SWELL_FRAMES = 210;
const PROSODY =
  "Credible morning-show anchor pacing a 2-minute daily brief. " +
  "Clear, confident, no hedging. Not frantic — the viewer is sipping " +
  "coffee, not running for a train. Slightly warmer than broadcast, " +
  "but still crisp on consonants and proper nouns. Leave natural " +
  "pauses between stories (half-beat at paragraph breaks). " +
  "When introducing a company or product name, land on it deliberately.";

function readOpenRouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  for (const p of [path.join(os.homedir(), '.env'), '.env.local', '.env']) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (line.startsWith('OPENROUTER_API_KEY=')) {
        return line.split('=', 2)[1].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ohwow/config.json'), 'utf8'));
    return cfg.openRouterApiKey || null;
  } catch { return null; }
}

function saveVoiceMp3(buffer) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const dir = path.join(MEDIA_DIR, 'audio');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `voice-${hash.slice(0, 16)}.mp3`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function stageVoiceFile(srcPath) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(srcPath)).digest('hex');
  const dir = path.join(VIDEO_PKG, 'public/voice');
  fs.mkdirSync(dir, { recursive: true });
  const staged = path.join(dir, `${hash.slice(0, 16)}.mp3`);
  if (!fs.existsSync(staged)) fs.copyFileSync(srcPath, staged);
  return `voice/${hash.slice(0, 16)}.mp3`;
}

function getAudioDurationMs(filePath) {
  const out = execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`, {
    timeout: 5000, encoding: 'utf8',
  });
  return Math.round(parseFloat(out.trim()) * 1000);
}

async function generateVoice(text) {
  const apiKey = readOpenRouterKey();
  if (!apiKey) throw new Error('No OPENROUTER_API_KEY');
  const sys = `You are a TTS engine reading for a short-form video. Speak exactly the quoted text, verbatim. Never respond, never add words. ${PROSODY}`;
  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://ohwow.fun',
      'X-Title': 'OHWOW',
    },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model: TTS_MODEL,
      modalities: ['text', 'audio'],
      audio: { voice: VOICE_NAME, format: 'pcm16' },
      stream: true,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: `Read this aloud: "${text}"` },
      ],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`OpenRouter TTS ${resp.status}: ${err.slice(0, 400)}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', b64 = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
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
  if (!b64) throw new Error('TTS returned no audio');
  const pcm = Buffer.from(b64, 'base64');
  const tmpPcm = path.join(os.tmpdir(), `voice-${Date.now()}.pcm`);
  const tmpMp3 = path.join(os.tmpdir(), `voice-${Date.now()}.mp3`);
  fs.writeFileSync(tmpPcm, pcm);
  execSync(`ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${tmpPcm}" -c:a libmp3lame -q:a 4 "${tmpMp3}"`, { stdio: 'pipe' });
  const mp3 = fs.readFileSync(tmpMp3);
  fs.unlinkSync(tmpPcm); fs.unlinkSync(tmpMp3);
  return saveVoiceMp3(mp3);
}

function renderVideo(specPath, outPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['remotion', 'render', 'src/index.ts', 'SpecDriven', outPath, `--props=${specPath}`, '--log=error'], {
      cwd: VIDEO_PKG, stdio: 'inherit', env: { ...process.env, FORCE_COLOR: '0' },
    });
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`remotion exit ${code}`)));
  });
}

(async () => {
  console.log('[dryrun] reading', SPEC_IN);
  const spec = JSON.parse(fs.readFileSync(SPEC_IN, 'utf8'));
  const fps = spec.fps;

  // Per-scene TTS. Single-blob TTS drifts: scene.durationInFrames is
  // hand-authored and doesn't match actual TTS pacing, so captions lag voice
  // by a compounding amount. Generating one voice file per narrated scene
  // (in parallel) lets us overwrite scene.durationInFrames to fit the voice
  // exactly, which aligns caption windows with what the anchor is saying.
  const narratedScenes = spec.scenes.filter((s) => (s.narration || '').trim().length > 0);
  console.log(`[dryrun] generating voice for ${narratedScenes.length} scenes in parallel…`);

  const voiceResults = await Promise.all(
    narratedScenes.map(async (scene) => {
      const narration = scene.narration.trim();
      const words = narration.split(/\s+/).length;
      const voicePath = await generateVoice(narration);
      const voiceRef = stageVoiceFile(voicePath);
      const voiceMs = getAudioDurationMs(voicePath);
      console.log(`[dryrun]   ${scene.id}: ${words}w → ${voiceMs}ms  (${voiceRef})`);
      return { sceneId: scene.id, voiceRef, voiceMs };
    }),
  );
  const byId = new Map(voiceResults.map((v) => [v.sceneId, v]));

  // Walk scenes in order. For narrated scenes: overwrite durationInFrames to
  // lead + voiceFrames + tailPad (+ outro swell), and register a voiceover
  // ref at the cumulative startFrame. Non-narrated scenes (cold-open)
  // keep their authored duration.
  let cursorFrame = 0;
  let totalVoiceMs = 0;
  const voiceovers = [];
  for (const scene of spec.scenes) {
    const v = byId.get(scene.id);
    if (!v) {
      cursorFrame += scene.durationInFrames;
      continue;
    }
    const voiceFrames = Math.ceil((v.voiceMs / 1000) * fps);
    const lead = scene.id === 'intro' ? INTRO_VOICE_LEAD_FRAMES : 0;
    const tailSwell = scene.id === 'outro' ? OUTRO_MUSIC_SWELL_FRAMES : 0;
    scene.durationInFrames = lead + voiceFrames + SCENE_TAIL_PAD_FRAMES + tailSwell;
    voiceovers.push({
      src: v.voiceRef,
      startFrame: cursorFrame + lead,
      durationFrames: voiceFrames,
      volume: 0.95,
    });
    totalVoiceMs += v.voiceMs;
    cursorFrame += scene.durationInFrames;
  }
  spec.voiceovers = voiceovers;

  fs.writeFileSync(SPEC_OUT, JSON.stringify(spec, null, 2));
  console.log(`[dryrun] compiled spec → ${SPEC_OUT}`);

  console.log('[dryrun] rendering → ', VIDEO_OUT);
  await renderVideo(SPEC_OUT, VIDEO_OUT);

  const videoMs = Math.round((spec.scenes.reduce((a, s) => a + s.durationInFrames, 0) / fps) * 1000);
  console.log(`[dryrun] done. video=${videoMs}ms voice=${totalVoiceMs}ms (${voiceovers.length} clips)`);
  console.log(`[dryrun] open ${VIDEO_OUT}`);

  if (process.argv.includes('--publish')) {
    const passthrough = ['--publish'];
    for (const f of ['--public', '--yes']) if (process.argv.includes(f)) passthrough.push(f);
    const identity = process.argv.find((a) => a.startsWith('--identity='));
    if (identity) passthrough.push(identity);
    console.log(`[dryrun] chaining to _publish-briefing.mjs ${passthrough.join(' ')}`);
    await new Promise((resolve, reject) => {
      const child = spawn('node', [
        '--import', 'tsx',
        'scripts/yt-experiments/_publish-briefing.mjs',
        `--mp4=${VIDEO_OUT}`,
        `--spec=${SPEC_OUT}`,
        ...passthrough,
      ], { stdio: 'inherit' });
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`publish exit ${code}`)));
    });
  }
})().catch((e) => { console.error('[dryrun]', e); process.exit(1); });
