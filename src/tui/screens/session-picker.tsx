/**
 * SessionPicker Screen
 * Browse, rename, delete, and resume past conversations.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import { InputField } from '../components/input-field.js';

interface Session {
  id: string;
  title: string;
  message_count: number;
  device_name: string | null;
  updated_at: string;
}

interface SessionPickerProps {
  daemonPort: number;
  sessionToken: string;
  onSelect: (id: string) => void;
  onBack: () => void;
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export function SessionPicker({ daemonPort, sessionToken, onSelect, onBack }: SessionPickerProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const fetchSessions = useCallback(async () => {
    try {
      const resp = await fetch(`http://localhost:${daemonPort}/api/orchestrator/sessions`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      if (resp.ok) {
        const data = await resp.json() as { sessions?: Session[] };
        setSessions(data.sessions || []);
      }
    } catch {
      setError('Could not load sessions');
    } finally {
      setLoading(false);
    }
  }, [daemonPort, sessionToken]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const handleRename = useCallback(async (id: string, title: string) => {
    try {
      await fetch(`http://localhost:${daemonPort}/api/orchestrator/sessions/${id}/rename`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ title }),
      });
      setSessions((prev) => prev.map((s) => s.id === id ? { ...s, title } : s));
    } catch {
      // silent
    }
    setRenamingId(null);
    setRenameValue('');
  }, [daemonPort, sessionToken]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await fetch(`http://localhost:${daemonPort}/api/orchestrator/sessions/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setConfirmDeleteId(null);
    } catch {
      // silent
    }
  }, [daemonPort, sessionToken]);

  useInput((input, key) => {
    if (renamingId) {
      if (key.escape) {
        setRenamingId(null);
        setRenameValue('');
      }
      return;
    }

    if (key.escape) {
      if (confirmDeleteId) {
        setConfirmDeleteId(null);
      } else {
        onBack();
      }
      return;
    }

    if (input === 'r' && sessions.length > 0 && !confirmDeleteId) {
      const session = sessions[selectedIndex];
      if (session) {
        setRenamingId(session.id);
        setRenameValue(session.title);
      }
      return;
    }

    if (input === 'd' && sessions.length > 0) {
      const session = sessions[selectedIndex];
      if (session) {
        if (confirmDeleteId === session.id) {
          handleDelete(session.id);
        } else {
          setConfirmDeleteId(session.id);
        }
      }
      return;
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Sessions</Text>
        <Text color="gray">Loading...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Sessions</Text>
        <Text color="red">{error}</Text>
        <Text color="gray">Press Esc to go back</Text>
      </Box>
    );
  }

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Sessions</Text>
        <Text color="gray">No past conversations yet. Start chatting to create one.</Text>
        <Text color="gray">Press Esc to go back</Text>
      </Box>
    );
  }

  const items = sessions.map((s, _i) => ({
    label: `${s.title}  ${s.message_count} msgs  ${relativeTime(s.updated_at)}`,
    value: s.id,
    key: s.id,
  }));

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>Sessions</Text>
        <Text color="gray"> ({sessions.length})</Text>
      </Box>

      {renamingId ? (
        <Box flexDirection="column">
          <Text color="cyan">Rename session:</Text>
          <InputField
            label=""
            value={renameValue}
            onChange={setRenameValue}
            onSubmit={() => handleRename(renamingId, renameValue)}
            placeholder="Enter new title..."
          />
          <Text color="gray">Enter to save, Esc to cancel</Text>
        </Box>
      ) : (
        <>
          <SelectInput
            items={items}
            onSelect={(item) => onSelect(item.value)}
            onHighlight={(item) => {
              const idx = items.findIndex((i) => i.value === item.value);
              if (idx !== -1) setSelectedIndex(idx);
            }}
          />

          {confirmDeleteId && (
            <Box marginTop={1}>
              <Text color="red" bold>Press d again to confirm delete, Esc to cancel</Text>
            </Box>
          )}

          <Box marginTop={1}>
            <Text color="yellow" bold>Enter</Text><Text color="gray">:select  </Text>
            <Text color="yellow" bold>r</Text><Text color="gray">:rename  </Text>
            <Text color="yellow" bold>d</Text><Text color="gray">:delete  </Text>
            <Text color="yellow" bold>Esc</Text><Text color="gray">:back</Text>
          </Box>
        </>
      )}
    </Box>
  );
}
