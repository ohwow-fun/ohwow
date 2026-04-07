/**
 * Eye — Local voice + camera companion.
 *
 * Fully local: camera for presence detection, voice via WebSocket
 * to the local runtime's /ws/voice endpoint. Zero cloud dependency.
 *
 * Works on the MacBook browser (webcam + laptop mic) or from a
 * phone accessing the runtime via LAN IP / Cloudflare tunnel.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Eye as EyeIcon,
  EyeClosed,
  Microphone,
  MicrophoneSlash,
  SpeakerHigh,
  CircleNotch,
} from '@phosphor-icons/react';
import { useCameraPresence } from '../hooks/useCameraPresence';
import { useVoiceChat } from '../hooks/useVoiceChat';
import { getToken } from '../api/client';

const EVENT_DEBOUNCE_MS = 5000;
const TRANSCRIPT_FADE_MS = 8000;

type EyeState = 'inactive' | 'watching' | 'listening' | 'processing' | 'speaking';

function getApiBase(): string {
  return import.meta.env.DEV ? 'http://localhost:7700' : '';
}

export function EyePage() {
  const [eyeState, setEyeState] = useState<EyeState>('inactive');
  const [autoVoice, setAutoVoice] = useState(true);
  const [transcriptVisible, setTranscriptVisible] = useState(false);
  const lastEventRef = useRef(0);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- Presence detection (camera) ----
  const sendPresenceEvent = useCallback(async (event: { type: 'arrival' | 'departure' | 'still_here'; confidence: number }) => {
    const now = Date.now();
    if (now - lastEventRef.current < EVENT_DEBOUNCE_MS) return;
    lastEventRef.current = now;

    const token = getToken();
    try {
      await fetch(`${getApiBase()}/api/presence/event`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ eventType: event.type, confidence: event.confidence }),
      });
    } catch {
      // Best-effort
    }
  }, []);

  const camera = useCameraPresence({
    onPresenceChange: sendPresenceEvent,
  });

  // ---- Voice (direct WebSocket to local runtime) ----
  const voice = useVoiceChat('orchestrator');

  // ---- Derive eye state ----
  useEffect(() => {
    if (!camera.isActive) {
      setEyeState('inactive');
      return;
    }
    if (voice.state === 'speaking') {
      setEyeState('speaking');
    } else if (voice.state === 'processing') {
      setEyeState('processing');
    } else if (voice.state === 'listening') {
      setEyeState('listening');
    } else {
      setEyeState('watching');
    }
  }, [camera.isActive, voice.state]);

  // ---- Auto-start voice on presence confirmation ----
  const voiceState = voice.state;
  const voiceStartCall = voice.startCall;
  useEffect(() => {
    if (autoVoice && camera.phase === 'confirmed' && voiceState === 'idle') {
      voiceStartCall().catch(() => {});
    }
  }, [camera.phase, autoVoice, voiceState, voiceStartCall]);

  // ---- Transcript fade ----
  useEffect(() => {
    if (voice.transcript || voice.response) {
      setTranscriptVisible(true);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = setTimeout(() => setTranscriptVisible(false), TRANSCRIPT_FADE_MS);
    }
  }, [voice.transcript, voice.response]);

  // ---- Handlers ----
  const handleActivate = async () => {
    if (camera.isActive) {
      voice.endCall();
      camera.stop();
    } else {
      await camera.start();
    }
  };

  const handleMicToggle = () => {
    if (voice.state === 'idle') {
      voice.startCall().catch(() => {});
    } else if (voice.isMuted) {
      voice.toggleMute();
    } else {
      voice.toggleMute();
    }
  };

  // ---- Eye icon by state ----
  const eyeIconElement = (() => {
    switch (eyeState) {
      case 'speaking':
        return <SpeakerHigh size={48} weight="fill" className="text-violet-400 animate-pulse" />;
      case 'processing':
        return <CircleNotch size={48} weight="bold" className="text-violet-400 animate-spin" />;
      case 'listening':
        return <EyeIcon size={48} weight="fill" className="text-green-400" />;
      case 'watching':
        return <EyeIcon size={48} weight="light" className="text-white/40 animate-pulse" />;
      default:
        return <EyeClosed size={48} weight="light" className="text-white/20" />;
    }
  })();

  const statusText = (() => {
    switch (eyeState) {
      case 'speaking': return 'Speaking...';
      case 'processing': return 'Thinking...';
      case 'listening': return 'Listening...';
      case 'watching':
        return camera.phase === 'confirmed' ? "You're here. Tap mic to talk."
          : camera.phase === 'detected' ? 'Someone detected...'
          : 'Watching...';
      default: return 'Tap the eye to start';
    }
  })();

  const error = camera.error || voice.error;

  return (
    <div className="fixed inset-0 bg-black flex flex-col items-center justify-center select-none overflow-hidden">
      {/* Camera preview */}
      <div className="relative w-36 h-36 rounded-full overflow-hidden border-2 border-white/[0.08] mb-6">
        <video
          ref={camera.videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover"
          style={{ filter: camera.isActive ? 'brightness(0.12)' : 'brightness(0)' }}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          {eyeIconElement}
        </div>
        {camera.phase === 'detected' && (
          <div className="absolute inset-0 rounded-full border-2 border-violet-400/40 animate-ping" />
        )}
        {eyeState === 'listening' && (
          <div className="absolute inset-[-4px] rounded-full border-2 border-green-400/30 animate-pulse" />
        )}
      </div>

      {/* Status */}
      <p className="text-sm text-neutral-400 mb-1">{statusText}</p>
      {error && <p className="text-xs text-red-400/80 mb-2 px-8 text-center">{error}</p>}

      {/* Transcript */}
      <div className={`px-8 mb-6 min-h-[60px] flex items-center justify-center transition-opacity duration-500 ${transcriptVisible ? 'opacity-100' : 'opacity-0'}`}>
        <div className="text-center max-w-sm">
          {voice.transcript && <p className="text-xs text-neutral-500 mb-1">You: {voice.transcript}</p>}
          {voice.response && <p className="text-sm text-neutral-300 leading-relaxed">{voice.response}</p>}
        </div>
      </div>

      {/* Buttons */}
      <div className="flex items-center gap-6">
        <button
          onClick={handleActivate}
          className={`w-16 h-16 rounded-full flex items-center justify-center transition-all duration-300 ${
            camera.isActive
              ? 'bg-violet-600/20 border-2 border-violet-500/40 active:bg-violet-600/40'
              : 'bg-white/5 border-2 border-white/10 active:bg-white/10'
          }`}
        >
          {camera.isActive ? (
            <EyeIcon size={28} weight="fill" className="text-violet-400" />
          ) : (
            <EyeIcon size={28} weight="light" className="text-neutral-500" />
          )}
        </button>

        {camera.isActive && (
          <button
            onClick={handleMicToggle}
            className={`w-16 h-16 rounded-full flex items-center justify-center transition-all duration-300 ${
              voice.state !== 'idle' && !voice.isMuted
                ? 'bg-green-600/20 border-2 border-green-500/40 active:bg-green-600/40'
                : voice.isMuted
                  ? 'bg-red-600/10 border-2 border-red-500/20'
                  : 'bg-white/5 border-2 border-white/10 active:bg-white/10'
            }`}
          >
            {voice.state !== 'idle' && !voice.isMuted ? (
              <Microphone size={28} weight="fill" className="text-green-400" />
            ) : voice.isMuted ? (
              <MicrophoneSlash size={28} weight="fill" className="text-red-400/60" />
            ) : (
              <Microphone size={28} weight="light" className="text-neutral-500" />
            )}
          </button>
        )}
      </div>

      <p className="text-[10px] text-neutral-600 mt-3">
        {!camera.isActive ? 'Tap eye to start' : voice.state !== 'idle' ? 'Speak naturally' : 'Tap mic to talk'}
      </p>

      {camera.isActive && (
        <button
          onClick={() => setAutoVoice(prev => !prev)}
          className="mt-4 px-3 py-1 text-[10px] text-neutral-600 border border-white/[0.06] rounded-full hover:bg-white/[0.04] transition-colors"
        >
          Auto-voice: {autoVoice ? 'on' : 'off'}
        </button>
      )}

      {/* Footer */}
      <div className="fixed bottom-0 inset-x-0 px-4 py-3 flex items-center justify-between">
        <span className="text-[10px] text-neutral-600">
          local {voice.mode ? `· ${voice.mode}` : ''}
        </span>
        <span className="text-[10px] text-neutral-700">ohwow</span>
      </div>
    </div>
  );
}
