/**
 * WhatsApp Orchestrator Tools
 * Allows the orchestrator to send messages and list allowed chats.
 * Supports multi-connection: tools accept optional connection_id or from_number.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { readFile } from 'fs/promises';
import { extname } from 'path';

export const WHATSAPP_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'connect_whatsapp',
    description:
      'Link WhatsApp by scanning a QR code. Only needed when WhatsApp is not connected yet.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'disconnect_whatsapp',
    description:
      'Disconnect from WhatsApp. Closes the active session.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_whatsapp_status',
    description:
      'Check the current WhatsApp connection status, phone number, and allowed chat count without listing all chats.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'update_whatsapp_chat',
    description:
      'Update the display name of an allowed WhatsApp chat. Accepts a contact name, phone digits, or full JID to identify the chat.',
    input_schema: {
      type: 'object' as const,
      properties: {
        chat_id: { type: 'string', description: 'The chat to update: a contact name, phone digits, or full JID' },
        name: { type: 'string', description: 'The new display name for the chat' },
      },
      required: ['chat_id', 'name'],
    },
  },
  {
    name: 'send_whatsapp_message',
    description:
      'Send a WhatsApp message. Accepts a contact name (e.g. "Mom"), phone digits (e.g. "5551234567"), or full JID. Automatically adds the number to contacts if needed. For media, provide a file path. For multi-number workspaces, optionally specify which connection to send from.',
    input_schema: {
      type: 'object' as const,
      properties: {
        chat_id: { type: 'string', description: 'The recipient: a contact name (e.g. "Mom"), phone digits (e.g. "5551234567"), or full JID' },
        message: { type: 'string', description: 'The message text to send (required for text messages, optional caption for media)' },
        media_path: { type: 'string', description: 'Absolute path to a file to send (image, document, audio, or video). When provided, message becomes the caption.' },
        connection_id: { type: 'string', description: 'Optional: send from a specific WhatsApp connection (use list_whatsapp_connections to see IDs)' },
        from_number: { type: 'string', description: 'Optional: send from the connection matching this phone number' },
      },
      required: ['chat_id'],
    },
  },
  {
    name: 'list_whatsapp_chats',
    description:
      'List allowed WhatsApp chats and the current connection status.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_whatsapp_connections',
    description:
      'List all WhatsApp connections in the workspace, showing phone number, label, status, and chat count per connection. Useful when the workspace has multiple WhatsApp numbers.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'add_whatsapp_chat',
    description:
      'Add a phone number to the WhatsApp allowed chats list. After adding, messages can be sent to this chat.',
    input_schema: {
      type: 'object' as const,
      properties: {
        phone_number: { type: 'string', description: 'Phone number to add (digits only or full JID like 1234567890@s.whatsapp.net)' },
        name: { type: 'string', description: 'Optional display name for the chat' },
        type: { type: 'string', enum: ['individual', 'group'], description: 'Chat type (default: individual)' },
      },
      required: ['phone_number'],
    },
  },
  {
    name: 'remove_whatsapp_chat',
    description:
      'Remove a chat from the WhatsApp allowed list. Accepts a contact name, phone digits, or full JID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        chat_id: { type: 'string', description: 'The chat to remove: a contact name (e.g. "Mom"), phone digits, or full JID' },
      },
      required: ['chat_id'],
    },
  },
  {
    name: 'get_whatsapp_messages',
    description:
      'Retrieve WhatsApp message history. Filter by contact, date range, keyword search, or any combination.',
    input_schema: {
      type: 'object' as const,
      properties: {
        chat_id: { type: 'string', description: 'Contact name, phone digits, or JID. Omit for all chats.' },
        since: { type: 'string', description: 'Start date/time ISO format (e.g. "2026-03-06")' },
        until: { type: 'string', description: 'End date/time ISO format. Defaults to now.' },
        limit: { type: 'number', description: 'Max messages (default 100, max 500)' },
        include_replies: { type: 'boolean', description: 'Include assistant replies (default false)' },
        search: { type: 'string', description: 'Search keyword to filter messages by content (case-insensitive)' },
      },
      required: [],
    },
  },
];
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import type { WhatsAppClient } from '../../whatsapp/client.js';

/**
 * Resolve a WhatsApp client from context.
 * Supports multi-connection: if connection_id or from_number is provided,
 * finds the matching client. Otherwise returns the default.
 */
function resolveWhatsAppClient(
  ctx: LocalToolContext,
  opts?: { connection_id?: string; from_number?: string },
): WhatsAppClient | undefined {
  // Exact connectionId lookup
  if (opts?.connection_id) {
    return ctx.channels.getByConnectionId(opts.connection_id) as WhatsAppClient | undefined;
  }

  // Phone number lookup: scan all WhatsApp instances
  if (opts?.from_number) {
    const normalized = opts.from_number.replace(/\D/g, '');
    const all = ctx.channels.getAllOfType('whatsapp') as WhatsAppClient[];
    for (const client of all) {
      const status = client.getWaStatus();
      if (status.phoneNumber && status.phoneNumber.replace(/\D/g, '') === normalized) {
        return client;
      }
    }
    return undefined;
  }

  // Default: first/default instance
  return ctx.channels.get('whatsapp') as WhatsAppClient | undefined;
}

const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi']);
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.wav', '.m4a']);

/** WhatsApp media size limits in bytes */
const MEDIA_SIZE_LIMITS: Record<string, number> = {
  image: 16 * 1024 * 1024,    // 16 MB
  video: 64 * 1024 * 1024,    // 64 MB
  audio: 16 * 1024 * 1024,    // 16 MB
  document: 100 * 1024 * 1024, // 100 MB
};

function formatMB(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

function detectMediaType(filePath: string): 'image' | 'video' | 'audio' | 'document' {
  const ext = extname(filePath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'document';
}

/**
 * Connect to WhatsApp (or show status if already connected).
 * Switches to the WhatsApp screen where the QR code is rendered.
 */
export async function connectWhatsApp(
  ctx: LocalToolContext,
): Promise<ToolResult> {
  const channel = ctx.channels.get('whatsapp') as WhatsAppClient | undefined;

  if (!channel) {
    return { success: false, error: 'WhatsApp client is not available. Make sure the WhatsApp integration is enabled in settings.' };
  }

  const status = channel.getStatus();
  if (status.connected) {
    return {
      success: true,
      switchTab: 'whatsapp',
      data: { status: 'already_connected', message: 'WhatsApp is already connected.' },
    };
  }

  // Fire-and-forget: initiate connection (QR will render on the WhatsApp screen)
  channel.connect().catch(() => {
    // Connection errors are handled by the WhatsApp screen UI
  });

  return {
    success: true,
    switchTab: 'whatsapp',
    data: { status: 'connecting', message: 'Opening WhatsApp screen. Scan the QR code with your phone (WhatsApp > Settings > Linked Devices > Link a Device).' },
  };
}

/**
 * Disconnect from WhatsApp.
 */
export async function disconnectWhatsApp(
  ctx: LocalToolContext,
): Promise<ToolResult> {
  const channel = ctx.channels.get('whatsapp') as WhatsAppClient | undefined;

  if (!channel) {
    return { success: false, error: 'WhatsApp client is not available.' };
  }

  const status = channel.getStatus();
  if (!status.connected) {
    return { success: true, switchTab: 'whatsapp', data: { status: 'already_disconnected', message: 'WhatsApp is already disconnected.' } };
  }

  await channel.disconnect();
  return { success: true, switchTab: 'whatsapp', data: { status: 'disconnected', message: 'WhatsApp has been disconnected.' } };
}

/**
 * Get WhatsApp connection status and metadata.
 */
export async function getWhatsAppStatus(
  ctx: LocalToolContext,
): Promise<ToolResult> {
  const channel = ctx.channels.get('whatsapp') as WhatsAppClient | undefined;

  if (!channel) {
    return { success: false, error: 'WhatsApp client is not available. Make sure the WhatsApp integration is enabled in settings.' };
  }

  const waStatus = channel.getWaStatus();
  const chats = channel.getAllowedChats();

  return {
    success: true,
    data: {
      status: waStatus.status,
      phoneNumber: waStatus.phoneNumber,
      allowedChatCount: chats.length,
    },
  };
}

/**
 * Update the display name of an allowed WhatsApp chat.
 */
export async function updateWhatsAppChat(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const { chat_id, name } = input as { chat_id: string; name: string };

  if (!chat_id || !name) {
    return { success: false, error: 'Need both a chat and a new name.' };
  }

  const channel = ctx.channels.get('whatsapp') as WhatsAppClient | undefined;

  if (!channel) {
    return { success: false, error: 'WhatsApp isn\'t connected yet. Use `connect_whatsapp` to set it up.' };
  }

  // Normalize: digits → JID, contains @ → JID, otherwise → name search
  let chatId = chat_id.trim();
  if (/^\d+$/.test(chatId)) {
    chatId = `${chatId}@s.whatsapp.net`;
  } else if (!chatId.includes('@')) {
    const matches = channel.findChatsByName(chatId);
    if (matches.length === 0) {
      return { success: false, error: `No allowed chat matches "${chatId}". Use \`list_whatsapp_chats\` to see your contacts.` };
    }
    if (matches.length > 1) {
      return {
        success: false,
        error: `Multiple chats match "${chatId}": ${matches.map((m) => `${m.chat_name} (${m.chat_id})`).join(', ')}. Specify which one.`,
        data: { matches: matches.map((m) => ({ chatId: m.chat_id, name: m.chat_name })) },
      };
    }
    chatId = matches[0].chat_id;
  }

  if (!channel.isAllowedChat(chatId)) {
    return { success: false, error: `${chatId} isn't in your allowed chats.` };
  }

  const updated = channel.updateChatName(chatId, name.trim());
  if (!updated) {
    return { success: false, error: 'Couldn\'t update the chat name. Try again?' };
  }

  return { success: true, data: { chatId, newName: name.trim() } };
}

/**
 * Send a WhatsApp message to an allowed chat.
 */
export async function sendWhatsAppMessage(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const { chat_id, message, media_path, connection_id, from_number } = input as {
    chat_id: string; message?: string; media_path?: string;
    connection_id?: string; from_number?: string;
  };

  if (!chat_id) {
    return { success: false, error: 'Which chat should this go to?' };
  }
  if (!message && !media_path) {
    return { success: false, error: 'Need either a message or a media file to send.' };
  }

  const channel = resolveWhatsAppClient(ctx, { connection_id, from_number });

  if (!channel) {
    if (connection_id || from_number) {
      return { success: false, error: `No WhatsApp connection matches ${connection_id ? `connection "${connection_id}"` : `number "${from_number}"`}. Use \`list_whatsapp_connections\` to see available connections.` };
    }
    return { success: false, error: 'WhatsApp isn\'t connected yet. Use `connect_whatsapp` to set it up.' };
  }

  const status = channel.getStatus();
  if (!status.connected) {
    return { success: false, error: 'WhatsApp is disconnected. Use `connect_whatsapp` to reconnect.' };
  }

  // Normalize: digits → JID, contains @ → JID, otherwise → name search
  let normalizedChatId = chat_id.trim();
  if (/^\d+$/.test(normalizedChatId)) {
    normalizedChatId = `${normalizedChatId}@s.whatsapp.net`;
  } else if (!normalizedChatId.includes('@')) {
    // Treat as a contact name search
    const matches = channel.findChatsByName(normalizedChatId);
    if (matches.length === 0) {
      return {
        success: false,
        error: `No allowed chat matches "${normalizedChatId}". Use \`list_whatsapp_chats\` to see your contacts, or \`add_whatsapp_chat\` to add a new one.`,
      };
    }
    if (matches.length > 1) {
      return {
        success: false,
        error: `Multiple chats match "${normalizedChatId}": ${matches.map((m) => `${m.chat_name} (${m.chat_id})`).join(', ')}. Specify which one.`,
        data: { matches: matches.map((m) => ({ chatId: m.chat_id, name: m.chat_name })) },
      };
    }
    normalizedChatId = matches[0].chat_id;
  }

  // Auto-add to allowed list if not already there (saves small models from multi-step chains)
  let autoAdded = false;
  if (!channel.isAllowedChat(normalizedChatId)) {
    const chatType = normalizedChatId.includes('@g.us') ? 'group' : 'individual';
    channel.addAllowedChat(normalizedChatId, null, chatType);
    autoAdded = true;
  }

  // Media sending path
  if (media_path) {
    let buffer: Buffer;
    try {
      buffer = await readFile(media_path);
    } catch {
      return { success: false, error: `Couldn't read file at "${media_path}". Check the path exists.` };
    }

    const mediaType = detectMediaType(media_path);
    const maxSize = MEDIA_SIZE_LIMITS[mediaType];
    if (maxSize && buffer.length > maxSize) {
      return {
        success: false,
        error: `File is too large (${formatMB(buffer.length)}). WhatsApp allows up to ${formatMB(maxSize)} for ${mediaType}s.`,
      };
    }

    const ext = extname(media_path).toLowerCase();
    const mimetype = MIME_MAP[ext];
    const fileName = media_path.split('/').pop() || 'file';

    const sent = await channel.sendMedia(normalizedChatId, mediaType, buffer, {
      caption: message,
      mimetype,
      fileName,
    });
    if (!sent) {
      return { success: false, error: 'Couldn\'t send that media. Try again?' };
    }
    return { success: true, data: { sent: true, chat_id: normalizedChatId, mediaType, autoAdded } };
  }

  // Text-only path
  const sent = await channel.sendMessage(normalizedChatId, message!);
  if (!sent) {
    return { success: false, error: 'Couldn\'t send that message. Try again?' };
  }

  return { success: true, data: { sent: true, chat_id: normalizedChatId, autoAdded } };
}

/**
 * Add a phone number to the WhatsApp allowed chats list.
 */
export async function addWhatsAppChat(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const { phone_number, name, type } = input as {
    phone_number: string;
    name?: string;
    type?: 'individual' | 'group';
  };

  if (!phone_number) {
    return { success: false, error: 'Which phone number should be added?' };
  }

  const channel = ctx.channels.get('whatsapp') as WhatsAppClient | undefined;

  if (!channel) {
    return { success: false, error: 'WhatsApp isn\'t connected yet. Use `connect_whatsapp` to set it up.' };
  }

  // Normalize: if just digits, add @s.whatsapp.net
  let chatId = phone_number.trim();
  if (/^\d+$/.test(chatId)) {
    chatId = `${chatId}@s.whatsapp.net`;
  }

  // Auto-detect group chats by JID suffix
  let chatType = type ?? 'individual';
  if (chatId.includes('@g.us')) {
    chatType = 'group';
  }

  if (channel.isAllowedChat(chatId)) {
    return {
      success: true,
      data: { added: chatId, name: name ?? null, alreadyExisted: true },
    };
  }

  channel.addAllowedChat(chatId, name ?? null, chatType);

  const chats = channel.getAllowedChats();
  return {
    success: true,
    data: {
      added: chatId,
      name: name ?? null,
      totalChats: chats.length,
    },
  };
}

/**
 * Remove a chat from the WhatsApp allowed list.
 */
export async function removeWhatsAppChat(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const { chat_id } = input as { chat_id: string };

  if (!chat_id) {
    return { success: false, error: 'Which chat should be removed? Use list_whatsapp_chats to see your allowed chats.' };
  }

  const channel = ctx.channels.get('whatsapp') as WhatsAppClient | undefined;

  if (!channel) {
    return { success: false, error: 'WhatsApp isn\'t connected yet. Use `connect_whatsapp` to set it up.' };
  }

  // Normalize: digits → JID, contains @ → JID, otherwise → name search
  let chatId = chat_id.trim();
  if (/^\d+$/.test(chatId)) {
    chatId = `${chatId}@s.whatsapp.net`;
  } else if (!chatId.includes('@')) {
    const matches = channel.findChatsByName(chatId);
    if (matches.length === 0) {
      return {
        success: false,
        error: `No allowed chat matches "${chatId}". Use \`list_whatsapp_chats\` to see your contacts.`,
      };
    }
    if (matches.length > 1) {
      return {
        success: false,
        error: `Multiple chats match "${chatId}": ${matches.map((m) => `${m.chat_name} (${m.chat_id})`).join(', ')}. Specify which one.`,
        data: { matches: matches.map((m) => ({ chatId: m.chat_id, name: m.chat_name })) },
      };
    }
    chatId = matches[0].chat_id;
  }

  if (!channel.isAllowedChat(chatId)) {
    return { success: false, error: `${chatId} isn't in your allowed chats.` };
  }

  channel.removeAllowedChat(chatId);

  const chats = channel.getAllowedChats();
  return {
    success: true,
    data: {
      removed: chatId,
      remainingChats: chats.length,
    },
  };
}

/**
 * Retrieve WhatsApp message history with optional filters.
 */
export async function getWhatsAppMessages(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const { chat_id, since, until, limit, include_replies, search } = input as {
    chat_id?: string;
    since?: string;
    until?: string;
    limit?: number;
    include_replies?: boolean;
    search?: string;
  };

  const channel = ctx.channels.get('whatsapp') as WhatsAppClient | undefined;

  if (!channel) {
    return { success: false, error: 'WhatsApp isn\'t connected yet. Use `connect_whatsapp` to set it up.' };
  }

  // Resolve chat_id by name if needed
  let resolvedChatId: string | undefined;
  if (chat_id) {
    let normalized = chat_id.trim();
    if (/^\d+$/.test(normalized)) {
      normalized = `${normalized}@s.whatsapp.net`;
    } else if (!normalized.includes('@')) {
      const matches = channel.findChatsByName(normalized);
      if (matches.length === 0) {
        return {
          success: false,
          error: `No allowed chat matches "${normalized}". Use \`list_whatsapp_chats\` to see your contacts.`,
        };
      }
      if (matches.length > 1) {
        return {
          success: false,
          error: `Multiple chats match "${normalized}": ${matches.map((m) => `${m.chat_name} (${m.chat_id})`).join(', ')}. Specify which one.`,
          data: { matches: matches.map((m) => ({ chatId: m.chat_id, name: m.chat_name })) },
        };
      }
      normalized = matches[0].chat_id;
    }
    resolvedChatId = normalized;
  }

  const requestedLimit = limit ?? 100;
  const messages = channel.getChatMessages({
    chatId: resolvedChatId,
    since,
    until,
    limit: requestedLimit,
    includeReplies: include_replies,
    search,
  });

  if (messages.length === 0) {
    return {
      success: true,
      data: {
        messages: [],
        note: 'No messages found for that period. Messages are only stored after WhatsApp is connected.',
      },
    };
  }

  // Enrich with chat names
  const allowedChats = channel.getAllowedChats();
  const chatNameMap = new Map(allowedChats.map((c) => [c.chat_id, c.chat_name]));

  const enriched = messages.map((m) => ({
    chat: chatNameMap.get(m.chat_id) || m.chat_id,
    sender: m.sender || m.chat_id,
    role: m.role,
    content: m.content,
    time: m.created_at,
  }));

  const truncated = messages.length >= Math.min(requestedLimit, 500);

  return {
    success: true,
    data: {
      messages: enriched,
      count: enriched.length,
      ...(truncated ? { truncated: true, note: 'Results were truncated. Narrow your date range or filter by chat for more.' } : {}),
    },
  };
}

/**
 * List allowed WhatsApp chats.
 */
export async function listWhatsAppChats(
  ctx: LocalToolContext,
): Promise<ToolResult> {
  const channel = ctx.channels.get('whatsapp') as WhatsAppClient | undefined;

  if (!channel) {
    return { success: false, error: 'WhatsApp isn\'t connected yet. Use `connect_whatsapp` to set it up.' };
  }

  const status = channel.getWaStatus();
  const chats = channel.getAllowedChats();

  return {
    success: true,
    data: {
      status: status.status,
      phoneNumber: status.phoneNumber,
      chats: chats.map((c) => ({
        chatId: c.chat_id,
        name: c.chat_name,
        type: c.chat_type,
      })),
    },
  };
}

/**
 * List all WhatsApp connections in this workspace.
 * Shows connectionId, phone number, label, status, and chat count per connection.
 */
export async function listWhatsAppConnections(
  ctx: LocalToolContext,
): Promise<ToolResult> {
  const all = ctx.channels.getAllOfType('whatsapp') as WhatsAppClient[];

  if (all.length === 0) {
    return { success: true, data: { connections: [], note: 'No WhatsApp connections configured.' } };
  }

  const connections = all.map((client) => {
    const status = client.getWaStatus();
    const chats = client.getAllowedChats();
    return {
      connectionId: status.connectionId,
      phoneNumber: status.phoneNumber,
      label: client.identity?.label ?? null,
      isDefault: client.identity?.isDefault ?? false,
      status: status.status,
      chatCount: chats.length,
    };
  });

  return { success: true, data: { connections } };
}
