/**
 * Automation Detail Screen
 * Shows trigger info and execution history.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { LocalTrigger, LocalTriggerExecution } from '../../webhooks/ghl-types.js';
import { LocalTriggerService } from '../../triggers/local-trigger-service.js';
import { GHL_EVENT_TYPES, ACTION_TYPES } from '../../triggers/trigger-constants.js';
import { ScrollableList } from '../components/scrollable-list.js';

interface AutomationDetailProps {
  triggerId: string;
  db: DatabaseAdapter | null;
  onBack: () => void;
  onEdit: (triggerId: string) => void;
}

type Tab = 'info' | 'executions';

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

function getEventLabel(eventType: string): string {
  return GHL_EVENT_TYPES.find(e => e.value === eventType)?.label || eventType;
}

function getActionLabel(actionType: string): string {
  return ACTION_TYPES.find(a => a.value === actionType)?.label || actionType;
}

export function AutomationDetail({ triggerId, db, onBack, onEdit }: AutomationDetailProps) {
  const [trigger, setTrigger] = useState<LocalTrigger | null>(null);
  const [executions, setExecutions] = useState<LocalTriggerExecution[]>([]);
  const [tab, setTab] = useState<Tab>('info');

  useEffect(() => {
    if (!db) return;
    const service = new LocalTriggerService(db);

    const fetch = async () => {
      const t = await service.getById(triggerId);
      setTrigger(t);
      const execs = await service.getExecutions(triggerId);
      setExecutions(execs);
    };

    fetch();
    const timer = setInterval(fetch, 5000);
    return () => clearInterval(timer);
  }, [db, triggerId]);

  const handleToggle = async () => {
    if (!db || !trigger) return;
    const service = new LocalTriggerService(db);
    await service.update(triggerId, { enabled: !trigger.enabled });
    const updated = await service.getById(triggerId);
    setTrigger(updated);
  };

  useInput((input, key) => {
    if (key.escape) { onBack(); return; }
    const tabs: Tab[] = ['info', 'executions'];
    if (key.leftArrow || key.rightArrow) {
      setTab(prev => {
        const idx = tabs.indexOf(prev);
        const next = key.rightArrow
          ? (idx + 1) % tabs.length
          : (idx - 1 + tabs.length) % tabs.length;
        return tabs[next];
      });
      return;
    }
    if (input === 'e') { onEdit(triggerId); return; }
    if (input === ' ') { handleToggle(); return; }
  });

  if (!trigger) {
    return <Text color="gray">Loading trigger...</Text>;
  }

  const actionConfig = parseJson(trigger.action_config);

  return (
    <Box flexDirection="column">
      <Text bold>{trigger.name}</Text>

      {/* Tab bar */}
      <Box marginTop={1}>
        <Text color={tab === 'info' ? 'cyan' : 'gray'} bold={tab === 'info'}>
          Info
        </Text>
        <Text>  </Text>
        <Text color={tab === 'executions' ? 'cyan' : 'gray'} bold={tab === 'executions'}>
          Executions ({executions.length})
        </Text>
        <Text color="gray">  ←/→</Text>
      </Box>

      {/* Info tab */}
      {tab === 'info' && (
        <Box flexDirection="column" marginTop={1}>
          <Text>  <Text bold>Name:</Text>         {trigger.name}</Text>
          {trigger.description && (
            <Text>  <Text bold>Description:</Text>  {trigger.description}</Text>
          )}
          <Text>
            {'  '}<Text bold>Enabled:</Text>       <Text color={trigger.enabled ? 'green' : 'gray'}>{trigger.enabled ? 'Yes' : 'No'}</Text>
          </Text>
          <Text>  <Text bold>Event Type:</Text>    <Text color="cyan">{getEventLabel(trigger.event_type)}</Text> <Text color="gray">({trigger.event_type})</Text></Text>
          <Text>  <Text bold>Action:</Text>        <Text color="magenta">{getActionLabel(trigger.action_type)}</Text></Text>
          <Text>  <Text bold>Cooldown:</Text>      {trigger.cooldown_seconds}s</Text>
          <Text>  <Text bold>Fire Count:</Text>    {trigger.fire_count}</Text>
          <Text>  <Text bold>Last Fired:</Text>    {trigger.last_fired_at ? getTimeAgo(trigger.last_fired_at) : 'never'}</Text>
          {trigger.last_error && (
            <Text>  <Text bold color="red">Last Error:</Text>   <Text color="red">{trigger.last_error}</Text></Text>
          )}

          {/* Webhook URL for custom triggers */}
          {trigger.webhook_token && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold color="cyan">Webhook URL</Text>
              <Text>  <Text color="gray">/webhooks/incoming/{trigger.webhook_token}</Text></Text>
              {trigger.sample_fields && (
                <Text>  <Text bold>Discovered Fields:</Text> {(() => { try { return (JSON.parse(trigger.sample_fields) as string[]).length; } catch { return 0; } })()}</Text>
              )}
            </Box>
          )}

          {/* Action config */}
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="cyan">Action Config</Text>
            {Object.entries(actionConfig).map(([key, value]) => (
              <Text key={key}>  <Text bold>{key}:</Text> {String(value)}</Text>
            ))}
            {Object.keys(actionConfig).length === 0 && (
              <Text color="gray">  No config</Text>
            )}
          </Box>
        </Box>
      )}

      {/* Executions tab */}
      {tab === 'executions' && (
        <Box marginTop={1} flexDirection="column">
          <ScrollableList
            items={executions}
            emptyMessage="No executions yet."
            renderItem={(exec, _, isSelected) => {
              const statusIcon = exec.status === 'success' ? '✓' : exec.status === 'error' ? '✗' : '◉';
              const statusColor = exec.status === 'success' ? 'green' : exec.status === 'error' ? 'red' : 'yellow';
              return (
                <Box>
                  <Text color={statusColor}>{statusIcon}</Text>
                  <Text> </Text>
                  <Text bold={isSelected}>{getActionLabel(exec.action_type).padEnd(18)}</Text>
                  <Text color="cyan">{getEventLabel(exec.source_event).slice(0, 20).padEnd(20)}</Text>
                  <Text color="gray">{getTimeAgo(exec.created_at)}</Text>
                  {exec.error_message && (
                    <Text color="red">  {exec.error_message.slice(0, 40)}</Text>
                  )}
                </Box>
              );
            }}
          />
        </Box>
      )}

      {/* Key hints */}
      <Box marginTop={1}>
        <Text color="gray">
          <Text bold color="white">←</Text>/<Text bold color="white">→</Text>:tabs  <Text bold color="white">e</Text>:edit  <Text bold color="white">Space</Text>:toggle  <Text bold color="white">Esc</Text>:back
        </Text>
      </Box>
    </Box>
  );
}

function parseJson(val: unknown): Record<string, unknown> {
  if (typeof val === 'object' && val !== null) return val as Record<string, unknown>;
  try {
    return JSON.parse(val as string) as Record<string, unknown>;
  } catch {
    return {};
  }
}
