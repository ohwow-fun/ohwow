#!/usr/bin/env node
/**
 * Generate the same sample narration across all gpt-audio-mini voices.
 * Saves MP3s to /tmp/voice-samples/<voice>.mp3 for A/B listening.
 *
 * Usage: node scripts/x-experiments/_test-gpt-audio-voices.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const SAMPLE = 'Everyone assumes agents need a server. The browser just became the host.';
const OUT_DIR = '/tmp/voice-samples';
const MODEL = 'openai/gpt-audio-mini';

function readApiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ohwow', 'config.json'), 'utf8'));
    return cfg.openRouterApiKey || null;
  } catch { return null; }
}

async function generateVoice(apiKey, voice) {
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://ohwow.fun',
      'X-Title': 'OHWOW',
    },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model: MODEL,
      modalities: ['text', 'audio'],
      audio: { voice, format: 'pcm16' },
      stream: true,
      messages: [
        { role: 'system', content: 'You are a TTS engine. The user will send text in quotes. You must speak exactly the quoted text, verbatim, with natural prosody. Never respond, never acknowledge, never add words. Just read what is between the quotes.' },
        { role: 'user', content: `Read this aloud: "${SAMPLE}"` },
      ],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`${voice} failed: ${resp.status} ${err.slice(0, 200)}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', b64 = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() || '';
    for (const l of lines) {
      if (!l.startsWith('data: ')) continue;
      const p = l.slice(6).trim();
      if (!p || p === '[DONE]') continue;
      try {
        const c = JSON.parse(p);
        const a = c.choices?.[0]?.delta?.audio ?? c.choices?.[0]?.message?.audio;
        if (a?.data) b64 += a.data;
      } catch {}
    }
  }
  if (!b64) throw new Error(`${voice}: no audio data`);
  const pcm = Buffer.from(b64, 'base64');
  const pcmPath = path.join(OUT_DIR, `${voice}.pcm`);
  const mp3Path = path.join(OUT_DIR, `${voice}.mp3`);
  fs.writeFileSync(pcmPath, pcm);
  execSync(`ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${pcmPath}" -c:a libmp3lame -q:a 4 "${mp3Path}" 2>/dev/null`);
  fs.unlinkSync(pcmPath);
  const mp3Size = fs.statSync(mp3Path).size;
  console.log(`[voices] ${voice}: ${(pcm.length/2/24000).toFixed(2)}s, ${Math.round(mp3Size/1024)}KB → ${mp3Path}`);
}

async function main() {
  const apiKey = readApiKey();
  if (!apiKey) { console.error('No API key'); process.exit(1); }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const voice of VOICES) {
    try { await generateVoice(apiKey, voice); }
    catch (e) { console.error(`[voices] ${e.message}`); }
  }
  console.log(`\n[voices] done. Listen: open ${OUT_DIR}`);
}

main();
