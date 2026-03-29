/**
 * Voice WebSocket
 * Dedicated /ws/voice endpoint for bidirectional audio streaming.
 *
 * Protocol:
 * - Browser → Server: JSON control messages + binary audio frames (16kHz 16-bit PCM mono)
 * - Server → Browser: JSON state/event messages + binary WAV audio chunks
 *
 * Control messages (JSON):
 *   { type: 'start', agentId: string, voiceProfileId?: string }
 *   { type: 'stop' }
 *
 * Event messages (JSON):
 *   { type: 'state', state: 'idle' | 'listening' | 'processing' | 'speaking' }
 *   { type: 'transcription', text: string }
 *   { type: 'response', text: string }
 *   { type: 'error', message: string }
 *
 * Binary frames = WAV audio chunks (server → browser)
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { VoiceSession } from '../voice/voice-session.js';
import type { VoiceSessionState, AudioChunk } from '../voice/types.js';

export interface VoiceWebSocketDeps {
  server: Server;
  sessionToken: string;
  /** Factory to create a VoiceSession for a given agent/profile */
  createVoiceSession: (agentId: string, voiceProfileId?: string) => VoiceSession | Promise<VoiceSession>;
}

interface VoiceClient extends WebSocket {
  isAlive?: boolean;
  activeSession?: VoiceSession;
  agentId?: string;
}

/**
 * Attach the voice WebSocket server at /ws/voice.
 */
export function attachVoiceWebSocket(deps: VoiceWebSocketDeps): WebSocketServer {
  const { server, sessionToken, createVoiceSession } = deps;

  const wss = new WebSocketServer({ server, path: '/ws/voice' });

  // Heartbeat
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients as Set<VoiceClient>) {
      if (!ws.isAlive) {
        cleanupClient(ws);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);

  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws: VoiceClient, req) => {
    // Auth check
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (token !== sessionToken) {
      ws.close(4001, 'Invalid session token');
      return;
    }

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    sendJson(ws, { type: 'state', state: 'idle' as VoiceSessionState });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        handleAudioFrame(ws, data as Buffer);
      } else {
        handleControlMessage(ws, data.toString(), createVoiceSession);
      }
    });

    ws.on('close', () => cleanupClient(ws));
    ws.on('error', () => cleanupClient(ws));
  });

  return wss;
}

async function handleControlMessage(
  ws: VoiceClient,
  raw: string,
  createVoiceSession: VoiceWebSocketDeps['createVoiceSession'],
): Promise<void> {
  let msg: { type: string; agentId?: string; voiceProfileId?: string };
  try {
    msg = JSON.parse(raw);
  } catch {
    sendJson(ws, { type: 'error', message: 'Invalid JSON' });
    return;
  }

  switch (msg.type) {
    case 'start': {
      if (!msg.agentId) {
        sendJson(ws, { type: 'error', message: 'agentId is required' });
        return;
      }

      // Enforce single active call per connection
      if (ws.activeSession) {
        ws.activeSession.stop();
      }

      const session = await createVoiceSession(msg.agentId, msg.voiceProfileId);
      ws.activeSession = session;
      ws.agentId = msg.agentId;

      // Wire session events to WebSocket
      session.on('state:changed', (state: VoiceSessionState) => {
        sendJson(ws, { type: 'state', state });
      });
      session.on('transcription', (result: { text: string }) => {
        sendJson(ws, { type: 'transcription', text: result.text });
      });
      session.on('response', (text: string) => {
        sendJson(ws, { type: 'response', text });
      });
      session.on('audio_chunk', (chunk: AudioChunk) => {
        // Send audio as binary frame
        if (Buffer.isBuffer(chunk.audio)) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(chunk.audio, { binary: true });
          }
        }
        // If last chunk, transition to idle
        if (chunk.isLast) {
          sendJson(ws, { type: 'state', state: 'idle' as VoiceSessionState });
        }
      });
      session.on('error', (err: Error) => {
        sendJson(ws, { type: 'error', message: err.message });
      });

      session.start().then(() => {
        sendJson(ws, { type: 'state', state: 'idle' as VoiceSessionState });
      }).catch((err: Error) => {
        sendJson(ws, { type: 'error', message: `Couldn't start voice session: ${err.message}` });
        ws.activeSession = undefined;
      });
      break;
    }

    case 'stop': {
      cleanupClient(ws);
      sendJson(ws, { type: 'state', state: 'idle' as VoiceSessionState });
      break;
    }

    default:
      sendJson(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
  }
}

function handleAudioFrame(ws: VoiceClient, audioData: Buffer): void {
  const session = ws.activeSession;
  if (!session || !session.isActive) {
    sendJson(ws, { type: 'error', message: 'No active voice session. Send { type: "start" } first.' });
    return;
  }

  // Process through the chunked pipeline
  session.processAudioChunked(audioData).catch((err: Error) => {
    sendJson(ws, { type: 'error', message: err.message });
  });
}

function cleanupClient(ws: VoiceClient): void {
  if (ws.activeSession) {
    ws.activeSession.stop();
    ws.activeSession.removeAllListeners();
    ws.activeSession = undefined;
  }
}

function sendJson(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
