/**
 * Voice Session
 * Orchestrates the mic -> STT -> orchestrator chat -> TTS -> speaker pipeline.
 * Implements MessagingChannel so it integrates with the existing channel system.
 */

import { EventEmitter } from 'node:events';
import type { STTProvider, TTSProvider, VoiceSessionState, STTResult, TTSOptions } from './types.js';
import type { MessagingChannel, ChannelType } from '../integrations/channel-types.js';

interface VoiceSessionConfig {
  sttProvider: STTProvider;
  ttsProvider: TTSProvider;
  /** Callback to send transcribed text to the orchestrator and get a response */
  onTranscription: (text: string) => Promise<string>;
  /** Default TTS options (voice profile, etc.) */
  ttsOptions?: TTSOptions;
}

export class VoiceSession extends EventEmitter implements MessagingChannel {
  readonly type: ChannelType = 'tui'; // Voice is a TUI enhancement, not a separate channel
  private stt: STTProvider;
  private tts: TTSProvider;
  private onTranscription: (text: string) => Promise<string>;
  private ttsOptions: TTSOptions;
  private _state: VoiceSessionState = 'idle';
  private _active = false;

  constructor(config: VoiceSessionConfig) {
    super();
    this.stt = config.sttProvider;
    this.tts = config.ttsProvider;
    this.onTranscription = config.onTranscription;
    this.ttsOptions = config.ttsOptions || {};
  }

  get state(): VoiceSessionState {
    return this._state;
  }

  get isActive(): boolean {
    return this._active;
  }

  private setState(state: VoiceSessionState): void {
    this._state = state;
    this.emit('state:changed', state);
  }

  /**
   * Process an audio buffer through the full pipeline:
   * audio -> STT -> orchestrator -> TTS -> audio output
   */
  async processAudio(audioBuffer: Buffer): Promise<{ transcription: STTResult; responseAudio?: Buffer | string }> {
    if (!this._active) throw new Error('Voice session is not active');

    // Step 1: Speech to Text
    this.setState('listening');
    const transcription = await this.stt.transcribe(audioBuffer);
    this.emit('transcription', transcription);

    if (!transcription.text.trim()) {
      this.setState('idle');
      return { transcription };
    }

    // Step 2: Send to orchestrator
    this.setState('processing');
    const responseText = await this.onTranscription(transcription.text);
    this.emit('response', responseText);

    // Step 3: Text to Speech
    this.setState('speaking');
    const ttsResult = await this.tts.synthesize(responseText);

    this.setState('idle');
    return {
      transcription,
      responseAudio: ttsResult.audio,
    };
  }

  /**
   * Process audio with sentence-level chunked TTS.
   * Emits 'audio_chunk' for each synthesized sentence so the first chunk
   * can play while remaining sentences are still being synthesized.
   */
  async processAudioChunked(
    audioBuffer: Buffer,
    options?: TTSOptions,
  ): Promise<{ transcription: STTResult; responseText: string }> {
    if (!this._active) throw new Error('Voice session is not active');

    // Step 1: Speech to Text
    this.setState('listening');
    const transcription = await this.stt.transcribe(audioBuffer);
    this.emit('transcription', transcription);

    if (!transcription.text.trim()) {
      this.setState('idle');
      return { transcription, responseText: '' };
    }

    // Step 2: Send to orchestrator
    this.setState('processing');
    const responseText = await this.onTranscription(transcription.text);
    this.emit('response', responseText);

    // Step 3: Chunked TTS (sentence by sentence)
    this.setState('speaking');
    const sentences = splitIntoSentences(responseText);
    const ttsOpts = { ...this.ttsOptions, ...options };

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      if (!sentence) continue;

      try {
        const ttsResult = await this.tts.synthesize(sentence, ttsOpts);
        this.emit('audio_chunk', {
          audio: ttsResult.audio,
          index: i,
          total: sentences.length,
          sentence,
          isLast: i === sentences.length - 1,
        });
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }

    this.setState('idle');
    return { transcription, responseText };
  }

  async start(): Promise<void> {
    const [sttOk, ttsOk] = await Promise.all([
      this.stt.isAvailable(),
      this.tts.isAvailable(),
    ]);

    if (!sttOk) throw new Error(`STT provider "${this.stt.name}" is not available`);
    if (!ttsOk) throw new Error(`TTS provider "${this.tts.name}" is not available`);

    this._active = true;
    this.setState('idle');
  }

  stop(): void {
    this._active = false;
    this.setState('idle');
  }

  // MessagingChannel implementation
  async sendResponse(_chatId: string, text: string): Promise<boolean> {
    if (!this._active) return false;
    try {
      await this.tts.synthesize(text);
      return true;
    } catch {
      return false;
    }
  }

  getStatus(): { connected: boolean; details?: Record<string, unknown> } {
    return {
      connected: this._active,
      details: {
        state: this._state,
        sttProvider: this.stt.name,
        ttsProvider: this.tts.name,
      },
    };
  }

  excludedTools(): string[] {
    // Voice doesn't need navigation tools
    return [];
  }

}

/**
 * Split text into sentences for progressive TTS.
 * Handles common abbreviations and edge cases.
 */
export function splitIntoSentences(text: string): string[] {
  if (!text.trim()) return [];

  // Split on sentence-ending punctuation followed by whitespace or end-of-string.
  // Negative lookbehind for common abbreviations (Mr., Mrs., Dr., etc.)
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // If no sentence boundaries found, return the whole text as one chunk
  if (sentences.length === 0) return [text.trim()];

  // Merge very short fragments (< 10 chars) with the previous sentence
  const merged: string[] = [];
  for (const sentence of sentences) {
    if (merged.length > 0 && sentence.length < 10) {
      merged[merged.length - 1] += ' ' + sentence;
    } else {
      merged.push(sentence);
    }
  }

  return merged;
}
