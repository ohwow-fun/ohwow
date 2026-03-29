/**
 * Voice Pipeline Types
 * Interfaces for speech-to-text, text-to-speech, and voice sessions.
 */

export interface STTResult {
  text: string;
  confidence: number;
  language?: string;
  durationMs: number;
}

export interface TTSResult {
  /** PCM audio buffer or file path depending on provider */
  audio: Buffer | string;
  durationMs: number;
}

export interface STTProvider {
  readonly name: string;
  readonly isLocal: boolean;
  /** Check if the provider is available (model loaded, API reachable) */
  isAvailable(): Promise<boolean>;
  /** Transcribe audio buffer (WAV/PCM) to text */
  transcribe(audio: Buffer, options?: STTOptions): Promise<STTResult>;
}

export interface STTOptions {
  language?: string;
  /** Prompt/context to improve transcription accuracy */
  prompt?: string;
}

export interface TTSProvider {
  readonly name: string;
  readonly isLocal: boolean;
  /** Check if the provider is available */
  isAvailable(): Promise<boolean>;
  /** Synthesize text to audio */
  synthesize(text: string, options?: TTSOptions): Promise<TTSResult>;
}

export interface TTSOptions {
  voice?: string;
  speed?: number;
  format?: 'pcm' | 'mp3' | 'wav';
  /** Voicebox voice profile ID for cloned voice synthesis */
  voiceProfileId?: string;
}

export type VoiceSessionState = 'idle' | 'listening' | 'processing' | 'speaking';

export interface AudioChunk {
  audio: Buffer | string;
  index: number;
  total: number;
  sentence: string;
  isLast: boolean;
}

export interface VoiceSessionEvents {
  'state:changed': (state: VoiceSessionState) => void;
  'transcription': (result: STTResult) => void;
  'response': (text: string) => void;
  'audio_chunk': (chunk: AudioChunk) => void;
  'error': (error: Error) => void;
}
