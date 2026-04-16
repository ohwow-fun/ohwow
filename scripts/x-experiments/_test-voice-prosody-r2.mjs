#!/usr/bin/env node
/**
 * Round 2: hybrid of slow-weighted (#3) + deadpan-ominous (#4).
 *
 * Three variants of the hybrid, plus a second narration to stress-test
 * the winner across different content.
 *
 * Output: /tmp/voice-prosody-r2/<style>.mp3
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const VOICE = 'onyx';
const OUT_DIR = '/tmp/voice-prosody-r2';

const NARRATION_A = 'Everyone assumes agents need a server. The browser just became the host.';
const NARRATION_B = 'Every year we build smarter models. And every year, they forget faster.';

const STYLES = [
  {
    name: '1-hybrid-balanced',
    narration: NARRATION_A,
    system: 'You are a TTS engine reading for a short-form video. Speak exactly the quoted text, verbatim. Take your time. Let each sentence breathe. Deliver it deadpan, understated, slightly ominous. Like a noir narrator observing something everyone missed. Slight pause before the punchline. Quiet, grounded, confident. Never respond, never add words.',
  },
  {
    name: '2-hybrid-darker',
    narration: NARRATION_A,
    system: 'You are a TTS engine reading for a short-form video. Speak exactly the quoted text, verbatim. Low, close-mic delivery. Flat affect, almost whispered weight. Heavy on the noir — a narrator describing something that has already gone wrong. Pause before the turn. Deliberate, cold, no inflection rise on the second sentence. Never respond, never add words.',
  },
  {
    name: '3-hybrid-quieter',
    narration: NARRATION_A,
    system: 'You are a TTS engine reading for a short-form video. Speak exactly the quoted text, verbatim. Intimate, reflective, just-above-a-whisper weight. Measured breaths between sentences. The delivery of someone thinking aloud, quietly certain. Slight gravity on the final word. Never respond, never add words.',
  },
  {
    name: '4-hybrid-balanced-narrationB',
    narration: NARRATION_B,
    system: 'You are a TTS engine reading for a short-form video. Speak exactly the quoted text, verbatim. Take your time. Let each sentence breathe. Deliver it deadpan, understated, slightly ominous. Like a noir narrator observing something everyone missed. Slight pause before the punchline. Quiet, grounded, confident. Never respond, never add words.',
  },
];

function readApiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ohwow', 'config.json'), 'utf8'));
    return cfg.openRouterApiKey || null;
  } catch { return null; }
}

async function generate(apiKey, style) {
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
      model: 'openai/gpt-audio-mini',
      modalities: ['text', 'audio'],
      audio: { voice: VOICE, format: 'pcm16' },
      stream: true,
      messages: [
        { role: 'system', content: style.system },
        { role: 'user', content: `Read this aloud: "${style.narration}"` },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`${style.name}: ${resp.status}`);
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
  if (!b64) throw new Error(`${style.name}: no audio`);
  const pcm = Buffer.from(b64, 'base64');
  const pcmPath = path.join(OUT_DIR, `${style.name}.pcm`);
  const mp3Path = path.join(OUT_DIR, `${style.name}.mp3`);
  fs.writeFileSync(pcmPath, pcm);
  execSync(`ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${pcmPath}" -c:a libmp3lame -q:a 4 "${mp3Path}" 2>/dev/null`);
  fs.unlinkSync(pcmPath);
  console.log(`[prosody-r2] ${style.name}: ${(pcm.length/2/24000).toFixed(2)}s → ${mp3Path}`);
}

async function main() {
  const apiKey = readApiKey();
  if (!apiKey) { console.error('No API key'); process.exit(1); }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const style of STYLES) {
    try { await generate(apiKey, style); }
    catch (e) { console.error(`[prosody-r2] ${e.message}`); }
  }
  console.log(`\n[prosody-r2] done. Listen: open ${OUT_DIR}`);
}

main();
