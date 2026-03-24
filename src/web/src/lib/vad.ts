/**
 * Voice Activity Detection (Runtime Web UI)
 * Energy-based speech detection with audio buffering.
 * Self-contained port of src/lib/audio/vad.ts.
 */

import { VOICE_AUDIO } from './voice-types';
import { downsample, float32ToInt16, encodeWav } from './pcm-utils';

export interface VADOptions {
  /** Energy threshold for speech detection (0-1). Default: 0.01 */
  threshold?: number;
  /** Minimum speech duration in ms before triggering. Default: 300 */
  minSpeechMs?: number;
  /** Silence duration in ms before ending speech. Default: 800 */
  silenceMs?: number;
  onSpeechStart?: () => void;
  onSpeechEnd?: (audio: ArrayBuffer) => void;
}

export class VADProcessor {
  private threshold: number;
  private minSpeechMs: number;
  private silenceMs: number;
  private onSpeechStart?: () => void;
  private onSpeechEnd?: (audio: ArrayBuffer) => void;

  private isSpeaking = false;
  private speechStartTime = 0;
  private lastSpeechTime = 0;
  private audioChunks: Float32Array[] = [];
  private sampleRate: number;
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  constructor(sampleRate: number, options: VADOptions = {}) {
    this.sampleRate = sampleRate;
    this.threshold = options.threshold ?? 0.01;
    this.minSpeechMs = options.minSpeechMs ?? 300;
    this.silenceMs = options.silenceMs ?? 800;
    this.onSpeechStart = options.onSpeechStart;
    this.onSpeechEnd = options.onSpeechEnd;
  }

  processFrame(audioData: Float32Array): void {
    const energy = calculateRMS(audioData);
    const now = Date.now();

    if (energy > this.threshold) {
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.speechStartTime = now;
        this.audioChunks = [];
        this.onSpeechStart?.();
      }
      this.lastSpeechTime = now;
    }

    if (this.isSpeaking) {
      this.audioChunks.push(new Float32Array(audioData));

      if (energy <= this.threshold && now - this.lastSpeechTime > this.silenceMs) {
        this.endSpeech();
      }
    }
  }

  start(): void {
    this.checkInterval = setInterval(() => {
      if (this.isSpeaking && Date.now() - this.lastSpeechTime > this.silenceMs) {
        this.endSpeech();
      }
    }, 100);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.isSpeaking) {
      this.endSpeech();
    }
  }

  private endSpeech(): void {
    const duration = Date.now() - this.speechStartTime;
    this.isSpeaking = false;

    if (duration < this.minSpeechMs || this.audioChunks.length === 0) {
      this.audioChunks = [];
      return;
    }

    const totalLength = this.audioChunks.reduce((sum, c) => sum + c.length, 0);
    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this.audioChunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    this.audioChunks = [];

    const downsampled = downsample(combined, this.sampleRate, VOICE_AUDIO.SAMPLE_RATE);
    const pcm = float32ToInt16(downsampled);
    const wav = encodeWav(pcm);

    this.onSpeechEnd?.(wav);
  }
}

function calculateRMS(buffer: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    sum += buffer[i] * buffer[i];
  }
  return Math.sqrt(sum / buffer.length);
}
