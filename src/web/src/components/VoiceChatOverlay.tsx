/**
 * VoiceChatOverlay (Runtime Web UI)
 * Full-screen overlay for active voice calls.
 * Shows waveform, live transcript, response text, and call controls.
 */

import { useEffect } from 'react';
import type { VoiceCallState } from '../lib/voice-types';
import { VoiceWaveform } from './VoiceWaveform';
import { VoiceCallControls } from './VoiceCallControls';

interface VoiceChatOverlayProps {
  state: VoiceCallState;
  transcript: string;
  response: string;
  error: string | null;
  isMuted: boolean;
  onToggleMute: () => void;
  onEndCall: () => void;
}

const STATE_LABELS: Record<VoiceCallState, string> = {
  idle: 'Ready',
  listening: 'Listening...',
  processing: 'Thinking...',
  speaking: 'Speaking...',
};

export function VoiceChatOverlay({
  state,
  transcript,
  response,
  error,
  isMuted,
  onToggleMute,
  onEndCall,
}: VoiceChatOverlayProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEndCall();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onEndCall]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/90 backdrop-blur-sm">
      <div className="absolute inset-0" onClick={onEndCall} />

      <div className="relative z-10 flex flex-col items-center gap-8 max-w-md w-full px-6">
        {/* State label */}
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${
              state === 'listening' ? 'bg-white animate-pulse' :
              state === 'processing' ? 'bg-purple-500 animate-pulse' :
              state === 'speaking' ? 'bg-green-500 animate-pulse' :
              'bg-gray-600'
            }`}
          />
          <span className="text-sm text-neutral-400 font-mono">
            {STATE_LABELS[state]}
          </span>
        </div>

        {/* Waveform */}
        <VoiceWaveform state={state} />

        {/* Live transcript */}
        {transcript && (
          <div className="w-full text-center">
            <p className="text-xs text-neutral-500 mb-1 font-mono">You said:</p>
            <p className="text-sm text-neutral-300">{transcript}</p>
          </div>
        )}

        {/* Response */}
        {response && (
          <div className="w-full text-center">
            <p className="text-xs text-neutral-500 mb-1 font-mono">Response:</p>
            <p className="text-sm text-white">{response}</p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="w-full text-center">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Controls */}
        <VoiceCallControls
          isMuted={isMuted}
          onToggleMute={onToggleMute}
          onEndCall={onEndCall}
        />

        {/* Hint */}
        <p className="text-xs text-neutral-600">Press Esc to end call</p>
      </div>
    </div>
  );
}
