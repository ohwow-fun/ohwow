/**
 * GHL Webhook Screen
 * Shows webhook endpoint info and incoming event history.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { ScrollableList } from '../components/scrollable-list.js';

interface GhlWebhookProps {
  db: DatabaseAdapter | null;
  port: number;
  tunnelUrl: string | null;
  cloudWebhookBaseUrl: string | null;
  onBack: () => void;
}

type Tab = 'info' | 'executions';

interface WebhookEvent {
  id: string;
  source: string;
  event_type: string;
  payload: string | Record<string, unknown>;
  headers: string;
  processed: number;
  created_at: string;
}

function getTimeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

function toStr(val: unknown): string {
  return typeof val === 'string' ? val : JSON.stringify(val);
}

export function GhlWebhook({ db, port, tunnelUrl, cloudWebhookBaseUrl, onBack }: GhlWebhookProps) {
  const [tab, setTab] = useState<Tab>('info');
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [selectedPayload, setSelectedPayload] = useState<string | null>(null);
  const [hasSecret, setHasSecret] = useState<boolean | null>(null);

  useEffect(() => {
    if (!db) return;

    const fetchData = async () => {
      // Fetch recent webhook events
      const { data } = await db.from<WebhookEvent>('webhook_events')
        .select('*')
        .eq('source', 'ghl')
        .order('created_at', { ascending: false })
        .limit(50);
      if (data) setEvents(data);

      // Check if GHL webhook secret is configured
      const { data: setting } = await db.from('runtime_settings')
        .select('value')
        .eq('key', 'ghl_webhook_secret')
        .maybeSingle();
      setHasSecret(!!(setting as { value: string } | null)?.value);
    };

    fetchData();
    const timer = setInterval(fetchData, 2000);
    return () => clearInterval(timer);
  }, [db]);

  useInput((input, key) => {
    if (key.escape) {
      if (selectedPayload) {
        setSelectedPayload(null);
      } else {
        onBack();
      }
      return;
    }
    const tabs: Tab[] = ['info', 'executions'];
    if (key.leftArrow || key.rightArrow) {
      setTab(prev => {
        const idx = tabs.indexOf(prev);
        const next = key.rightArrow
          ? (idx + 1) % tabs.length
          : (idx - 1 + tabs.length) % tabs.length;
        return tabs[next];
      });
      setSelectedPayload(null);
      return;
    }
  });

  const localUrl = `http://127.0.0.1:${port}/webhooks/ghl`;
  const publicUrl = cloudWebhookBaseUrl
    ? `${cloudWebhookBaseUrl}/ghl`
    : tunnelUrl ? `${tunnelUrl}/webhooks/ghl` : null;
  const isCloudUrl = !!cloudWebhookBaseUrl;

  return (
    <Box flexDirection="column">
      <Text bold>GHL Webhook</Text>

      {/* Tab bar */}
      <Box marginTop={1}>
        <Text color={tab === 'info' ? 'cyan' : 'gray'} bold={tab === 'info'}>
          Info
        </Text>
        <Text>  </Text>
        <Text color={tab === 'executions' ? 'cyan' : 'gray'} bold={tab === 'executions'}>
          Events ({events.length})
        </Text>
        <Text color="gray">  ←/→</Text>
      </Box>

      {/* Info tab */}
      {tab === 'info' && (
        <Box flexDirection="column" marginTop={1}>
          <Text>  <Text bold>Local URL:</Text>   <Text color="gray">{localUrl}</Text></Text>
          {publicUrl ? (
            <Text>  <Text bold>{isCloudUrl ? 'Webhook URL:' : 'Tunnel URL:'}</Text>  <Text color="cyan">{publicUrl}</Text></Text>
          ) : (
            <Text>  <Text bold>Tunnel URL:</Text>  <Text color="gray">Not active. Press Esc, then u to set up a tunnel.</Text></Text>
          )}
          <Text>
            {'  '}<Text bold>Status:</Text>      <Text color="green">Listening</Text>
          </Text>
          <Text>
            {'  '}<Text bold>Signature:</Text>   <Text color={hasSecret ? 'green' : 'yellow'}>{hasSecret ? 'Configured' : 'Not configured'}</Text>
          </Text>
          {!hasSecret && hasSecret !== null && (
            <Text color="gray">{'  '}Set ghl_webhook_secret in runtime settings to verify signatures.</Text>
          )}

          <Box flexDirection="column" marginTop={1}>
            <Text bold color="cyan">How to connect</Text>
            <Text color="gray">{'  '}1. Copy the tunnel URL above</Text>
            <Text color="gray">{'  '}2. In GoHighLevel, go to Settings {'>'} Webhooks</Text>
            <Text color="gray">{'  '}3. Paste the URL and select events to forward</Text>
            <Text color="gray">{'  '}4. Incoming events will appear in the Events tab</Text>
          </Box>
        </Box>
      )}

      {/* Executions tab */}
      {tab === 'executions' && !selectedPayload && (
        <Box marginTop={1} flexDirection="column">
          <ScrollableList
            items={events}
            emptyMessage="No events yet."
            onSelect={(event) => {
              setSelectedPayload(toStr(event.payload));
            }}
            renderItem={(event, _, isSelected) => {
              const statusIcon = event.processed ? '✓' : '○';
              const statusColor = event.processed ? 'green' : 'gray';
              return (
                <Box>
                  <Text color={statusColor}>{statusIcon}</Text>
                  <Text> </Text>
                  <Text bold={isSelected}>{event.event_type.padEnd(25)}</Text>
                  <Text color="gray">{toStr(event.payload)}</Text>
                  <Text> </Text>
                  <Text color="gray">{getTimeAgo(event.created_at)}</Text>
                </Box>
              );
            }}
          />
        </Box>
      )}

      {/* Payload detail view */}
      {tab === 'executions' && selectedPayload && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="cyan">Payload</Text>
          <Text color="gray">{formatPayload(selectedPayload)}</Text>
        </Box>
      )}

      {/* Key hints */}
      <Box marginTop={1}>
        <Text color="gray">
          <Text bold color="white">←</Text>/<Text bold color="white">→</Text>:tabs  <Text bold color="white">Enter</Text>:view payload  <Text bold color="white">Esc</Text>:back
        </Text>
      </Box>
    </Box>
  );
}

function formatPayload(raw: unknown): string {
  const str = toStr(raw);
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}
