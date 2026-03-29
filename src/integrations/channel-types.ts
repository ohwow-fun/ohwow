/**
 * Channel Abstraction Types
 * Core interfaces for multi-channel messaging (WhatsApp, Telegram, etc.)
 */

export type ChannelType = 'tui' | 'whatsapp' | 'telegram' | 'voice';

export interface ChannelAddress {
  channel: ChannelType;
  chatId: string;
  connectionId?: string;
}

/**
 * Identity for a specific channel connection instance.
 * Allows multiple connections of the same type (e.g. two WhatsApp numbers).
 */
export interface ConnectionIdentity {
  /** Unique ID for this connection (e.g. DB row ID) */
  connectionId: string;
  /** Human-readable label (e.g. "Sales", "Support") */
  label?: string;
  /** Whether this is the default connection for its type */
  isDefault?: boolean;
}

export interface MessagingChannel {
  readonly type: ChannelType;
  /** Connection identity for multi-instance support. Undefined for singleton channels (TUI, voice). */
  readonly identity?: ConnectionIdentity;
  sendResponse(chatId: string, text: string): Promise<boolean>;
  getStatus(): { connected: boolean; details?: Record<string, unknown> };
  excludedTools(): string[];
  transformToolInput?(toolName: string, input: Record<string, unknown>): Record<string, unknown>;
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
  getAllowedChats?(): Array<{ chat_id: string }>;
  getDefaultChatId?(): string | null;
}
