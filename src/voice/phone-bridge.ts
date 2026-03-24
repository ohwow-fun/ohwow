/**
 * Phone Bridge Scaffold
 * Interfaces for Twilio/Vonage integration via WebSocket.
 * Not fully wired — provides the types and patterns for future implementation.
 */

export interface PhoneBridgeConfig {
  provider: 'twilio' | 'vonage';
  /** WebSocket URL for media streams */
  wsUrl?: string;
  /** API credentials */
  apiKey?: string;
  apiSecret?: string;
  /** Phone number to use for outbound calls */
  phoneNumber?: string;
}

export interface PhoneCall {
  id: string;
  direction: 'inbound' | 'outbound';
  from: string;
  to: string;
  status: 'ringing' | 'in_progress' | 'completed' | 'failed';
  startedAt: Date;
  endedAt?: Date;
}

export interface PhoneBridgeEvents {
  'call:incoming': (call: PhoneCall) => void;
  'call:started': (call: PhoneCall) => void;
  'call:ended': (call: PhoneCall) => void;
  'audio:received': (callId: string, audio: Buffer) => void;
}

/**
 * Phone bridge interface for connecting voice calls to the orchestrator.
 *
 * Implementation pattern (Twilio example):
 * 1. Twilio sends media stream via WebSocket
 * 2. Bridge receives audio chunks, buffers them
 * 3. On silence detection, sends buffer to VoiceSession.processAudio()
 * 4. VoiceSession returns response audio
 * 5. Bridge streams response audio back via WebSocket
 *
 * For Vonage, the pattern is similar but uses their WebSocket API.
 */
export interface PhoneBridge {
  readonly provider: 'twilio' | 'vonage';
  /** Start listening for incoming calls / WebSocket connections */
  start(port: number): Promise<void>;
  /** Initiate an outbound call */
  call(to: string): Promise<PhoneCall>;
  /** Stop the bridge */
  stop(): Promise<void>;
  /** Get active calls */
  getActiveCalls(): PhoneCall[];
}
