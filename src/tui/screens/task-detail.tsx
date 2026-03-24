/**
 * TaskDetail Screen
 * Task output + conversation history (scrollable).
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { TaskRow, AttachmentRow } from '../types.js';
import { TextPanel } from '../components/text-panel.js';
import { ScrollableList } from '../components/scrollable-list.js';
import { InputField } from '../components/input-field.js';
import { join } from 'path';
import { openPath } from '../../lib/platform-utils.js';
import { createLocalAttachmentService } from '../../services/local-attachment.service.js';
import { DEFAULT_CONFIG_DIR } from '../../config.js';

interface TaskDetailProps {
  taskId: string;
  db: DatabaseAdapter | null;
  workspaceId: string;
  onBack: () => void;
}

interface TaskMessage {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

function getTimeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export function TaskDetail({ taskId, db, workspaceId, onBack }: TaskDetailProps) {
  const [task, setTask] = useState<TaskRow | null>(null);
  const [messages, setMessages] = useState<TaskMessage[]>([]);
  const [tab, setTab] = useState<'output' | 'conversation' | 'info' | 'files'>('output');
  const [attachments, setAttachments] = useState<AttachmentRow[]>([]);
  const [fileInput, setFileInput] = useState('');
  const [attachError, setAttachError] = useState('');

  useEffect(() => {
    if (!db) return;

    const fetch = async () => {
      const { data: taskData } = await db
        .from<TaskRow>('agent_workforce_tasks')
        .select('*')
        .eq('id', taskId)
        .single();

      if (taskData) {
        setTask(taskData);
      }

      const { data: msgData } = await db
        .from<TaskMessage>('agent_workforce_task_messages')
        .select('*')
        .eq('task_id', taskId)
        .order('created_at', { ascending: true });

      if (msgData) {
        setMessages(msgData);
      }

      // Fetch attachments
      const attachSvc = createLocalAttachmentService(db, workspaceId, join(DEFAULT_CONFIG_DIR, 'data'));
      setAttachments(attachSvc.list('task', taskId));
    };

    fetch();
  }, [db, taskId, workspaceId]);

  const handleAttachFile = () => {
    if (!db || !fileInput.trim()) return;
    setAttachError('');
    try {
      const svc = createLocalAttachmentService(db, workspaceId, join(DEFAULT_CONFIG_DIR, 'data'));
      svc.attach('task', taskId, fileInput.trim());
      setFileInput('');
      setAttachments(svc.list('task', taskId));
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : 'Couldn\'t attach file.');
    }
  };

  const _handleDeleteAttachment = (id: string) => {
    if (!db) return;
    try {
      const svc = createLocalAttachmentService(db, workspaceId, join(DEFAULT_CONFIG_DIR, 'data'));
      svc.remove(id);
      setAttachments(svc.list('task', taskId));
    } catch { /* ignore */ }
  };

  const handleOpenAttachment = (storagePath: string) => {
    openPath(storagePath);
  };

  useInput((input, key) => {
    if (tab === 'files' && fileInput.length > 0) return;

    if (key.escape) {
      onBack();
      return;
    }
    type TaskTab = 'output' | 'conversation' | 'info' | 'files';
    const tabs: TaskTab[] = ['output', 'conversation', 'info', 'files'];
    if (key.leftArrow) {
      setTab(prev => {
        const idx = tabs.indexOf(prev);
        return tabs[(idx - 1 + tabs.length) % tabs.length];
      });
      return;
    }
    if (key.rightArrow) {
      setTab(prev => {
        const idx = tabs.indexOf(prev);
        return tabs[(idx + 1) % tabs.length];
      });
      return;
    }
  });

  if (!task) {
    return <Text color="gray">Loading task...</Text>;
  }

  const output = typeof task.output === 'string' ? task.output : JSON.stringify(task.output, null, 2);
  const statusColor = task.status === 'completed' ? 'green' : task.status === 'failed' ? 'red' : task.status === 'in_progress' ? 'yellow' : 'magenta';

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">{task.title}</Text>
        <Text color={statusColor}> [{task.status}]</Text>
      </Box>

      {/* Sub-tabs */}
      <Box marginBottom={1}>
        <Text color={tab === 'output' ? 'cyan' : 'gray'} bold={tab === 'output'}>Output  </Text>
        <Text color={tab === 'conversation' ? 'cyan' : 'gray'} bold={tab === 'conversation'}>Messages ({messages.length})  </Text>
        <Text color={tab === 'info' ? 'cyan' : 'gray'} bold={tab === 'info'}>Info  </Text>
        <Text color={tab === 'files' ? 'cyan' : 'gray'} bold={tab === 'files'}>Files({attachments.length})</Text>
        <Text color="gray">  ←/→</Text>
      </Box>

      {tab === 'output' && (
        <TextPanel
          content={output || 'No output yet.'}
          title="Task Output"
        />
      )}

      {tab === 'conversation' && (
        <Box flexDirection="column">
          {messages.length === 0 ? (
            <Text color="gray">No messages yet.</Text>
          ) : (
            messages.map(msg => (
              <Box key={msg.id} flexDirection="column" marginBottom={1}>
                <Text bold color={msg.role === 'user' ? 'green' : 'cyan'}>
                  [{msg.role}]
                </Text>
                <Text>{msg.content.slice(0, 500)}</Text>
              </Box>
            ))
          )}
        </Box>
      )}

      {tab === 'info' && (
        <Box flexDirection="column">
          <Text>Status:    <Text color={statusColor}>{task.status}</Text></Text>
          <Text>Agent:     <Text color="gray">{task.agent_id}</Text></Text>
          {task.model_used && <Text>Model:     <Text color="gray">{task.model_used}</Text></Text>}
          {task.tokens_used != null && <Text>Tokens:    <Text color="gray">{task.tokens_used.toLocaleString()}</Text></Text>}
          {task.cost_cents != null && <Text>Cost:      <Text color="gray">${(task.cost_cents / 100).toFixed(2)}</Text></Text>}
          {task.duration_seconds != null && <Text>Duration:  <Text color="gray">{task.duration_seconds}s</Text></Text>}
          {task.error_message && <Text>Error:     <Text color="red">{task.error_message}</Text></Text>}
          <Text>Created:   <Text color="gray">{task.created_at}</Text></Text>
          {task.completed_at && <Text>Completed: <Text color="gray">{task.completed_at}</Text></Text>}
        </Box>
      )}

      {tab === 'files' && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <InputField
              label="Attach"
              value={fileInput}
              onChange={(v) => { setFileInput(v); setAttachError(''); }}
              onSubmit={handleAttachFile}
              placeholder="File path, then Enter"
            />
          </Box>
          {attachError && <Text color="red">{attachError}</Text>}
          {attachments.length === 0 ? (
            <Text color="gray">No files attached yet.</Text>
          ) : (
            <ScrollableList
              items={attachments}
              emptyMessage="No files."
              onSelect={(att) => handleOpenAttachment(att.storage_path)}
              renderItem={(att, _, isSelected) => {
                const sizeKb = (att.file_size / 1024).toFixed(1);
                return (
                  <Box>
                    <Text bold={isSelected}>
                      <Text color="cyan">{'📎'}</Text>
                      <Text> {att.filename}</Text>
                      <Text color="gray"> ({sizeKb} KB)</Text>
                      <Text color="gray"> {getTimeAgo(att.created_at)}</Text>
                    </Text>
                  </Box>
                );
              }}
            />
          )}
          {attachments.length > 0 && (
            <Text color="gray">Enter:open  d:delete selected</Text>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray">Esc:back  ←/→:tabs  j/k:scroll</Text>
      </Box>
    </Box>
  );
}
