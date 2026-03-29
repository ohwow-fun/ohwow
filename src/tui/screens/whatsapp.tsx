/**
 * WhatsApp Management Screen
 * Connect/disconnect WhatsApp, manage allowed chats, view status.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { WhatsAppConnectionStatus, WhatsAppAllowedChat } from '../../whatsapp/types.js';
import { useEvent } from '../hooks/use-event-bus.js';

interface WhatsAppScreenProps {
  apiFetch: <T = unknown>(path: string, options?: RequestInit) => Promise<T>;
  onBack: () => void;
}

type Mode = 'main' | 'add-chat';

export function WhatsAppScreen({ apiFetch, onBack }: WhatsAppScreenProps) {
  const [status, setStatus] = useState<WhatsAppConnectionStatus>('disconnected');
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [allowedChats, setAllowedChats] = useState<WhatsAppAllowedChat[]>([]);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('main');
  const [chatInput, setChatInput] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [qrCountdown, setQrCountdown] = useState<number | null>(null);
  const [blockedAlert, setBlockedAlert] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await apiFetch<{ status: WhatsAppConnectionStatus; phoneNumber: string | null; allowedChats: WhatsAppAllowedChat[] }>('/api/whatsapp/status');
      setStatus(data.status);
      setPhoneNumber(data.phoneNumber);
      setAllowedChats(data.allowedChats ?? []);
    } catch {
      // ignore refresh errors silently
    }
  }, [apiFetch]);

  // Subscribe to WhatsApp events
  const qrEvent = useEvent('whatsapp:qr');
  const connectedEvent = useEvent('whatsapp:connected');
  const disconnectedEvent = useEvent('whatsapp:disconnected');
  const blockedEvent = useEvent('whatsapp:blocked-message');

  useEffect(() => {
    if (!blockedEvent) return;
    const phone = blockedEvent.chatId.replace(/@.*$/, '');
    const name = blockedEvent.sender !== blockedEvent.chatId ? blockedEvent.sender : phone;
    setBlockedAlert(`Message from ${name} (${phone}). Press [a] to add them.`); // eslint-disable-line react-hooks/set-state-in-effect -- syncing from event bus
    const timer = setTimeout(() => setBlockedAlert(null), 8000);
    return () => clearTimeout(timer);
  }, [blockedEvent]);

  useEffect(() => {
    if (!qrEvent) return;
    setQrCode(qrEvent.qr); // eslint-disable-line react-hooks/set-state-in-effect -- syncing from event bus
    setStatus('qr_pending');
    setConnecting(false);
    setQrCountdown(60);
  }, [qrEvent]);

  // QR countdown timer
  useEffect(() => {
    if (qrCountdown === null || qrCountdown <= 0) return;
    const timer = setTimeout(() => setQrCountdown((prev) => (prev !== null ? prev - 1 : null)), 1000);
    return () => clearTimeout(timer);
  }, [qrCountdown]);

  useEffect(() => {
    if (!connectedEvent) return;
    setQrCode(null); // eslint-disable-line react-hooks/set-state-in-effect -- syncing from event bus
    setStatus('connected');
    setPhoneNumber(connectedEvent.phoneNumber);
    setMessage('WhatsApp connected!');
    setConnecting(false);
    setQrCountdown(null);
    void refresh();
  }, [connectedEvent]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!disconnectedEvent) return;
    setStatus('disconnected'); // eslint-disable-line react-hooks/set-state-in-effect -- syncing from event bus
    setQrCode(null);
    setConnecting(false);
    setQrCountdown(null);
  }, [disconnectedEvent]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- loading data on mount
  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleConnect = async () => {
    if (connecting) return;
    setConnecting(true);
    setMessage(null);
    try {
      await apiFetch('/api/whatsapp/connect', { method: 'POST' });
    } catch (err) {
      setMessage(`Connection error: ${err instanceof Error ? err.message : 'Unknown'}`);
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    await apiFetch('/api/whatsapp/disconnect', { method: 'POST' });
    setMessage('Disconnected from WhatsApp');
    void refresh();
  };

  const handleAddChat = async () => {
    if (!chatInput.trim()) return;

    // Normalize: if just digits, add @s.whatsapp.net
    let chatId = chatInput.trim();
    if (/^\d+$/.test(chatId)) {
      chatId = `${chatId}@s.whatsapp.net`;
    }

    const chatType = chatId.endsWith('@g.us') ? 'group' : 'individual';
    await apiFetch('/api/whatsapp/chats', {
      method: 'POST',
      body: JSON.stringify({ chatId, chatType }),
    });
    setChatInput('');
    setMode('main');
    setMessage(`Added ${chatId} to allowlist`);
    void refresh();
  };

  const handleRemoveChat = async (chatId: string) => {
    await apiFetch('/api/whatsapp/chats', {
      method: 'DELETE',
      body: JSON.stringify({ chatId }),
    });
    setMessage(`Removed ${chatId} from allowlist`);
    void refresh();
  };

  useInput((input, key) => {
    if (mode === 'add-chat') {
      if (key.escape) {
        setMode('main');
        setChatInput('');
      }
      return;
    }

    if (key.escape) {
      onBack();
      return;
    }

    if (input === 'c' && status === 'disconnected') {
      handleConnect();
      return;
    }

    if (input === 'x' && status === 'connected') {
      void handleDisconnect();
      return;
    }

    if (input === 'a' && status === 'connected') {
      setMode('add-chat');
      return;
    }

    if (input === 'd' && allowedChats.length > 0) {
      void handleRemoveChat(allowedChats[allowedChats.length - 1].chat_id);
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>WHATSAPP</Text>
      </Box>

      {/* Connection Status */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">Connection</Text>
        <Text>
          {'  Status: '}
          <Text color={status === 'connected' ? 'green' : status === 'qr_pending' ? 'yellow' : 'red'}>
            {status === 'connected' ? '● Connected' : status === 'qr_pending' ? '○ Waiting for QR scan' : '○ Disconnected'}
          </Text>
        </Text>
        {phoneNumber && (
          <Text>{'  Phone:  '}<Text color="gray">{phoneNumber}</Text></Text>
        )}
      </Box>

      {/* QR Code */}
      {status === 'qr_pending' && qrCode && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="yellow">Scan QR Code</Text>
          <Text color="gray">  Open WhatsApp → Settings → Linked Devices → Link a Device</Text>
          <Box marginTop={1}>
            <QrDisplay qr={qrCode} />
          </Box>
          {qrCountdown !== null && qrCountdown > 0 && (
            <Text color={qrCountdown <= 10 ? 'red' : 'gray'}>  QR expires in {qrCountdown}s</Text>
          )}
          {qrCountdown !== null && qrCountdown <= 0 && (
            <Text color="red">  QR expired. Press <Text bold color="white">[c]</Text> for a new one.</Text>
          )}
        </Box>
      )}

      {connecting && !qrCode && (
        <Text color="yellow">  Connecting...</Text>
      )}

      {/* Allowed Chats */}
      {status === 'connected' && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="cyan">Allowed Chats</Text>
          {allowedChats.length === 0 ? (
            <Text color="gray">  No chats allowlisted. Press <Text bold color="white">a</Text> to add one.</Text>
          ) : (
            allowedChats.map((chat) => (
              <Text key={chat.id}>
                {'  '}
                <Text color="green">●</Text>
                {' '}{chat.chat_name || chat.chat_id}
                <Text color="gray"> [{chat.chat_type}]</Text>
              </Text>
            ))
          )}
        </Box>
      )}

      {/* Add Chat Input */}
      {mode === 'add-chat' && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="yellow">Add Allowed Chat</Text>
          <Text color="gray">  Enter phone number (e.g. 1234567890) or full JID:</Text>
          <Box>
            <Text>  {'> '}</Text>
            <TextInput
              value={chatInput}
              onChange={setChatInput}
              onSubmit={() => { void handleAddChat(); }}
              placeholder="Phone number or JID..."
            />
          </Box>
        </Box>
      )}

      {/* Messages */}
      {message && (
        <Box marginBottom={1}>
          <Text color={message.includes('error') || message.includes('Error') ? 'red' : 'green'}>
            {'  '}{message}
          </Text>
        </Box>
      )}

      {/* Blocked message alert */}
      {blockedAlert && (
        <Box marginBottom={1}>
          <Text color="yellow">{'  '}{blockedAlert}</Text>
        </Box>
      )}

      {/* Key Hints */}
      <Box marginTop={1}>
        <Text color="gray">
          {mode === 'add-chat'
            ? '[Enter] Add  [Esc] Cancel'
            : [
                status === 'disconnected' && '[c] Connect',
                status === 'connected' && '[a] Add chat',
                status === 'connected' && allowedChats.length > 0 && '[d] Remove last',
                status === 'connected' && '[x] Disconnect',
                '[Esc] Back',
              ].filter(Boolean).join('  ')
          }
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Render a QR code as Unicode blocks in the terminal.
 */
function QrDisplay({ qr }: { qr: string }) {
  // Use qrcode-terminal to generate the QR string.
  // Since qrcode-terminal writes directly to stdout, we pre-generate it.
  // For TUI we render the raw QR string which contains the block characters.
  const [qrText, setQrText] = useState<string | null>(null);

  useEffect(() => {
    import('qrcode-terminal').then((mod) => {
      const qrModule = mod.default || mod;
      qrModule.generate(qr, { small: true }, (text: string) => {
        setQrText(text);
      });
    }).catch((err) => {
      console.error('[WhatsApp] QR generation failed:', err);
      setQrText(`[QR Code: ${qr.slice(0, 40)}...]`);
    });
  }, [qr]);

  if (!qrText) return <Text color="yellow">  Generating QR code...</Text>;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {qrText.split('\n').map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
}
