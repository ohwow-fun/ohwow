/**
 * useVoiceChat Hook (Runtime Web UI)
 * Real-time voice conversation via WebSocket.
 * Supports two modes:
 *   - full: Backend STT/TTS (binary audio over WebSocket)
 *   - browser-native: Browser Web Speech API for STT/TTS (text over WebSocket)
 * Mode is auto-detected based on backend provider availability.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import type { VoiceCallState, VoiceEventMessage, VoiceMode } from '../lib/voice-types';
import { VADProcessor } from '../lib/vad';
import { createAudioPlayer } from '../lib/pcm-utils';
import { createWebSTT, createWebTTS, type WebSTT, type WebTTS } from '../lib/web-speech';
import { getToken } from '../api/client';

interface UseVoiceChatReturn {
  state: VoiceCallState;
  transcript: string;
  response: string;
  error: string | null;
  startCall: () => Promise<void>;
  endCall: () => void;
  toggleMute: () => void;
  isMuted: boolean;
  /** Which voice mode is active */
  mode: VoiceMode | null;
}

function getVoiceWsUrl(): string {
  const token = getToken();
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = import.meta.env.DEV ? 'localhost:7700' : window.location.host;
  return `${protocol}//${host}/ws/voice?token=${token}`;
}

function getApiBaseUrl(): string {
  return import.meta.env.DEV ? 'http://localhost:7700' : '';
}

async function detectVoiceMode(): Promise<VoiceMode> {
  try {
    const token = getToken();
    const resp = await fetch(`${getApiBaseUrl()}/api/voice/providers`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      const { data } = await resp.json();
      if (data?.recommendedMode === 'full') return 'full';
    }
  } catch {
    // Backend unreachable, fall back to browser-native
  }
  return 'browser-native';
}

export function useVoiceChat(agentId: string): UseVoiceChatReturn {
  const [state, setState] = useState<VoiceCallState>('idle');
  const [transcript, setTranscript] = useState('');
  const [response, setResponse] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [mode, setMode] = useState<VoiceMode | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const vadRef = useRef<VADProcessor | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playerRef = useRef<ReturnType<typeof createAudioPlayer> | null>(null);
  const webSttRef = useRef<WebSTT | null>(null);
  const webTtsRef = useRef<WebTTS | null>(null);

  const cleanup = useCallback(() => {
    vadRef.current?.stop();
    vadRef.current = null;

    processorRef.current?.disconnect();
    processorRef.current = null;

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    playerRef.current?.close();
    playerRef.current = null;

    webSttRef.current?.stop();
    webSttRef.current = null;
    webTtsRef.current?.stop();
    webTtsRef.current = null;

    if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
      wsRef.current.close();
    }
    wsRef.current = null;

    setState('idle');
    setMode(null);
    setError(null);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const startCall = useCallback(async () => {
    setError(null);
    setTranscript('');
    setResponse('');

    const detectedMode = await detectVoiceMode();

    // Browser-native mode: check Web Speech API support
    if (detectedMode === 'browser-native') {
      const testStt = createWebSTT();
      if (!testStt.isSupported) {
        setError('Voice requires Chrome, Edge, or Safari. Firefox is not supported yet.');
        return;
      }
    }

    setMode(detectedMode);

    // Connect WebSocket (needed for both modes — orchestrator access)
    const ws = new WebSocket(getVoiceWsUrl());
    wsRef.current = ws;
    ws.binaryType = 'arraybuffer';

    if (detectedMode === 'browser-native') {
      await startBrowserNative(ws, agentId);
    } else {
      await startFull(ws, agentId);
    }
  }, [agentId, cleanup]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Browser-native mode: STT via SpeechRecognition, TTS via SpeechSynthesis.
   * Only text flows through the WebSocket.
   */
  const startBrowserNative = useCallback(async (ws: WebSocket, agentId: string) => {
    const webStt = createWebSTT();
    const webTts = createWebTTS();
    webSttRef.current = webStt;
    webTtsRef.current = webTts;

    webTts.onStart(() => setState('speaking'));
    webTts.onEnd(() => setState('listening'));

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'start', agentId, mode: 'browser-native' }));

      // Start listening once session is ready
      webStt.onResult((text, isFinal) => {
        setTranscript(text);
        if (isFinal && text.trim() && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'transcript', text }));
          setState('processing');
        }
      });

      webStt.onError((err) => {
        setError(`Speech recognition error: ${err}`);
      });

      webStt.start();
      setState('listening');
    };

    ws.onmessage = (event) => {
      // Browser-native mode: no binary audio expected
      if (event.data instanceof ArrayBuffer) return;

      try {
        const msg = JSON.parse(event.data as string) as VoiceEventMessage;
        switch (msg.type) {
          case 'response':
            setResponse(msg.text);
            webTts.speak(msg.text);
            break;
          case 'transcription':
            setTranscript(msg.text);
            break;
          case 'error':
            setError(msg.message);
            break;
          case 'state':
            // Only track processing state from server; listening/speaking managed locally
            if (msg.state === 'processing') setState('processing');
            break;
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onerror = () => {
      setError("Couldn't connect to voice server. Is the runtime running?");
      cleanup();
    };

    ws.onclose = () => {
      cleanup();
    };
  }, [cleanup]);

  /**
   * Full mode: Backend STT/TTS with binary audio over WebSocket.
   */
  const startFull = useCallback(async (ws: WebSocket, agentId: string) => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: { ideal: 16000 },
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch {
      setError("Couldn't access microphone. Check your browser permissions.");
      return;
    }
    streamRef.current = stream;

    const audioCtx = new AudioContext();
    audioCtxRef.current = audioCtx;
    const source = audioCtx.createMediaStreamSource(stream);

    const player = createAudioPlayer();
    playerRef.current = player;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'start', agentId }));
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        player.enqueue(event.data);
        return;
      }

      try {
        const msg = JSON.parse(event.data as string) as VoiceEventMessage;
        switch (msg.type) {
          case 'state':
            setState(msg.state);
            break;
          case 'transcription':
            setTranscript(msg.text);
            break;
          case 'response':
            setResponse(msg.text);
            break;
          case 'error':
            setError(msg.message);
            break;
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onerror = () => {
      setError("Couldn't connect to voice server. Is the runtime running?");
      cleanup();
    };

    ws.onclose = () => {
      cleanup();
    };

    const bufferSize = 4096;
    const processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
    processorRef.current = processor;

    const vad = new VADProcessor(audioCtx.sampleRate, {
      threshold: 0.01,
      minSpeechMs: 300,
      silenceMs: 800,
      onSpeechStart: () => {
        setState('listening');
      },
      onSpeechEnd: (audio: ArrayBuffer) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(audio);
        }
      },
    });
    vadRef.current = vad;
    vad.start();

    processor.onaudioprocess = (e) => {
      if (isMuted) return;
      const inputData = e.inputBuffer.getChannelData(0);
      vad.processFrame(inputData);
    };

    source.connect(processor);
    processor.connect(audioCtx.destination);
  }, [isMuted, cleanup]);

  const endCall = useCallback(() => {
    cleanup();
  }, [cleanup]);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      // Full mode: mute mic track
      streamRef.current?.getAudioTracks().forEach((t) => {
        t.enabled = !next;
      });
      // Browser-native mode: stop/start recognition
      if (next) {
        webSttRef.current?.stop();
      } else {
        webSttRef.current?.start();
      }
      return next;
    });
  }, []);

  return {
    state,
    transcript,
    response,
    error,
    startCall,
    endCall,
    toggleMute,
    isMuted,
    mode,
  };
}
