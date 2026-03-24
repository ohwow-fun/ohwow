/**
 * Automations Screen
 * List and manage triggers, view webhook log.
 * Accessed from Settings via 't' key (connected tier only).
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { LocalTrigger } from '../../webhooks/ghl-types.js';
import { GHL_EVENT_TYPES, ACTION_TYPES } from '../../triggers/trigger-constants.js';
import { ScrollableList } from '../components/scrollable-list.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { useTriggers } from '../hooks/use-triggers.js';

interface AutomationsProps {
  db: DatabaseAdapter | null;
  onBack: () => void;
  onSelectTrigger: (id: string) => void;
  onCreateTrigger: () => void;
  embedded?: boolean;
}

type Tab = 'triggers' | 'webhookLog';

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

const MAX_VISIBLE = 15;

export function Automations({ db, onBack, onSelectTrigger, onCreateTrigger, embedded }: AutomationsProps) {
  const { triggers, webhookEvents, toggleEnabled, deleteTrigger } = useTriggers(db);
  const [tab, setTab] = useState<Tab>('triggers');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<LocalTrigger | null>(null);

  // Clamp index for current tab
  const items = tab === 'triggers' ? triggers : [];
  const clampedIndex = items.length === 0 ? 0 : Math.min(selectedIndex, items.length - 1);
  const clampedOffset = items.length === 0 ? 0 : Math.min(scrollOffset, Math.max(0, items.length - MAX_VISIBLE));

  useInput((input, key) => {
    if (deleteTarget) return;

    if (!embedded && key.escape) {
      onBack();
      return;
    }

    // When embedded, use Tab to cycle internal tabs (1/2/3 are used by parent)
    if (embedded && key.tab) {
      setTab(prev => prev === 'triggers' ? 'webhookLog' : 'triggers');
      setSelectedIndex(0);
      setScrollOffset(0);
      return;
    }

    if (!embedded && input === 'q') { setTab('triggers'); setSelectedIndex(0); setScrollOffset(0); return; }
    if (!embedded && input === 'w') { setTab('webhookLog'); setSelectedIndex(0); setScrollOffset(0); return; }

    // Triggers tab: manual list navigation + actions
    if (tab === 'triggers' && triggers.length > 0) {
      if (input === 'j' || key.downArrow) {
        const next = Math.min(clampedIndex + 1, triggers.length - 1);
        setSelectedIndex(next);
        if (next >= clampedOffset + MAX_VISIBLE) setScrollOffset(next - MAX_VISIBLE + 1);
        return;
      }
      if (input === 'k' || key.upArrow) {
        const next = Math.max(clampedIndex - 1, 0);
        setSelectedIndex(next);
        if (next < clampedOffset) setScrollOffset(next);
        return;
      }
      if (key.return) {
        onSelectTrigger(triggers[clampedIndex].id);
        return;
      }
      if (input === ' ') {
        toggleEnabled(triggers[clampedIndex].id);
        return;
      }
      if (input === 'd') {
        setDeleteTarget(triggers[clampedIndex]);
        return;
      }
    }

    if (tab === 'triggers' && input === 'n') {
      onCreateTrigger();
      return;
    }
  });

  const handleDeleteConfirm = async () => {
    if (deleteTarget) {
      await deleteTrigger(deleteTarget.id);
      setDeleteTarget(null);
    }
  };

  return (
    <Box flexDirection="column">
      {!embedded && <Text bold>Automations</Text>}

      {/* Tab bar */}
      <Box marginTop={embedded ? 0 : 1}>
        <Text color={tab === 'triggers' ? 'cyan' : 'gray'} bold={tab === 'triggers'}>
          {embedded ? 'Triggers' : '[Q] Triggers'} ({triggers.length})
        </Text>
        <Text>  </Text>
        <Text color={tab === 'webhookLog' ? 'cyan' : 'gray'} bold={tab === 'webhookLog'}>
          {embedded ? 'Webhook Log' : '[W] Webhook Log'} ({webhookEvents.length})
        </Text>
      </Box>

      {/* Triggers tab */}
      {tab === 'triggers' && (
        <Box marginTop={1} flexDirection="column">
          {triggers.length === 0 ? (
            <Text color="gray">No triggers yet. Press n to create one.</Text>
          ) : (
            <Box flexDirection="column">
              {clampedOffset > 0 && <Text color="gray">  ↑ {clampedOffset} more</Text>}
              {triggers.slice(clampedOffset, clampedOffset + MAX_VISIBLE).map((trigger, i) => {
                const realIndex = clampedOffset + i;
                const isSelected = realIndex === clampedIndex;
                return (
                  <Box key={trigger.id}>
                    <Text color={isSelected ? 'cyan' : 'gray'}>{isSelected ? '▸ ' : '  '}</Text>
                    <Text color={trigger.enabled ? 'green' : 'gray'}>
                      {trigger.enabled ? '●' : '○'}
                    </Text>
                    <Text> </Text>
                    <Text bold={isSelected}>{trigger.name.slice(0, 25).padEnd(25)}</Text>
                    <Text color="cyan">{getEventLabel(trigger.event_type).slice(0, 20).padEnd(20)}</Text>
                    <Text color="magenta">{getActionLabel(trigger.action_type).slice(0, 15).padEnd(15)}</Text>
                    <Text color="gray">{String(trigger.fire_count).padStart(4)} fires</Text>
                    <Text color="gray">  {trigger.last_fired_at ? getTimeAgo(trigger.last_fired_at) : 'never'}</Text>
                  </Box>
                );
              })}
              {clampedOffset + MAX_VISIBLE < triggers.length && (
                <Text color="gray">  ↓ {triggers.length - clampedOffset - MAX_VISIBLE} more</Text>
              )}
            </Box>
          )}
          <Box marginTop={1}>
            <Text color="gray">
              <Text bold color="white">Enter</Text>:details  <Text bold color="white">n</Text>:new  <Text bold color="white">Space</Text>:toggle  <Text bold color="white">d</Text>:delete{!embedded && <>{' '}<Text bold color="white">Esc</Text>:back</>}  <Text bold color="white">Tab</Text>:webhook log
            </Text>
          </Box>
        </Box>
      )}

      {/* Webhook Log tab */}
      {tab === 'webhookLog' && (
        <Box marginTop={1} flexDirection="column">
          <ScrollableList
            items={webhookEvents}
            onSelect={() => { /* expand handled by renderItem state */ }}
            emptyMessage="No webhook events received yet."
            renderItem={(event, _, isSelected) => (
              <Box>
                <Text color="cyan">{getEventLabel(event.event_type).slice(0, 25).padEnd(25)}</Text>
                <Text color="gray">{event.source.slice(0, 10).padEnd(10)}</Text>
                <Text color={event.processed ? 'green' : 'gray'}>
                  {event.processed ? '✓' : '○'}
                </Text>
                <Text color="gray">  {getTimeAgo(event.created_at)}</Text>
                <Text>{isSelected ? ' ▸' : ''}</Text>
              </Box>
            )}
          />
          <Box marginTop={1}>
            <Text color="gray">
              <Text bold color="white">Enter</Text>:expand  {embedded ? <><Text bold color="white">Tab</Text>:triggers</> : <><Text bold color="white">Q</Text>/<Text bold color="white">W</Text>:tabs</>}{!embedded && <>{' '}<Text bold color="white">Esc</Text>:back</>}
            </Text>
          </Box>
        </Box>
      )}

      {deleteTarget && (
        <ConfirmDialog
          message={`Delete trigger "${deleteTarget.name}"? (y/n)`}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </Box>
  );
}
