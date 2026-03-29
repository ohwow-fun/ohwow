/**
 * Voice Pipeline Types
 * Interfaces for speech-to-text, text-to-speech, and voice sessions.
 */

export interface TranscriptionSegment {
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}

export interface STTResult {
  text: string;
  confidence: number;
  language?: string;
  durationMs: number;
  /** Speaker-diarized segments (only populated by providers that support diarization) */
  segments?: TranscriptionSegment[];
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

// ---------------------------------------------------------------------------
// Podcast types (VibeVoice multi-speaker TTS 1.5B)
// ---------------------------------------------------------------------------

export interface PodcastSpeaker {
  id: string;
  name: string;
  voice?: string;
}

export interface PodcastSegment {
  speakerId: string;
  text: string;
}

export interface PodcastRequest {
  speakers: PodcastSpeaker[];
  segments: PodcastSegment[];
  format?: 'wav' | 'mp3';
}

export interface PodcastResult {
  audio: Buffer;
  durationMs: number;
  segments: Array<{ speakerId: string; startMs: number; endMs: number }>;
}

export interface VoiceSessionEvents {
  'state:changed': (state: VoiceSessionState) => void;
  'transcription': (result: STTResult) => void;
  'response': (text: string) => void;
  'audio_chunk': (chunk: AudioChunk) => void;
  'error': (error: Error) => void;
}
