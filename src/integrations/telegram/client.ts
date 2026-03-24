/**
 * Telegram Client
 * Implements MessagingChannel using Bot API long-polling (no public URL needed).
 * Bot token is stored in the local SQLite database.
 * Supports multi-bot: use TelegramClient.forConnection() for specific connection rows.
 */

import type Database from 'better-sqlite3';
import type { TypedEventBus } from '../../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../../tui/types.js';
import type { MessagingChannel, ChannelType, ConnectionIdentity } from '../channel-types.js';
import { logger } from '../../lib/logger.js';

const TELEGRAM_API = 'https://api.telegram.org';
const POLL_TIMEOUT = 30; // seconds for long-poll

export class TelegramClient implements MessagingChannel {
  readonly type: ChannelType = 'telegram';

  private rawDb: Database.Database;
  private workspaceId: string;
  private eventBus: TypedEventBus<RuntimeEvents>;
  private botToken: string | null = null;
  private botUsername: string | null = null;
  private connected = false;
  private polling = false;
  private lastUpdateId = 0;
  private abortController: AbortController | null = null;
  private connectionId: string | null = null;
  private _identity: ConnectionIdentity | undefined;
  private onMessage: ((connectionId: string | null, chatId: string, sender: string, text: string) => void) | null = null;

  constructor(rawDb: Database.Database, workspaceId: string, eventBus: TypedEventBus<RuntimeEvents>) {
    this.rawDb = rawDb;
    this.workspaceId = workspaceId;
    this.eventBus = eventBus;
  }

  /**
   * Factory: create a client bound to a specific connection row.
   * Used in multi-bot mode where each DB row gets its own client.
   */
  static forConnection(
    rawDb: Database.Database,
    workspaceId: string,
    eventBus: TypedEventBus<RuntimeEvents>,
    connectionId: string,
    opts?: { label?: string; isDefault?: boolean },
  ): TelegramClient {
    const client = new TelegramClient(rawDb, workspaceId, eventBus);
    client.connectionId = connectionId;
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

  getConnectionId(): string | null {
    return this.connectionId;
  }

  // ===========================================================================
  // MessagingChannel interface
  // ===========================================================================

  async sendResponse(chatId: string, text: string): Promise<boolean> {
    if (!this.botToken) return false;
    return sendTelegramMessage(this.botToken, chatId, text);
  }

  getStatus(): { connected: boolean; details?: Record<string, unknown> } {
    return {
      connected: this.connected,
      details: {
        botUsername: this.botUsername,
        polling: this.polling,
        connectionId: this.connectionId,
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
  // Telegram-specific public API
  // ===========================================================================

  setMessageHandler(handler: (connectionId: string | null, chatId: string, sender: string, text: string) => void) {
    this.onMessage = handler;
  }

  /**
   * Connect to Telegram using stored bot token (or configure a new one).
   */
  async connect(): Promise<void> {
    // Load bot token from DB — by connectionId if bound, else by workspace
    const row = this.connectionId
      ? this.rawDb.prepare(
          'SELECT id, bot_token, bot_username FROM telegram_connections WHERE id = ?',
        ).get(this.connectionId) as { id: string; bot_token: string; bot_username: string | null } | undefined
      : this.rawDb.prepare(
          'SELECT id, bot_token, bot_username FROM telegram_connections WHERE workspace_id = ?',
        ).get(this.workspaceId) as { id: string; bot_token: string; bot_username: string | null } | undefined;

    if (!row) {
      throw new Error('No Telegram bot configured. Use configureBotToken() first.');
    }

    this.connectionId = row.id;
    this.botToken = row.bot_token;
    this.botUsername = row.bot_username;

    // Ensure identity is set (for single-instance mode where forConnection wasn't used)
    if (!this._identity) {
      const meta = this.rawDb.prepare(
        'SELECT label, is_default FROM telegram_connections WHERE id = ?',
      ).get(this.connectionId) as { label: string | null; is_default: number } | undefined;
      this._identity = {
        connectionId: this.connectionId,
        label: meta?.label ?? undefined,
        isDefault: meta?.is_default === 1,
      };
    }

    // Validate token
    const validation = await validateBotToken(this.botToken);
    if (!validation.valid) {
      throw new Error(`Invalid bot token: ${validation.error}`);
    }

    this.botUsername = validation.bot.username;
    this.connected = true;

    // Update status in DB
    this.rawDb.prepare(
      'UPDATE telegram_connections SET status = ?, bot_username = ?, bot_id = ?, updated_at = datetime(\'now\') WHERE id = ?',
    ).run('connected', validation.bot.username, String(validation.bot.id), this.connectionId);

    // Delete any existing webhook (we use long-polling instead)
    await deleteWebhook(this.botToken);

    this.eventBus.emit('telegram:connected', { botUsername: this.botUsername, connectionId: this.connectionId });

    // Start long-polling
    this.startPolling();
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    this.connected = false;

    if (this.connectionId) {
      this.rawDb.prepare(
        'UPDATE telegram_connections SET status = ?, updated_at = datetime(\'now\') WHERE id = ?',
      ).run('disconnected', this.connectionId);
    }

    this.eventBus.emit('telegram:disconnected', { connectionId: this.connectionId });
  }

  /**
   * Configure a new bot token (setup flow).
   */
  async configureBotToken(token: string): Promise<{ botUsername: string; connectionId: string }> {
    const validation = await validateBotToken(token);
    if (!validation.valid) {
      throw new Error(`Invalid bot token: ${validation.error}`);
    }

    if (this.connectionId) {
      // Update existing connection
      this.rawDb.prepare(
        'UPDATE telegram_connections SET bot_token = ?, bot_username = ?, bot_id = ?, status = ?, updated_at = datetime(\'now\') WHERE id = ?',
      ).run(token, validation.bot.username, String(validation.bot.id), 'disconnected', this.connectionId);
      return { botUsername: validation.bot.username, connectionId: this.connectionId };
    }

    // Upsert connection row (legacy single-instance path)
    const existing = this.rawDb.prepare(
      'SELECT id FROM telegram_connections WHERE workspace_id = ?',
    ).get(this.workspaceId) as { id: string } | undefined;

    if (existing) {
      this.connectionId = existing.id;
      this.rawDb.prepare(
        'UPDATE telegram_connections SET bot_token = ?, bot_username = ?, bot_id = ?, status = ?, updated_at = datetime(\'now\') WHERE id = ?',
      ).run(token, validation.bot.username, String(validation.bot.id), 'disconnected', existing.id);
    } else {
      const id = crypto.randomUUID().replace(/-/g, '');
      this.connectionId = id;
      this.rawDb.prepare(`
        INSERT INTO telegram_connections (id, workspace_id, bot_token, bot_username, bot_id, status)
        VALUES (?, ?, ?, ?, ?, 'disconnected')
      `).run(id, this.workspaceId, token, validation.bot.username, String(validation.bot.id));
    }

    return { botUsername: validation.bot.username, connectionId: this.connectionId };
  }

  /**
   * Get Telegram-specific status for the management screen.
   */
  getTelegramStatus(): { status: string; botUsername: string | null; connectionId: string | null } {
    const row = this.connectionId
      ? this.rawDb.prepare(
          'SELECT status, bot_username FROM telegram_connections WHERE id = ?',
        ).get(this.connectionId) as { status: string; bot_username: string | null } | undefined
      : this.rawDb.prepare(
          'SELECT status, bot_username FROM telegram_connections WHERE workspace_id = ?',
        ).get(this.workspaceId) as { status: string; bot_username: string | null } | undefined;

    return {
      status: row?.status || 'not_configured',
      botUsername: row?.bot_username || null,
      connectionId: this.connectionId,
    };
  }

  /**
   * Check if a bot token is configured.
   */
  isConfigured(): boolean {
    const row = this.connectionId
      ? this.rawDb.prepare('SELECT 1 FROM telegram_connections WHERE id = ?').get(this.connectionId)
      : this.rawDb.prepare('SELECT 1 FROM telegram_connections WHERE workspace_id = ?').get(this.workspaceId);
    return !!row;
  }

  // ===========================================================================
  // PRIVATE — Long-polling
  // ===========================================================================

  private startPolling() {
    if (this.polling) return;
    this.polling = true;
    this.pollLoop();
  }

  private stopPolling() {
    this.polling = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  private async pollLoop() {
    while (this.polling && this.botToken) {
      try {
        this.abortController = new AbortController();
        const updates = await getUpdates(
          this.botToken,
          this.lastUpdateId + 1,
          POLL_TIMEOUT,
          this.abortController.signal,
        );

        for (const update of updates) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          this.handleUpdate(update);
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          break;
        }
        logger.error({ err }, '[Telegram] Poll error');
        // Wait before retrying
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private handleUpdate(update: TelegramUpdate) {
    const msg = update.message;
    if (!msg?.text) return;

    const chatId = String(msg.chat.id);
    const sender = msg.from?.first_name || msg.from?.username || chatId;

    this.eventBus.emit('telegram:message', { chatId, from: sender, text: msg.text, connectionId: this.connectionId });

    if (this.onMessage) {
      this.onMessage(this.connectionId, chatId, sender, msg.text);
    }
  }
}

// =============================================================================
// Telegram Bot API helpers (reuses patterns from src/lib/telegram/api.ts)
// =============================================================================

interface TelegramBotInfo {
  id: number;
  username: string;
  first_name: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; username?: string };
    chat: { id: number; type: string };
    text?: string;
  };
}

interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  result?: unknown;
}

async function validateBotToken(
  token: string,
): Promise<{ valid: true; bot: TelegramBotInfo } | { valid: false; error: string }> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/getMe`);
    const data = (await res.json()) as TelegramApiResponse;
    if (!data.ok) {
      return { valid: false, error: data.description || 'Invalid bot token' };
    }
    return { valid: true, bot: data.result as TelegramBotInfo };
  } catch {
    return { valid: false, error: "Couldn't connect to Telegram" };
  }
}

async function deleteWebhook(token: string): Promise<void> {
  try {
    await fetch(`${TELEGRAM_API}/bot${token}/deleteWebhook`, { method: 'POST' });
  } catch {
    // Best-effort
  }
}

async function getUpdates(
  token: string,
  offset: number,
  timeout: number,
  signal: AbortSignal,
): Promise<TelegramUpdate[]> {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/getUpdates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offset,
      timeout,
      allowed_updates: ['message'],
    }),
    signal,
  });

  const data = (await res.json()) as TelegramApiResponse;
  if (!data.ok) {
    throw new Error(`getUpdates failed: ${data.description}`);
  }
  return data.result as TelegramUpdate[];
}

async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
): Promise<boolean> {
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    try {
      const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
        }),
      });
      if (!res.ok) {
        logger.error({ status: res.status }, '[Telegram] sendMessage failed');
        return false;
      }
    } catch (err) {
      logger.error({ err }, '[Telegram] sendMessage error');
      return false;
    }
  }
  return true;
}

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < maxLength * 0.5) {
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt < maxLength * 0.5) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
