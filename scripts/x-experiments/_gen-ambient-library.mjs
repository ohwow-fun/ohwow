#!/usr/bin/env node
/**
 * _gen-ambient-library.mjs — Generate mood-tagged ambient music clips for
 * YouTube Shorts via Google Lyria on OpenRouter.
 *
 * Usage:
 *   node scripts/x-experiments/_gen-ambient-library.mjs [mood ...]
 *
 * Examples:
 *   node scripts/x-experiments/_gen-ambient-library.mjs          # all moods
 *   node scripts/x-experiments/_gen-ambient-library.mjs noir     # just noir
 *   node scripts/x-experiments/_gen-ambient-library.mjs warm cosmic  # two
 *
 * Output:
 *   packages/video/public/audio/ambient-{mood}.mp3
 *
 * Model selection:
 *   Uses `lyria-3-clip-preview` (30s fixed-length clips, $0.04 each).
 *   The Pro model (`lyria-3-pro-preview`) generates variable-length full
 *   songs (30s-2min) and ignores duration hints in prompts. Clip is the
 *   right choice for background beds under narration.
 *
 * Known quirks:
 *   - Lyria ignores duration text in prompts. Clip model enforces ~30s.
 *   - Very abstract/negative prompts ("no drums no melody") sometimes
 *     return empty audio. Use concrete instrument/texture language instead.
 *   - Contemplative/meditative moods have ~50% failure rate with purely
 *     atmospheric prompts. Adding a concrete anchor (piano, strings) helps.
 *   - Streaming is required: `stream: true` + `modalities: ['audio']`.
 *
 * API key: reads OPENROUTER_API_KEY env or ~/.ohwow/config.json openRouterApiKey.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/lyria-3-clip-preview';
const OUT_DIR = path.resolve('packages/video/public/audio');

function readApiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ohwow', 'config.json'), 'utf8'));
    return cfg.openRouterApiKey || null;
  } catch { return null; }
}

/**
 * Mood → prompt mapping. Each prompt should:
 *  - Name concrete instruments/textures (not just adjectives)
 *  - Avoid over-relying on negations ("no drums") — Lyria handles them poorly
 *  - Target cinematic/epic background bed suitable for 15-25s narrated Shorts
 *  - Keep energy low enough to sit under voice without competing
 */
const MOOD_PROMPTS = {
  contemplative: 'Cinematic ambient background, soft piano with heavy reverb, slow evolving string pad, contemplative and deep, gentle low bass drone, spacious and atmospheric, film score underscore',
  electric: 'Electronic ambient backdrop, warm analog synthesizer pulses, subtle arpeggiated sequence, dawn energy building slowly, shimmering high-end texture, cinematic and modern, epic but restrained',
  warm: 'Warm cinematic ambient, rich analog synthesizer pad, gentle acoustic guitar harmonics, intimate and nostalgic atmosphere, soft golden tone, lush reverb, orchestral undertone',
  noir: 'Dark cinematic ambient, deep cello drone, noir film atmosphere, subtle tension and mystery, low brass undertone, smoky jazz-influenced texture, shadowy and dramatic',
  cosmic: 'Epic cosmic ambient soundscape, vast orchestral pad, shimmering crystalline textures, deep space wonder, cinematic and awe-inspiring, slow build, ethereal choir-like synthesizer',
};

/**
 * Parse SSE lines and extract base64 audio data from Lyria chunks.
 * Lyria emits audio in delta.audio.data (streaming) or message.audio
 * (non-streaming fallback). A single generation may return the entire
 * audio payload in one SSE line (~1MB base64).
 */
function extractAudioFromSSELine(line) {
  if (!line.startsWith('data: ')) return null;
  const payload = line.slice(6).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    const chunk = JSON.parse(payload);
    const audio =
      chunk.choices?.[0]?.delta?.audio ??
      chunk.choices?.[0]?.message?.audio;
    return { data: audio?.data || null, url: audio?.url || null };
  } catch { return null; }
}

/**
 * Stream a Lyria audio generation and return the raw MP3 buffer.
 * Lyria uses SSE with base64 audio chunks in delta.audio.data fields.
 * The audio payload often arrives as a single ~1MB SSE line that can
 * be split across multiple reader.read() calls — the parser must
 * buffer incomplete lines and also drain the buffer after EOF.
 */
async function streamLyriaAudio(apiKey, prompt) {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://ohwow.fun',
      'X-Title': 'OHWOW',
    },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      modalities: ['audio'],
      audio: { format: 'mp3' },
      stream: true,
    }),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`Lyria ${response.status}: ${err.slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let audioBase64 = '';
  let audioUrl = null;
  let sseBuffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split('\n');
    sseBuffer = lines.pop() || '';

    for (const line of lines) {
      const result = extractAudioFromSSELine(line);
      if (result?.data) audioBase64 += result.data;
      if (result?.url) audioUrl = result.url;
    }
  }

  // Drain any remaining buffered line (Lyria sometimes omits trailing newline)
  if (sseBuffer.trim()) {
    const result = extractAudioFromSSELine(sseBuffer.trim());
    if (result?.data) audioBase64 += result.data;
    if (result?.url) audioUrl = result.url;
  }

  if (audioBase64) return Buffer.from(audioBase64, 'base64');
  if (audioUrl) {
    const resp = await fetch(audioUrl);
    return Buffer.from(await resp.arrayBuffer());
  }
  throw new Error('No audio data received from Lyria');
}

async function generateClip(apiKey, mood, { retries = 2 } = {}) {
  const prompt = MOOD_PROMPTS[mood];
  if (!prompt) throw new Error(`Unknown mood: ${mood}. Available: ${Object.keys(MOOD_PROMPTS).join(', ')}`);

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const label = attempt === 0 ? '' : ` (retry ${attempt}/${retries})`;
      console.log(`[gen-ambient] generating ${mood} via ${MODEL}${label}...`);
      const buffer = await streamLyriaAudio(apiKey, prompt);
      const outPath = path.join(OUT_DIR, `ambient-${mood}.mp3`);
      fs.writeFileSync(outPath, buffer);
      console.log(`[gen-ambient] saved: ambient-${mood}.mp3 (${Math.round(buffer.length / 1024)}KB)`);
      return outPath;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        console.log(`[gen-ambient] ${mood} attempt ${attempt + 1} failed: ${e.message}, retrying...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  throw lastErr;
}

async function main() {
  const apiKey = readApiKey();
  if (!apiKey) {
    console.error('[gen-ambient] No API key. Set OPENROUTER_API_KEY or add openRouterApiKey to ~/.ohwow/config.json');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const requestedMoods = process.argv.slice(2);
  const moods = requestedMoods.length
    ? requestedMoods
    : Object.keys(MOOD_PROMPTS);

  const results = { success: [], failed: [] };
  for (const mood of moods) {
    try {
      await generateClip(apiKey, mood);
      results.success.push(mood);
    } catch (e) {
      console.error(`[gen-ambient] ${mood} failed: ${e.message}`);
      results.failed.push(mood);
    }
  }

  console.log(`\n[gen-ambient] done: ${results.success.length} generated, ${results.failed.length} failed`);
  if (results.failed.length) console.log(`[gen-ambient] failed moods: ${results.failed.join(', ')}`);
}

main();
