/**
 * Voice Types (Runtime Web UI)
 * Minimal subset of the main app's voice types.
 * Self-contained, no external dependencies.
 */

/** Voice call states */
export type VoiceCallState = 'idle' | 'listening' | 'processing' | 'speaking';

/** Voice WebSocket control messages (browser → server) */
export type VoiceControlMessage =
  | { type: 'start'; agentId: string; voiceProfileId?: string }
  | { type: 'stop' }
  | { type: 'mute'; muted: boolean };

/** Voice WebSocket event messages (server → browser) */
export type VoiceEventMessage =
  | { type: 'state'; state: VoiceCallState }
  | { type: 'transcription'; text: string }
  | { type: 'response'; text: string }
  | { type: 'error'; message: string };

/** Audio format constants */
export const VOICE_AUDIO = {
  SAMPLE_RATE: 16000,
  BIT_DEPTH: 16,
  CHANNELS: 1,
  BYTES_PER_SAMPLE: 2,
} as const;
