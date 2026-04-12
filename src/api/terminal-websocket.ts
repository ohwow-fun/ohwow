/**
 * Terminal WebSocket
 * Dedicated /ws/terminal endpoint for interactive PTY sessions.
 *
 * Protocol:
 * - First message must be auth: { type: 'auth', token: string }
 * - After auth, client can create/destroy PTY sessions and send input.
 *
 * Client → Server (JSON):
 *   { type: 'auth', token: string }
 *   { type: 'create', id: string, cols?: number, rows?: number }
 *   { type: 'input', id: string, data: string }
 *   { type: 'resize', id: string, cols: number, rows: number }
 *   { type: 'destroy', id: string }
 *
 * Server → Client (JSON):
 *   { type: 'authenticated' }
 *   { type: 'created', id: string }
 *   { type: 'output', id: string, data: string }
 *   { type: 'exit', id: string, code: number }
 *   { type: 'error', message: string, id?: string }
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import os from 'node:os';
import { createWsAuthVerifier, type WsAuthDeps } from './ws-auth.js';
import { scrubEnvironment } from '../lib/env-scrub.js';
import { logger } from '../lib/logger.js';

// node-pty is optional — native addon that may fail to install on some systems
type IPty = import('node-pty').IPty;
const pty = await import('node-pty').catch(() => null);

const MAX_SESSIONS_PER_CLIENT = 5;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export interface TerminalWebSocketDeps extends WsAuthDeps {
  server: Server;
}

interface TerminalClient extends WebSocket {
  isAlive?: boolean;
  authenticated?: boolean;
  sessions?: Map<string, IPty>;
}

/**
 * Attach the terminal WebSocket server at /ws/terminal.
 */
export function attachTerminalWebSocket(deps: TerminalWebSocketDeps): WebSocketServer {
  const { server } = deps;
  const verifyToken = createWsAuthVerifier(deps);

  // noServer mode so multiple ws servers can share the same HTTP server
  // without stepping on each other's upgrade events. See websocket.ts for
  // the full explanation of why this matters.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', `http://${request.headers.host}`);
    if (url.pathname !== '/ws/terminal') return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  // Heartbeat — terminate unresponsive clients
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients as Set<TerminalClient>) {
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

  wss.on('connection', (ws: TerminalClient) => {
    ws.isAlive = true;
    ws.authenticated = false;
    ws.sessions = new Map();

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
      handleMessage(ws, data.toString(), verifyToken).catch((err) => {
        logger.error({ err }, '[terminal-ws] Unhandled error in message handler');
        sendJson(ws, { type: 'error', message: 'Internal error' });
      });
    });

    ws.on('close', () => cleanupClient(ws));
    ws.on('error', () => cleanupClient(ws));
  });

  logger.info('[terminal-ws] WebSocket server attached at /ws/terminal');

  return wss;
}

// ============================================================================
// MESSAGE HANDLING
// ============================================================================

type TokenVerifier = (token: string) => Promise<{ workspaceId: string; userId: string } | null>;

async function handleMessage(
  ws: TerminalClient,
  raw: string,
  verifyToken: TokenVerifier,
): Promise<void> {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    sendJson(ws, { type: 'error', message: 'Invalid JSON' });
    return;
  }

  const type = msg.type as string;

  // Auth must be first message
  if (!ws.authenticated) {
    if (type !== 'auth' || typeof msg.token !== 'string') {
      sendJson(ws, { type: 'error', message: 'First message must be { type: "auth", token: "..." }' });
      ws.close(4001, 'Auth required');
      return;
    }

    const result = await verifyToken(msg.token as string);
    if (!result) {
      sendJson(ws, { type: 'error', message: 'Invalid or expired token' });
      ws.close(4001, 'Auth failed');
      return;
    }

    ws.authenticated = true;
    logger.info({ workspaceId: result.workspaceId, userId: result.userId }, '[terminal-ws] Client authenticated');
    sendJson(ws, { type: 'authenticated' });
    return;
  }

  switch (type) {
    case 'create':
      handleCreate(ws, msg);
      break;
    case 'input':
      handleInput(ws, msg);
      break;
    case 'resize':
      handleResize(ws, msg);
      break;
    case 'destroy':
      handleDestroy(ws, msg);
      break;
    default:
      sendJson(ws, { type: 'error', message: `Unknown message type: ${type}` });
  }
}

function handleCreate(ws: TerminalClient, msg: Record<string, unknown>): void {
  const id = msg.id as string;
  if (!id) {
    sendJson(ws, { type: 'error', message: 'Session id is required' });
    return;
  }

  const sessions = ws.sessions!;

  if (sessions.has(id)) {
    sendJson(ws, { type: 'error', message: `Session "${id}" already exists`, id });
    return;
  }

  if (sessions.size >= MAX_SESSIONS_PER_CLIENT) {
    sendJson(ws, { type: 'error', message: `Max ${MAX_SESSIONS_PER_CLIENT} sessions per connection`, id });
    return;
  }

  const cols = Math.min(Math.max(Number(msg.cols) || DEFAULT_COLS, 10), 500);
  const rows = Math.min(Math.max(Number(msg.rows) || DEFAULT_ROWS, 2), 200);

  if (!pty) {
    sendJson(ws, { type: 'error', message: 'Terminal sessions are not available (node-pty not installed)', id });
    return;
  }

  const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash');

  try {
    const term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: os.homedir(),
      env: scrubEnvironment(),
    });

    sessions.set(id, term);

    term.onData((data: string) => {
      sendJson(ws, { type: 'output', id, data });
    });

    term.onExit(({ exitCode }: { exitCode: number }) => {
      sessions.delete(id);
      sendJson(ws, { type: 'exit', id, code: exitCode });
    });

    logger.info({ sessionId: id, shell, cols, rows }, '[terminal-ws] PTY session created');
    sendJson(ws, { type: 'created', id });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Couldn\'t spawn terminal';
    logger.error({ err, sessionId: id }, '[terminal-ws] Couldn\'t create PTY session');
    sendJson(ws, { type: 'error', message, id });
  }
}

function handleInput(ws: TerminalClient, msg: Record<string, unknown>): void {
  const id = msg.id as string;
  const data = msg.data as string;
  if (!id || typeof data !== 'string') {
    sendJson(ws, { type: 'error', message: 'input requires id and data' });
    return;
  }

  const term = ws.sessions!.get(id);
  if (!term) {
    sendJson(ws, { type: 'error', message: `No session "${id}"`, id });
    return;
  }

  term.write(data);
}

function handleResize(ws: TerminalClient, msg: Record<string, unknown>): void {
  const id = msg.id as string;
  const cols = Number(msg.cols);
  const rows = Number(msg.rows);
  if (!id || !cols || !rows) {
    sendJson(ws, { type: 'error', message: 'resize requires id, cols, and rows' });
    return;
  }

  const term = ws.sessions!.get(id);
  if (!term) {
    sendJson(ws, { type: 'error', message: `No session "${id}"`, id });
    return;
  }

  term.resize(
    Math.min(Math.max(cols, 10), 500),
    Math.min(Math.max(rows, 2), 200),
  );
}

function handleDestroy(ws: TerminalClient, msg: Record<string, unknown>): void {
  const id = msg.id as string;
  if (!id) {
    sendJson(ws, { type: 'error', message: 'destroy requires id' });
    return;
  }

  const term = ws.sessions!.get(id);
  if (!term) {
    sendJson(ws, { type: 'error', message: `No session "${id}"`, id });
    return;
  }

  ws.sessions!.delete(id);
  term.kill();
  logger.info({ sessionId: id }, '[terminal-ws] PTY session destroyed');
}

// ============================================================================
// HELPERS
// ============================================================================

function cleanupClient(ws: TerminalClient): void {
  if (ws.sessions) {
    for (const [id, term] of ws.sessions) {
      try {
        term.kill();
      } catch {
        // Already exited
      }
      logger.debug({ sessionId: id }, '[terminal-ws] Cleaning up PTY session');
    }
    ws.sessions.clear();
  }
}

function sendJson(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
