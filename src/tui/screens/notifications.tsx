/**
 * Notifications Screen
 * Toggle notification channels (email, Slack, Telegram, WhatsApp).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ChannelRegistry } from '../../integrations/channel-registry.js';
import type { ControlPlaneClient } from '../../control-plane/client.js';

type NotificationChannel = 'email' | 'slack' | 'telegram' | 'whatsapp';

interface NotificationsScreenProps {
  db: DatabaseAdapter;
  channels: ChannelRegistry;
  controlPlane: ControlPlaneClient | null;
  onBack: () => void;
}

const ALL_CHANNELS: Array<{ key: NotificationChannel; label: string }> = [
  { key: 'email', label: 'Email' },
  { key: 'slack', label: 'Slack' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'whatsapp', label: 'WhatsApp' },
];

export function NotificationsScreen({ db, channels, controlPlane, onBack }: NotificationsScreenProps) {
  const [selected, setSelected] = useState<NotificationChannel[]>(['email']);
  const [cursor, setCursor] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const connectedTypes = channels.getConnectedTypes();

  const isConnected = (key: NotificationChannel): boolean => {
    if (key === 'email') return true;
    return connectedTypes.includes(key as 'whatsapp' | 'telegram');
  };

  // Load saved preference from local runtime_settings
  useEffect(() => {
    (async () => {
      try {
        const { data } = await db
          .from('runtime_settings')
          .select('value')
          .eq('key', 'notification_channels')
          .maybeSingle();

        if (data?.value) {
          setSelected(JSON.parse(data.value as string) as NotificationChannel[]);
        } else {
          // Default: email + all connected channels
          const defaults: NotificationChannel[] = ['email'];
          for (const ch of ALL_CHANNELS) {
            if (ch.key !== 'email' && isConnected(ch.key)) {
              defaults.push(ch.key);
            }
          }
          setSelected(defaults);
        }
      } catch {
        // Table may not exist yet
      }
      setLoaded(true);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveLocally = useCallback(async (prefs: NotificationChannel[]) => {
    try {
      const now = new Date().toISOString();
      const { data: existing } = await db
        .from('runtime_settings')
        .select('key')
        .eq('key', 'notification_channels')
        .maybeSingle();

      if (existing) {
        await db.from('runtime_settings').update({
          value: JSON.stringify(prefs),
          updated_at: now,
        }).eq('key', 'notification_channels');
      } else {
        await db.from('runtime_settings').insert({
          key: 'notification_channels',
          value: JSON.stringify(prefs),
          updated_at: now,
        });
      }
    } catch {
      // Best-effort
    }
  }, [db]);

  const syncToCloud = useCallback(async (prefs: NotificationChannel[]) => {
    if (!controlPlane) return;
    try {
      await controlPlane.reportSettings({ notification_channels: prefs });
    } catch {
      // Best-effort
    }
  }, [controlPlane]);

  useInput((input, key) => {
    if (saving) return;

    if (key.escape) {
      onBack();
      return;
    }

    // Navigate
    if (key.upArrow || input === 'k') {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursor((c) => Math.min(ALL_CHANNELS.length - 1, c + 1));
      return;
    }

    // Toggle with space
    if (input === ' ') {
      const ch = ALL_CHANNELS[cursor];
      if (!isConnected(ch.key)) return;

      setSelected((prev) => {
        if (prev.includes(ch.key)) {
          return prev.filter((c) => c !== ch.key);
        }
        return [...prev, ch.key];
      });
      return;
    }

    // Save with enter
    if (key.return) {
      setSaving(true);
      setSaved(false);
      Promise.all([saveLocally(selected), syncToCloud(selected)])
        .then(() => {
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        })
        .finally(() => setSaving(false));
    }
  });

  if (!loaded) {
    return (
      <Box flexDirection="column">
        <Text bold>Notifications</Text>
        <Text color="gray">Loading...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Notifications</Text>
      <Text color="gray">Choose where you get notified about task updates and approvals.</Text>

      <Box flexDirection="column" marginTop={1}>
        {ALL_CHANNELS.map((ch, i) => {
          const connected = isConnected(ch.key);
          const checked = selected.includes(ch.key);
          const isCursor = cursor === i;

          return (
            <Text key={ch.key}>
              <Text color={isCursor ? 'cyan' : 'white'}>{isCursor ? '>' : ' '}</Text>
              {' '}
              <Text color={connected ? 'white' : 'gray'}>
                [{checked ? 'x' : ' '}] {ch.label}
              </Text>
              {!connected && ch.key !== 'email' && (
                <Text color="gray"> (not connected)</Text>
              )}
            </Text>
          );
        })}
      </Box>

      <Box marginTop={1}>
        {saving && <Text color="yellow">Saving...</Text>}
        {saved && <Text color="green">Saved!</Text>}
        {!saving && !saved && (
          <Text color="gray">
            {'  '}
            <Text bold color="white">↑↓</Text> navigate{'  '}
            <Text bold color="white">Space</Text> toggle{'  '}
            <Text bold color="white">Enter</Text> save{'  '}
            <Text bold color="white">Esc</Text> back
          </Text>
        )}
      </Box>
    </Box>
  );
}
