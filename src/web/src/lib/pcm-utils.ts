/**
 * PCM Audio Utilities (Runtime Web UI)
 * Encode/decode PCM audio and manage AudioContext playback.
 * Self-contained port of src/lib/audio/pcm-utils.ts.
 */

import { VOICE_AUDIO } from './voice-types';

/** Create a WAV header for raw PCM data (16kHz, 16-bit, mono). */
export function encodeWav(pcmData: Int16Array): ArrayBuffer {
  const { SAMPLE_RATE, BIT_DEPTH, CHANNELS } = VOICE_AUDIO;
  const byteRate = SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8);
  const blockAlign = CHANNELS * (BIT_DEPTH / 8);
  const dataSize = pcmData.byteLength;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BIT_DEPTH, true);

  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const output = new Int16Array(buffer, 44);
  output.set(pcmData);

  return buffer;
}

/** Convert Float32Array (-1 to 1) to Int16Array (PCM). */
export function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

/** Downsample audio from source sample rate to target sample rate. */
export function downsample(
  buffer: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return buffer;
  const ratio = fromRate / toRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIndex = Math.round(i * ratio);
    result[i] = buffer[Math.min(srcIndex, buffer.length - 1)];
  }
  return result;
}

/** Play a WAV ArrayBuffer through an AudioContext. */
export async function playAudio(
  audioData: ArrayBuffer,
  ctx?: AudioContext,
): Promise<void> {
  const audioCtx = ctx || new AudioContext();
  const audioBuffer = await audioCtx.decodeAudioData(audioData.slice(0));
  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioCtx.destination);

  return new Promise<void>((resolve) => {
    source.onended = () => resolve();
    source.start(0);
  });
}

/** Create a reusable audio player that queues chunks for gapless playback. */
export function createAudioPlayer(ctx?: AudioContext) {
  const audioCtx = ctx || new AudioContext();
  let queue: ArrayBuffer[] = [];
  let playing = false;

  async function playNext(): Promise<void> {
    if (queue.length === 0) {
      playing = false;
      return;
    }
    playing = true;
    const chunk = queue.shift()!;
    await playAudio(chunk, audioCtx);
    await playNext();
  }

  return {
    enqueue(audioData: ArrayBuffer): void {
      queue.push(audioData);
      if (!playing) {
        playNext();
      }
    },
    clear(): void {
      queue = [];
      playing = false;
    },
    close(): void {
      queue = [];
      playing = false;
      audioCtx.close();
    },
    get isPlaying(): boolean {
      return playing;
    },
  };
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
