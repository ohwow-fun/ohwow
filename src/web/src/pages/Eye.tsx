/**
 * Eye — Local voice + camera companion.
 *
 * Fully local: camera for presence detection, hand gesture recognition,
 * and voice via WebSocket to the local runtime's /ws/voice endpoint.
 * Zero cloud dependency.
 *
 * Layout: three-zone mobile-first design (matches cloud Eye page).
 *   Top — compact eye icon + detection status
 *   Middle — scrollable transcript + gesture guide
 *   Bottom — fixed action bar
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  Eye as EyeIcon,
  EyeClosed,
  Microphone,
  MicrophoneSlash,
  SpeakerHigh,
  CircleNotch,
  WifiHigh,
  WifiSlash,
  UserCircle,
  UserCircleMinus,
  UserCircleCheck,
  HandPalm,
  ThumbsUp,
  ThumbsDown,
  Hand,
  Heart,
} from '@phosphor-icons/react';
import { useCameraPresence } from '../hooks/useCameraPresence';
import { useVoiceChat } from '../hooks/useVoiceChat';
import { useHandGestures, type HandGesture } from '../hooks/useHandGestures';
import { HandLandmarkOverlay } from '../components/eye/HandLandmarkOverlay';
import { GestureFeedback, type GestureAction } from '../components/eye/GestureFeedback';
import { getToken } from '../api/client';

// ============================================================================
// CONSTANTS
// ============================================================================

const EVENT_DEBOUNCE_MS = 5000;
const TRANSCRIPT_FADE_MS = 8000;

type EyeState = 'inactive' | 'watching' | 'listening' | 'processing' | 'speaking';

function getApiBase(): string {
  return import.meta.env.DEV ? 'http://localhost:7700' : '';
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function EyePage() {
  const [autoVoice, setAutoVoice] = useState(true);
  const [lastGestureAction, setLastGestureAction] = useState<GestureAction | null>(null);
  const [transcriptVisible, setTranscriptVisible] = useState(false);
  const lastEventRef = useRef(0);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoVoiceRetriesRef = useRef(0);
  const autoVoiceStartingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const MAX_AUTO_VOICE_RETRIES = 2;

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

  const {
    isActive: cameraActive,
    phase: cameraPhase,
    confidence: cameraConfidence,
    error: cameraError,
    start: cameraStart,
    stop: cameraStop,
    videoRef: cameraVideoRef,
  } = useCameraPresence({
    onPresenceChange: sendPresenceEvent,
  });

  // ---- Voice (direct WebSocket to local runtime) ----
  const voice = useVoiceChat('orchestrator');

  const isVoiceActive = voice.state !== 'idle';
  const isSpeaking = voice.state === 'speaking';

  // ---- Hand gesture recognition ----
  const handleGesture = useCallback((gesture: HandGesture) => {
    switch (gesture.name) {
      case 'Open_Palm':
        if (isVoiceActive) voice.toggleMute();
        setLastGestureAction({ type: voice.isMuted ? 'unmute' : 'mute', ts: Date.now() });
        break;
      case 'Thumb_Up':
        setLastGestureAction({ type: 'thumbs-up', ts: Date.now() });
        break;
      case 'Thumb_Down':
        setLastGestureAction({ type: 'thumbs-down', ts: Date.now() });
        break;
      case 'Pointing_Up':
        if (isSpeaking) voice.toggleMute();
        setLastGestureAction({ type: 'interrupt', ts: Date.now() });
        break;
      case 'Victory':
        setLastGestureAction({ type: 'peace', ts: Date.now() });
        break;
      case 'ILoveYou':
        setLastGestureAction({ type: 'love', ts: Date.now() });
        break;
    }
  }, [isVoiceActive, isSpeaking, voice]);

  const {
    currentGesture,
    landmarks: handLandmarks,
    isReady: gesturesReady,
    error: gestureError,
  } = useHandGestures({
    videoRef: cameraVideoRef,
    enabled: cameraActive,
    onGesture: handleGesture,
  });

  // ---- Derive eye state ----
  const eyeState = useMemo<EyeState>(() => {
    if (!cameraActive) return 'inactive';
    if (isSpeaking) return 'speaking';
    if (voice.state === 'connecting') return 'processing';
    if (voice.state === 'listening') return 'listening';
    return 'watching';
  }, [cameraActive, isSpeaking, voice.state]);

  // ---- Transcript fade ----
  useEffect(() => {
    if (voice.transcript || voice.response) {
      setTranscriptVisible(true);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = setTimeout(() => setTranscriptVisible(false), TRANSCRIPT_FADE_MS);
    }
  }, [voice.transcript, voice.response]);

  // ---- Auto-start voice on presence confirmation ----
  const voiceActiveAtRef = useRef<number>(0);

  useEffect(() => {
    if (isVoiceActive) {
      voiceActiveAtRef.current = Date.now();
      autoVoiceStartingRef.current = false;
    } else {
      if (voiceActiveAtRef.current > 0 && Date.now() - voiceActiveAtRef.current > 5000) {
        autoVoiceRetriesRef.current = 0;
      }
      voiceActiveAtRef.current = 0;
      autoVoiceStartingRef.current = false;
    }
  }, [isVoiceActive]);

  useEffect(() => {
    if (cameraPhase !== 'confirmed') {
      autoVoiceStartingRef.current = false;
      autoVoiceRetriesRef.current = 0;
    }
  }, [cameraPhase]);

  const startCallRef = useRef(voice.startCall);
  useEffect(() => { startCallRef.current = voice.startCall; }, [voice.startCall]);

  useEffect(() => {
    if (
      autoVoice
      && cameraPhase === 'confirmed'
      && !isVoiceActive
      && !autoVoiceStartingRef.current
      && !voice.error
      && autoVoiceRetriesRef.current < MAX_AUTO_VOICE_RETRIES
    ) {
      autoVoiceStartingRef.current = true;
      autoVoiceRetriesRef.current++;
      startCallRef.current().catch(() => {
        autoVoiceStartingRef.current = false;
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraPhase, autoVoice, isVoiceActive, voice.error]);

  // ---- Handlers ----
  const handleActivate = async () => {
    if (cameraActive) {
      voice.endCall();
      cameraStop();
    } else {
      await cameraStart();
    }
  };

  const handleMicToggle = () => {
    if (isVoiceActive) {
      voice.endCall();
    } else {
      voice.startCall();
    }
  };

  // ---- Derived display values ----
  const error = cameraError || voice.error || gestureError;
  const hasTranscript = !!(voice.transcript || voice.response);

  // ============================================================================
  // RENDER — Three-zone layout
  // ============================================================================

  return (
    <div className="fixed inset-0 bg-black flex flex-col select-none touch-manipulation overflow-hidden">

      {/* ================================================================== */}
      {/* FULLSCREEN CAMERA BACKGROUND                                       */}
      {/* ================================================================== */}
      <video
        ref={cameraVideoRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-cover transition-opacity duration-700"
        style={{
          filter: 'brightness(0.18) saturate(0.6)',
          opacity: cameraActive ? 1 : 0,
          transform: 'scaleX(-1)',
        }}
      />
      {/* Gradient overlays for readability */}
      {cameraActive && (
        <>
          <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-black/70 pointer-events-none z-[5]" />
          <div className="absolute inset-0 bg-black/20 pointer-events-none z-[5]" />
        </>
      )}

      {/* Hand landmark overlay — above gradients so wireframes are visible */}
      <HandLandmarkOverlay landmarks={handLandmarks} videoRef={cameraVideoRef} />

      {/* Gesture feedback HUD */}
      <GestureFeedback
        gesture={currentGesture?.name ?? null}
        action={lastGestureAction}
      />

      {/* ================================================================== */}
      {/* TOP BAR — Eye icon + detection + status (compact, always visible)  */}
      {/* ================================================================== */}
      <div className="relative z-10 shrink-0 flex items-center gap-3 px-4 pt-[env(safe-area-inset-top,12px)] pb-2">
        {/* Eye state icon */}
        <button
          onClick={handleActivate}
          className={`relative w-12 h-12 shrink-0 rounded-full flex items-center justify-center border transition-all duration-500 ${
            cameraPhase === 'confirmed' ? 'border-green-500/30 bg-green-500/[0.08]'
              : cameraPhase === 'detected' ? 'border-amber-500/30 bg-amber-500/[0.06]'
              : cameraActive ? 'border-white/10 bg-white/[0.04]'
              : 'border-white/[0.06] bg-white/[0.02]'
          }`}
        >
          <EyeStateIcon state={eyeState} size={20} />
          {cameraPhase === 'detected' && (
            <div className="absolute inset-0 rounded-full border border-amber-400/30 animate-ping" />
          )}
        </button>

        {/* Status + detection */}
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-2">
            <DetectionBadge phase={cameraPhase} isActive={cameraActive} />
            {isVoiceActive && (
              <span className="text-[10px] text-violet-400/60 shrink-0">
                {voice.isMuted ? 'muted' : isSpeaking ? 'speaking' : voice.state === 'connecting' ? 'thinking' : 'live'}
              </span>
            )}
            {isVoiceActive && voice.isMuted && (
              <MicrophoneSlash size={12} weight="fill" className="text-red-400/70 shrink-0" />
            )}
          </div>
          {error && (
            <p className="text-[10px] text-red-400/70 truncate mt-0.5">{error}</p>
          )}
        </div>

        {/* Right side — status pills */}
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {gesturesReady && (
            <span className="px-2 py-0.5 text-[10px] text-cyan-400/60 rounded-full border border-cyan-500/15 bg-cyan-500/[0.04]">
              gestures
            </span>
          )}
          {cameraActive && (
            <button
              onClick={() => setAutoVoice(prev => !prev)}
              className={`px-2 py-0.5 text-[10px] rounded-full border transition-colors ${
                autoVoice
                  ? 'text-green-400/70 border-green-500/20 bg-green-500/[0.06]'
                  : 'text-neutral-600 border-white/[0.06]'
              }`}
            >
              auto {autoVoice ? 'on' : 'off'}
            </button>
          )}
        </div>
      </div>

      {/* Confidence bar (thin, full-width) */}
      {cameraActive && cameraPhase !== 'inactive' && (
        <div className="relative z-10 shrink-0 h-px bg-white/[0.04] mx-4">
          <div
            className={`h-full transition-all duration-500 ${
              cameraPhase === 'confirmed' ? 'bg-green-500/40'
                : cameraPhase === 'detected' ? 'bg-amber-500/40'
                : 'bg-white/[0.06]'
            }`}
            style={{ width: `${Math.round(cameraConfidence * 100)}%` }}
          />
        </div>
      )}

      {/* ================================================================== */}
      {/* MIDDLE — Scrollable transcript + gesture guide (flex-grow)         */}
      {/* ================================================================== */}
      <div
        ref={scrollRef}
        className="relative z-10 flex-1 overflow-y-auto overscroll-contain px-4 py-3 space-y-1"
      >
        {/* Empty state — gesture guide when camera is active */}
        {!hasTranscript && (
          <>
            {cameraActive ? (
              <GestureGuide gesturesReady={gesturesReady} isVoiceActive={isVoiceActive} gestureError={gestureError} />
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center px-8">
                <EyeClosed size={32} weight="light" className="text-white/10 mb-3" />
                <p className="text-sm text-neutral-600">Tap the eye to start</p>
              </div>
            )}
          </>
        )}

        {/* Live transcript */}
        {hasTranscript && (
          <div className={`flex flex-col gap-2 transition-opacity duration-500 ${transcriptVisible ? 'opacity-100' : 'opacity-30'}`}>
            {voice.transcript && (
              <div className="flex justify-end">
                <div className="max-w-[85%] px-3 py-2 rounded-2xl rounded-br-md bg-white/[0.08] text-neutral-300 text-sm">
                  {voice.transcript}
                  <span className="inline-block w-1 h-3 ml-0.5 bg-neutral-500 animate-pulse rounded-full" />
                </div>
              </div>
            )}
            {voice.response && (
              <div className="flex justify-start">
                <div className="max-w-[85%] px-3 py-2 rounded-2xl rounded-bl-md bg-violet-500/[0.08] text-neutral-200 text-sm leading-relaxed">
                  {voice.response}
                  {isSpeaking && (
                    <span className="inline-block w-1 h-3 ml-0.5 bg-violet-400 animate-pulse rounded-full" />
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ================================================================== */}
      {/* BOTTOM BAR — Action buttons + meta (fixed, safe area)             */}
      {/* ================================================================== */}
      <div className="relative z-10 shrink-0 border-t border-white/[0.04] bg-black/60 backdrop-blur-md pb-[env(safe-area-inset-bottom,8px)]">
        {/* Action buttons */}
        <div className="flex items-center justify-center gap-5 py-3 px-4">
          {/* Eye toggle */}
          <button
            onClick={handleActivate}
            className={`w-14 h-14 rounded-full flex items-center justify-center transition-all duration-300 ${
              cameraActive
                ? 'bg-violet-600/20 border-2 border-violet-500/40 active:bg-violet-600/40'
                : 'bg-white/5 border-2 border-white/10 active:bg-white/10'
            }`}
          >
            {cameraActive ? (
              <EyeIcon size={24} weight="fill" className="text-violet-400" />
            ) : (
              <EyeIcon size={24} weight="light" className="text-neutral-500" />
            )}
          </button>

          {/* Mic toggle */}
          {cameraActive && (
            <button
              onClick={handleMicToggle}
              className={`w-14 h-14 rounded-full flex items-center justify-center transition-all duration-300 ${
                isVoiceActive && voice.isMuted
                  ? 'bg-red-600/20 border-2 border-red-500/40 active:bg-red-600/40'
                  : isVoiceActive
                  ? 'bg-green-600/20 border-2 border-green-500/40 active:bg-green-600/40'
                  : 'bg-white/5 border-2 border-white/10 active:bg-white/10'
              }`}
            >
              {isVoiceActive && voice.isMuted ? (
                <MicrophoneSlash size={24} weight="fill" className="text-red-400" />
              ) : isVoiceActive ? (
                <Microphone size={24} weight="fill" className="text-green-400" />
              ) : (
                <Microphone size={24} weight="light" className="text-neutral-500" />
              )}
            </button>
          )}
        </div>

        {/* Meta bar */}
        <div className="flex items-center justify-between px-4 pb-1">
          <div className="flex items-center gap-1.5">
            {cameraActive ? (
              <WifiHigh size={12} className="text-green-500/50" />
            ) : (
              <WifiSlash size={12} className="text-neutral-700" />
            )}
            <span className="text-[10px] text-neutral-700">
              <span className="text-green-500/50">local</span>
              {voice.mode ? ` · ${voice.mode}` : ''}
            </span>
          </div>
          <span className="text-[10px] text-neutral-800">
            {!cameraActive ? 'tap eye to start' : isVoiceActive && voice.isMuted ? 'muted · open palm to unmute' : isVoiceActive ? 'tap mic to stop' : 'tap mic to talk'}
          </span>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

function EyeStateIcon({ state, size }: { state: EyeState; size: number }) {
  switch (state) {
    case 'speaking':
      return <SpeakerHigh size={size} weight="fill" className="text-violet-400 animate-pulse" />;
    case 'processing':
      return <CircleNotch size={size} weight="bold" className="text-violet-400 animate-spin" />;
    case 'listening':
      return <EyeIcon size={size} weight="fill" className="text-green-400" />;
    case 'watching':
      return <EyeIcon size={size} weight="light" className="text-white/30 animate-pulse" />;
    default:
      return <EyeClosed size={size} weight="light" className="text-white/15" />;
  }
}

function DetectionBadge({ phase, isActive }: { phase: string; isActive: boolean }) {
  if (!isActive) {
    return <span className="text-xs text-neutral-600">Inactive</span>;
  }
  switch (phase) {
    case 'confirmed':
      return (
        <div className="flex items-center gap-1.5">
          <UserCircleCheck size={14} weight="fill" className="text-green-400" />
          <span className="text-xs text-green-400/80">Present</span>
        </div>
      );
    case 'detected':
      return (
        <div className="flex items-center gap-1.5 animate-pulse">
          <UserCircle size={14} weight="fill" className="text-amber-400" />
          <span className="text-xs text-amber-400/80">Detecting...</span>
        </div>
      );
    case 'absent':
      return (
        <div className="flex items-center gap-1.5">
          <UserCircleMinus size={14} weight="light" className="text-neutral-600" />
          <span className="text-xs text-neutral-600">No one here</span>
        </div>
      );
    default:
      return <span className="text-xs text-neutral-600">Starting...</span>;
  }
}

function GestureGuide({ gesturesReady, isVoiceActive, gestureError }: { gesturesReady: boolean; isVoiceActive: boolean; gestureError: string | null }) {
  const gestures = [
    { icon: <HandPalm size={16} weight="fill" className="text-cyan-400" />, label: 'Open palm', action: 'Mute / unmute' },
    { icon: <ThumbsUp size={16} weight="fill" className="text-green-400" />, label: 'Thumbs up', action: 'Good response' },
    { icon: <ThumbsDown size={16} weight="fill" className="text-red-400" />, label: 'Thumbs down', action: 'Bad response' },
    { icon: <Hand size={16} weight="fill" className="text-amber-400" />, label: 'Point up', action: 'Interrupt AI' },
    { icon: <Hand size={16} weight="fill" className="text-violet-400" />, label: 'Peace sign', action: 'Easter egg' },
    { icon: <Heart size={16} weight="fill" className="text-pink-400" />, label: 'I love you', action: 'Easter egg' },
  ];

  return (
    <div className="h-full flex flex-col items-center justify-center px-6">
      <p className="text-sm text-neutral-500 mb-4">
        {isVoiceActive ? 'Speak naturally or use gestures' : 'Tap mic to talk, or use gestures'}
      </p>

      <div className="w-full max-w-xs space-y-1.5">
        {gestures.map((g) => (
          <div
            key={g.label}
            className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-white/[0.02] border border-white/[0.04]"
          >
            <div className="w-6 flex justify-center shrink-0">{g.icon}</div>
            <span className="text-xs text-neutral-400 flex-1">{g.label}</span>
            <span className="text-[10px] text-neutral-600">{g.action}</span>
          </div>
        ))}
      </div>

      {!gesturesReady && (
        <div className="flex items-center gap-2 mt-4">
          {gestureError ? (
            <span className="text-[10px] text-neutral-600">Gestures unavailable</span>
          ) : (
            <>
              <CircleNotch size={12} className="text-cyan-400/40 animate-spin" />
              <span className="text-[10px] text-neutral-600">Loading gesture model...</span>
            </>
          )}
        </div>
      )}

      <p className="text-[10px] text-neutral-700 mt-4 text-center max-w-xs">
        Hold any gesture steady for a moment
      </p>
    </div>
  );
}
