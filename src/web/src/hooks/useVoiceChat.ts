/**
 * useVoiceChat Hook (Runtime Web UI)
 * Real-time voice conversation via WebSocket.
 * Self-contained port using local lib imports and runtime auth.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import type { VoiceCallState, VoiceEventMessage } from '../lib/voice-types';
import { VADProcessor } from '../lib/vad';
import { createAudioPlayer } from '../lib/pcm-utils';
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
}

function getVoiceWsUrl(): string {
  const token = getToken();
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = import.meta.env.DEV ? 'localhost:7700' : window.location.host;
  return `${protocol}//${host}/ws/voice?token=${token}`;
}

export function useVoiceChat(agentId: string): UseVoiceChatReturn {
  const [state, setState] = useState<VoiceCallState>('idle');
  const [transcript, setTranscript] = useState('');
  const [response, setResponse] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const vadRef = useRef<VADProcessor | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playerRef = useRef<ReturnType<typeof createAudioPlayer> | null>(null);

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

    if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
      wsRef.current.close();
    }
    wsRef.current = null;

    setState('idle');
    setError(null);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const startCall = useCallback(async () => {
    setError(null);
    setTranscript('');
    setResponse('');

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

    const ws = new WebSocket(getVoiceWsUrl());
    wsRef.current = ws;

    const player = createAudioPlayer();
    playerRef.current = player;

    ws.binaryType = 'arraybuffer';

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
  }, [agentId, isMuted, cleanup]);

  const endCall = useCallback(() => {
    cleanup();
  }, [cleanup]);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      streamRef.current?.getAudioTracks().forEach((t) => {
        t.enabled = !next;
      });
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
  };
}
