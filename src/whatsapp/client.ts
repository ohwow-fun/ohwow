/**
 * WhatsApp Client
 * Wraps Baileys to provide WhatsApp Web connectivity via QR code scan.
 * Only processes messages from allowlisted chats.
 * Implements MessagingChannel for the channel abstraction layer.
 */

import makeWASocket, {
  BufferJSON,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import type { WASocket, WAMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import type Database from 'better-sqlite3';
import type { TypedEventBus } from '../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../tui/types.js';
import { createSqliteAuthState, acquireConnectionLock, renewConnectionLock, releaseConnectionLock } from './auth-state.js';
import { getMachineId } from '../lib/machine-id.js';
import type { WhatsAppConnectionStatus, WhatsAppAllowedChat, WhatsAppMessage } from './types.js';
import type { MessagingChannel, ChannelType, ConnectionIdentity } from '../integrations/channel-types.js';
import { logger } from '../lib/logger.js';

const SEND_DELAY_MS = 500;
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEDUP_MAX_SIZE = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WhatsAppClient implements MessagingChannel {
  readonly type: ChannelType = 'whatsapp';

  private rawDb: Database.Database;
  private workspaceId: string;
  private eventBus: TypedEventBus<RuntimeEvents>;
  private socket: WASocket | null = null;
  private connectionId: string | null = null;
  /** Pre-set connectionId for multi-instance mode (set via forConnection factory) */
  private targetConnectionId: string | null = null;
  private _identity: ConnectionIdentity | undefined;
  private onMessage: ((connectionId: string, chatId: string, sender: string, text: string) => void) | null = null;
  private originalConsoleInfo: typeof console.info | null = null;
  private originalConsoleWarn: typeof console.warn | null = null;
  private badMacCount = 0;

  /** Dedup map: messageId → timestamp. Prevents duplicate notify events. */
  private seenMessages = new Map<string, number>();

  /** Sequential send queue to pace outbound messages and avoid WhatsApp temp-bans. */
  private sendQueue: Promise<void> = Promise.resolve();

  /** Heartbeat interval for connection lock renewal. */
  private lockHeartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(rawDb: Database.Database, workspaceId: string, eventBus: TypedEventBus<RuntimeEvents>) {
    this.rawDb = rawDb;
    this.workspaceId = workspaceId;
    this.eventBus = eventBus;
  }

  /**
   * Factory: create a client bound to a specific connection row.
   * Used in multi-connection mode where each DB row gets its own client.
   */
  static forConnection(
    rawDb: Database.Database,
    workspaceId: string,
    eventBus: TypedEventBus<RuntimeEvents>,
    connectionId: string,
    opts?: { label?: string; isDefault?: boolean },
  ): WhatsAppClient {
    const client = new WhatsAppClient(rawDb, workspaceId, eventBus);
    client.targetConnectionId = connectionId;
    client._identity = {
      connectionId,
      label: opts?.label,
      isDefault: opts?.isDefault,
    };
    return client;
  }

  get identity(): ConnectionIdentity | undefined {
    return this._identity;
  }

  // ===========================================================================
  // MessagingChannel interface
  // ===========================================================================

  async sendResponse(chatId: string, text: string): Promise<boolean> {
    const chunks = chunkMessage(text, 4000);
    for (const chunk of chunks) {
      const sent = await this.sendMessage(chatId, chunk);
      if (!sent) return false;
    }
    return true;
  }

  getStatus(): { connected: boolean; details?: Record<string, unknown> } {
    const waStatus = this.getWaStatus();
    return {
      connected: waStatus.status === 'connected',
      details: {
        phoneNumber: waStatus.phoneNumber,
        connectionId: waStatus.connectionId,
        status: waStatus.status,
      },
    };
  }

  excludedTools(): string[] {
    return ['switch_tab'];
  }

  transformToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
    if (toolName === 'run_agent') {
      return { ...input, mode: 'batch' };
    }
    return input;
  }

  // ===========================================================================
  // WhatsApp-specific public API
  // ===========================================================================

  /**
   * Set the message handler for incoming WhatsApp messages.
   * Called after allowlist filtering.
   */
  setMessageHandler(handler: (connectionId: string, chatId: string, sender: string, text: string) => void) {
    this.onMessage = handler;
  }

  /**
   * Connect to WhatsApp. Loads existing auth or generates QR code.
   */
  async connect(): Promise<void> {
    this.installConsoleFilters();

    // Get or create connection row
    const connectionId = this.getOrCreateConnection();
    this.connectionId = connectionId;

    // Acquire connection lock — prevents two devices from connecting the same WA number
    const deviceId = getMachineId() || 'unknown';
    const lockAcquired = acquireConnectionLock(this.rawDb, connectionId, deviceId);
    if (!lockAcquired) {
      throw new Error('Connection locked by another device');
    }

    // Ensure identity is set (for single-instance mode where forConnection wasn't used)
    if (!this._identity) {
      const row = this.rawDb.prepare(
        'SELECT label, is_default FROM whatsapp_connections WHERE id = ?',
      ).get(connectionId) as { label: string | null; is_default: number } | undefined;
      this._identity = {
        connectionId,
        label: row?.label ?? undefined,
        isDefault: row?.is_default === 1,
      };
    }

    const { state, saveCreds } = createSqliteAuthState(this.rawDb, connectionId);
    const { version } = await fetchLatestBaileysVersion();

    // Create a no-op logger to satisfy Baileys' pino requirement
    const noopLogger = {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
      child: () => noopLogger,
      level: 'silent',
    };

    const socket = makeWASocket({
      version,
      browser: ['OHWOW', '', ''],
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, noopLogger as never),
      },
      logger: noopLogger as never,
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
    });
    this.socket = socket;

    // Start lock heartbeat renewal (every 30s)
    this.lockHeartbeat = setInterval(() => {
      if (this.connectionId) {
        renewConnectionLock(this.rawDb, this.connectionId, deviceId);
      }
    }, 30_000);

    // Handle credential updates
    socket.ev.on('creds.update', () => {
      saveCreds();
    });

    // Handle connection updates
    socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.updateStatus('qr_pending');
        this.eventBus.emit('whatsapp:qr', { qr });
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        const reason = (lastDisconnect?.error as Error)?.message || 'Unknown';
        this.updateStatus('disconnected');
        this.eventBus.emit('whatsapp:disconnected', { reason });

        // Detect Bad MAC / Signal Protocol desync errors
        const isBadMac = /bad mac|hmac|decrypt/i.test(reason);
        if (isBadMac) {
          this.badMacCount++;
          if (this.badMacCount >= 3) {
            this.clearSignalSessions();
            this.badMacCount = 0;
          }
        } else {
          this.badMacCount = 0;
        }

        if (shouldReconnect) {
          // Reconnect after a delay
          setTimeout(() => this.connect(), 3000);
        } else {
          // Logged out — clear auth state
          this.clearAuthState();
          this.removeConsoleFilters();
        }
      }

      if (connection === 'open') {
        const phoneNumber = socket.user?.id?.split(':')[0] || null;
        this.updateStatus('connected', phoneNumber);
        this.eventBus.emit('whatsapp:connected', { phoneNumber: phoneNumber || 'unknown' });
      }
    });

    // Handle incoming messages
    socket.ev.on('messages.upsert', ({ messages: waMessages, type }) => {
      if (type !== 'notify') return;

      for (const msg of waMessages) {
        this.handleMessage(msg);
      }
    });
  }

  /**
   * Disconnect from WhatsApp.
   */
  async disconnect(): Promise<void> {
    if (this.lockHeartbeat) {
      clearInterval(this.lockHeartbeat);
      this.lockHeartbeat = null;
    }
    if (this.connectionId) {
      releaseConnectionLock(this.rawDb, this.connectionId);
    }
    if (this.socket) {
      this.socket.end(undefined);
      this.socket = null;
    }
    this.updateStatus('disconnected');
    this.removeConsoleFilters();
  }

  /**
   * Send a text message to a WhatsApp chat.
   */
  async sendMessage(chatId: string, text: string): Promise<boolean> {
    if (!this.socket) return false;
    try {
      const sock = this.socket;
      await this.throttledSend(() => sock.sendMessage(chatId, { text }));
      return true;
    } catch (err) {
      logger.error({ err }, '[WhatsApp] Failed to send message');
      return false;
    }
  }

  /**
   * Send a media message (image, document, audio, video) to a WhatsApp chat.
   */
  async sendMedia(
    chatId: string,
    type: 'image' | 'document' | 'audio' | 'video',
    buffer: Buffer,
    options?: { caption?: string; mimetype?: string; fileName?: string },
  ): Promise<boolean> {
    if (!this.socket) return false;
    try {
      // Build type-specific message content for Baileys
      /* eslint-disable @typescript-eslint/no-explicit-any */
      let content: any;
      switch (type) {
        case 'image':
          content = { image: buffer, caption: options?.caption, mimetype: options?.mimetype };
          break;
        case 'video':
          content = { video: buffer, caption: options?.caption, mimetype: options?.mimetype };
          break;
        case 'audio':
          content = { audio: buffer, mimetype: options?.mimetype || 'audio/mpeg' };
          break;
        case 'document':
          content = { document: buffer, mimetype: options?.mimetype || 'application/octet-stream', fileName: options?.fileName };
          break;
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
      const sock = this.socket;
      await this.throttledSend(() => sock.sendMessage(chatId, content));
      return true;
    } catch (err) {
      logger.error({ err }, '[WhatsApp] Failed to send media');
      return false;
    }
  }

  /**
   * Check if a chat ID is in the allowlist.
   */
  isAllowedChat(chatId: string): boolean {
    if (!this.connectionId) return false;
    const row = this.rawDb.prepare(
      'SELECT 1 FROM whatsapp_allowed_chats WHERE connection_id = ? AND chat_id = ?',
    ).get(this.connectionId, chatId);
    return !!row;
  }

  /**
   * Add a chat to the allowlist.
   */
  addAllowedChat(chatId: string, name: string | null, type: 'individual' | 'group' = 'individual'): void {
    if (!this.connectionId) return;
    this.rawDb.prepare(`
      INSERT OR IGNORE INTO whatsapp_allowed_chats (connection_id, chat_id, chat_name, chat_type)
      VALUES (?, ?, ?, ?)
    `).run(this.connectionId, chatId, name, type);
  }

  /**
   * Update the display name of an allowed chat.
   */
  updateChatName(chatId: string, name: string): boolean {
    if (!this.connectionId) return false;
    const result = this.rawDb.prepare(
      'UPDATE whatsapp_allowed_chats SET chat_name = ? WHERE connection_id = ? AND chat_id = ?',
    ).run(name, this.connectionId, chatId);
    return result.changes > 0;
  }

  /**
   * Remove a chat from the allowlist.
   */
  removeAllowedChat(chatId: string): void {
    if (!this.connectionId) return;
    this.rawDb.prepare(
      'DELETE FROM whatsapp_allowed_chats WHERE connection_id = ? AND chat_id = ?',
    ).run(this.connectionId, chatId);
  }

  /**
   * Find allowed chats by name (case-insensitive partial match).
   */
  findChatsByName(name: string): WhatsAppAllowedChat[] {
    if (!this.connectionId) return [];
    // Escape LIKE wildcards in the search term
    const escaped = name.replace(/[%_]/g, '\\$&');
    return this.rawDb.prepare(
      "SELECT * FROM whatsapp_allowed_chats WHERE connection_id = ? AND chat_name LIKE ? ESCAPE '\\' COLLATE NOCASE",
    ).all(this.connectionId, `%${escaped}%`) as WhatsAppAllowedChat[];
  }

  /**
   * Get all allowed chats for this connection.
   */
  getAllowedChats(): WhatsAppAllowedChat[] {
    if (!this.connectionId) return [];
    return this.rawDb.prepare(
      'SELECT * FROM whatsapp_allowed_chats WHERE connection_id = ? ORDER BY created_at',
    ).all(this.connectionId) as WhatsAppAllowedChat[];
  }

  /**
   * Retrieve stored chat messages with optional filters.
   */
  getChatMessages(opts: {
    chatId?: string;
    since?: string;
    until?: string;
    limit?: number;
    includeReplies?: boolean;
    search?: string;
  }): WhatsAppMessage[] {
    if (!this.connectionId) return [];
    const conditions = ['connection_id = ?'];
    const params: (string | number)[] = [this.connectionId];
    if (opts.chatId) { conditions.push('chat_id = ?'); params.push(opts.chatId); }
    if (!opts.includeReplies) { conditions.push("role = 'user'"); }
    if (opts.since) { conditions.push('created_at >= ?'); params.push(opts.since); }
    if (opts.until) { conditions.push('created_at < ?'); params.push(opts.until); }
    if (opts.search) {
      const escaped = opts.search.replace(/[%_]/g, '\\$&');
      conditions.push("content LIKE ? ESCAPE '\\' COLLATE NOCASE");
      params.push(`%${escaped}%`);
    }
    const limit = Math.min(opts.limit ?? 100, 500);
    params.push(limit);
    return this.rawDb.prepare(
      `SELECT * FROM whatsapp_chat_messages WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC LIMIT ?`,
    ).all(...params) as WhatsAppMessage[];
  }

  /**
   * Get the WhatsApp-specific connection status.
   */
  getWaStatus(): { status: WhatsAppConnectionStatus; phoneNumber: string | null; connectionId: string | null } {
    if (!this.connectionId) {
      return { status: 'disconnected', phoneNumber: null, connectionId: null };
    }
    const row = this.rawDb.prepare(
      'SELECT status, phone_number FROM whatsapp_connections WHERE id = ?',
    ).get(this.connectionId) as { status: WhatsAppConnectionStatus; phone_number: string | null } | undefined;

    return {
      status: row?.status || 'disconnected',
      phoneNumber: row?.phone_number || null,
      connectionId: this.connectionId,
    };
  }

  /**
   * Get the connection ID (for message handler).
   */
  getConnectionId(): string | null {
    return this.connectionId;
  }

  // ===========================================================================
  // PRIVATE
  // ===========================================================================

  /**
   * Check if a message ID has been seen recently. Adds it if new.
   * Lazy-prunes expired entries to stay under DEDUP_MAX_SIZE.
   */
  private isMessageSeen(msgId: string): boolean {
    const now = Date.now();

    // Lazy prune when map gets too large
    if (this.seenMessages.size >= DEDUP_MAX_SIZE) {
      for (const [id, ts] of this.seenMessages) {
        if (now - ts > DEDUP_TTL_MS) this.seenMessages.delete(id);
      }
    }

    if (this.seenMessages.has(msgId)) return true;
    this.seenMessages.set(msgId, now);
    return false;
  }

  /**
   * Chain a send operation onto the sequential queue with a delay between sends.
   */
  private throttledSend<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.sendQueue.then(async () => {
      const value = await fn();
      await delay(SEND_DELAY_MS);
      return value;
    });
    // Update queue to track completion (ignore errors for queue chaining)
    this.sendQueue = result.then(() => {}, () => {});
    return result;
  }

  private installConsoleFilters() {
    if (this.originalConsoleInfo) return; // already installed
    const SUPPRESSED = ['Closing session', 'Session already closed'];
    this.originalConsoleInfo = console.info; // eslint-disable-line no-console
    this.originalConsoleWarn = console.warn; // eslint-disable-line no-console
    console.info = (...args: unknown[]) => { // eslint-disable-line no-console
      const first = args[0];
      if (typeof first === 'string' && SUPPRESSED.some(s => first.includes(s))) return;
      this.originalConsoleInfo!.apply(console, args);
    };
    console.warn = (...args: unknown[]) => { // eslint-disable-line no-console
      const first = args[0];
      if (typeof first === 'string' && SUPPRESSED.some(s => first.includes(s))) return;
      this.originalConsoleWarn!.apply(console, args);
    };
  }

  private removeConsoleFilters() {
    if (this.originalConsoleInfo) {
      console.info = this.originalConsoleInfo; // eslint-disable-line no-console
      this.originalConsoleInfo = null;
    }
    if (this.originalConsoleWarn) {
      console.warn = this.originalConsoleWarn; // eslint-disable-line no-console
      this.originalConsoleWarn = null;
    }
  }

  private handleMessage(msg: WAMessage) {
    if (!this.connectionId) return;

    // Ignore status messages, protocol messages, and self-sent messages
    if (msg.key.fromMe) return;
    if (!msg.message) return;

    // Dedup: Baileys can fire duplicate notify events on flaky connections
    if (!msg.key.id || this.isMessageSeen(msg.key.id)) return;

    const chatId = msg.key.remoteJid;
    if (!chatId) return;

    // Extract text content (captions count as text)
    let text = msg.message.conversation
      || msg.message.extendedTextMessage?.text
      || msg.message.imageMessage?.caption
      || msg.message.videoMessage?.caption
      || null;

    // Acknowledge media messages that have no caption/text
    if (!text) {
      if (msg.message.imageMessage) text = '[Sent an image]';
      else if (msg.message.videoMessage) text = '[Sent a video]';
      else if (msg.message.audioMessage) text = '[Sent a voice message]';
      else if (msg.message.documentMessage) text = `[Sent a file: ${msg.message.documentMessage.fileName || 'document'}]`;
      else if (msg.message.stickerMessage) text = '[Sent a sticker]';
      else return;
    }

    const sender = msg.pushName || msg.key.participant || chatId;

    // Check allowlist — emit blocked event for non-allowed chats
    if (!this.isAllowedChat(chatId)) {
      this.eventBus.emit('whatsapp:blocked-message', { chatId, sender });
      return;
    }

    this.eventBus.emit('whatsapp:message', { chatId, from: sender, text });

    // Delegate to message handler
    if (this.onMessage) {
      this.onMessage(this.connectionId, chatId, sender, text);
    }
  }

  private getOrCreateConnection(): string {
    // If this client is bound to a specific connection, use it directly
    if (this.targetConnectionId) {
      const exists = this.rawDb.prepare(
        'SELECT id FROM whatsapp_connections WHERE id = ?',
      ).get(this.targetConnectionId) as { id: string } | undefined;
      if (exists) return exists.id;
      // Row was deleted externally; fall through to create
    }

    // Check for existing connection (backward compat: single-instance mode)
    const existing = this.rawDb.prepare(
      'SELECT id FROM whatsapp_connections WHERE workspace_id = ? LIMIT 1',
    ).get(this.workspaceId) as { id: string } | undefined;

    if (existing) return existing.id;

    // Create new connection
    const id = crypto.randomUUID().replace(/-/g, '');
    this.rawDb.prepare(`
      INSERT INTO whatsapp_connections (id, workspace_id, status)
      VALUES (?, ?, 'disconnected')
    `).run(id, this.workspaceId);

    return id;
  }

  private updateStatus(status: WhatsAppConnectionStatus, phoneNumber?: string | null) {
    if (!this.connectionId) return;
    if (phoneNumber !== undefined) {
      this.rawDb.prepare(
        'UPDATE whatsapp_connections SET status = ?, phone_number = ?, updated_at = datetime(\'now\') WHERE id = ?',
      ).run(status, phoneNumber, this.connectionId);
    } else {
      this.rawDb.prepare(
        'UPDATE whatsapp_connections SET status = ?, updated_at = datetime(\'now\') WHERE id = ?',
      ).run(status, this.connectionId);
    }
  }

  private clearAuthState() {
    if (!this.connectionId) return;
    this.rawDb.prepare(
      'UPDATE whatsapp_connections SET auth_state = NULL, status = \'disconnected\', updated_at = datetime(\'now\') WHERE id = ?',
    ).run(this.connectionId);
  }

  /**
   * Clear Signal Protocol session data to recover from Bad MAC errors.
   * Keeps creds intact (stays logged in) but forces session re-negotiation.
   */
  private clearSignalSessions() {
    if (!this.connectionId) return;
    try {
      const row = this.rawDb.prepare(
        'SELECT auth_state FROM whatsapp_connections WHERE id = ?',
      ).get(this.connectionId) as { auth_state: string | null } | undefined;

      if (!row?.auth_state) return;

      const state = JSON.parse(row.auth_state, BufferJSON.reviver);
      if (state.keys) {
        delete state.keys['session'];
        delete state.keys['sender-key'];
      }

      const json = JSON.stringify(state, BufferJSON.replacer);
      this.rawDb.prepare(
        'UPDATE whatsapp_connections SET auth_state = ?, updated_at = datetime(\'now\') WHERE id = ?',
      ).run(json, this.connectionId);
    } catch {
      // If clearing fails, full auth reset is the fallback
      this.clearAuthState();
    }
  }
}

/**
 * Split a long message into chunks on paragraph boundaries.
 * Each chunk is at most `maxLen` characters.
 */
function chunkMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split('\n\n');
  let current = '';

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;

    if (candidate.length > maxLen) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      // If a single paragraph exceeds maxLen, hard-split on newlines then chars
      if (para.length > maxLen) {
        const lines = para.split('\n');
        for (const line of lines) {
          if ((current ? current.length + 1 + line.length : line.length) > maxLen) {
            if (current) chunks.push(current);
            current = line.length > maxLen ? line.slice(0, maxLen) : line;
            if (line.length > maxLen) {
              chunks.push(current);
              current = line.slice(maxLen);
            }
          } else {
            current = current ? `${current}\n${line}` : line;
          }
        }
      } else {
        current = para;
      }
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
