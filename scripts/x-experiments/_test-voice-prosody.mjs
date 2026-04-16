#!/usr/bin/env node
/**
 * Experiment: test prosody/tone system prompts for onyx voice.
 *
 * The gpt-audio-mini model's delivery is shaped heavily by the system
 * prompt. This generates the same narration under 5 different tone
 * directives so we can A/B and pick the winner for observer/philosophical
 * Shorts.
 *
 * Output: /tmp/voice-prosody/<style>.mp3
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const VOICE = 'onyx';
const NARRATION = 'Everyone assumes agents need a server. The browser just became the host.';
const OUT_DIR = '/tmp/voice-prosody';

const STYLES = [
  {
    name: '1-baseline',
    system: 'You are a TTS engine. The user will send text in quotes. You must speak exactly the quoted text, verbatim, with natural prosody. Never respond, never acknowledge, never add words. Just read what is between the quotes.',
  },
  {
    name: '2-observer-dry',
    system: 'You are a TTS engine reading for a short-form video with observer/philosophical tone. Speak exactly the quoted text, verbatim. Deliver it dry, thoughtful, measured — the voice of a wry insider dropping an observation at a dinner party. Slight weight on the turn of the phrase. Never respond, never acknowledge, never add words.',
  },
  {
    name: '3-slow-weighted',
    system: 'You are a TTS engine reading for a contemplative short-form video. Speak exactly the quoted text, verbatim. Take your time. Let each sentence breathe. Slight pause before the punchline. Quiet, grounded, confident. Never respond, never add words.',
  },
  {
    name: '4-deadpan-ominous',
    system: 'You are a TTS engine reading for a short-form video. Speak exactly the quoted text, verbatim. Deadpan. Slightly ominous. Understated. Like a narrator in a noir film observing something everyone missed. Never respond, never add words.',
  },
  {
    name: '5-casual-confident',
    system: 'You are a TTS engine reading for social media. Speak exactly the quoted text, verbatim. Conversational, confident, a touch of wry amusement. Like someone sharing a take they know is sharp. Natural pacing. Never respond, never add words.',
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
        { role: 'user', content: `Read this aloud: "${NARRATION}"` },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`${style.name}: ${resp.status} ${await resp.text()}`);
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
  console.log(`[prosody] ${style.name}: ${(pcm.length/2/24000).toFixed(2)}s → ${mp3Path}`);
}

async function main() {
  const apiKey = readApiKey();
  if (!apiKey) { console.error('No API key'); process.exit(1); }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[prosody] narration: "${NARRATION}"`);
  console.log(`[prosody] voice: ${VOICE}\n`);
  for (const style of STYLES) {
    try { await generate(apiKey, style); }
    catch (e) { console.error(`[prosody] ${e.message}`); }
  }
  console.log(`\n[prosody] done. Listen: open ${OUT_DIR}`);
}

main();
