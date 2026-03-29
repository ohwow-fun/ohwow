/**
 * ContactDetail Screen
 * Single contact view: info, notes, and timeline tabs.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ContactRow, ContactEventRow, AttachmentRow } from '../types.js';
import { ScrollableList } from '../components/scrollable-list.js';
import { InputField } from '../components/input-field.js';
import { join } from 'path';
import { openPath } from '../../lib/platform-utils.js';
import { createLocalAttachmentService } from '../../services/local-attachment.service.js';
import { DEFAULT_CONFIG_DIR } from '../../config.js';

interface ContactDetailProps {
  contactId: string;
  db: DatabaseAdapter | null;
  workspaceId: string;
  onBack: () => void;
}

type Tab = 'info' | 'notes' | 'timeline' | 'files';

function getTimeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

const EVENT_ICONS: Record<string, string> = {
  task_assigned: '▶',
  task_completed: '✓',
  contact_created: '◆',
  contact_updated: '✎',
  contact_searched: '⌕',
  note_added: '✏',
};

export function ContactDetail({ contactId, db, workspaceId, onBack }: ContactDetailProps) {
  const [contact, setContact] = useState<ContactRow | null>(null);
  const [events, setEvents] = useState<ContactEventRow[]>([]);
  const [tab, setTab] = useState<Tab>('info');
  const [noteInput, setNoteInput] = useState('');
  const [addingNote, setAddingNote] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentRow[]>([]);
  const [fileInput, setFileInput] = useState('');
  const [attachError, setAttachError] = useState('');

  const fetchData = async () => {
    if (!db) return;

    const { data: contactData } = await db
      .from<ContactRow>('agent_workforce_contacts')
      .select('*')
      .eq('id', contactId)
      .single();

    if (contactData) {
      setContact(contactData);
    }

    const { data: eventData } = await db
      .from<ContactEventRow>('agent_workforce_contact_events')
      .select('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (eventData) {
      setEvents(eventData);
    }

    // Fetch attachments
    const attachSvc = createLocalAttachmentService(db, workspaceId, join(DEFAULT_CONFIG_DIR, 'data'));
    setAttachments(attachSvc.list('contact', contactId));
  };

  useEffect(() => {
    fetchData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, contactId]);

  const notes = events.filter(e => e.event_type === 'note_added');

  const handleAddNote = async () => {
    if (!db || !noteInput.trim() || addingNote) return;
    setAddingNote(true);
    try {
      await db.from('agent_workforce_contact_events').insert({
        workspace_id: workspaceId,
        contact_id: contactId,
        event_type: 'note_added',
        title: 'Note added',
        description: noteInput.trim(),
        metadata: '{}',
      });
      setNoteInput('');
      await fetchData();
    } finally {
      setAddingNote(false);
    }
  };

  const handleAttachFile = () => {
    if (!db || !fileInput.trim()) return;
    setAttachError('');
    try {
      const svc = createLocalAttachmentService(db, workspaceId, join(DEFAULT_CONFIG_DIR, 'data'));
      svc.attach('contact', contactId, fileInput.trim());
      setFileInput('');
      setAttachments(svc.list('contact', contactId));
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : 'Couldn\'t attach file.');
    }
  };

  const _handleDeleteAttachment = (id: string) => {
    if (!db) return;
    try {
      const svc = createLocalAttachmentService(db, workspaceId, join(DEFAULT_CONFIG_DIR, 'data'));
      svc.remove(id);
      setAttachments(svc.list('contact', contactId));
    } catch { /* ignore */ }
  };

  const handleOpenAttachment = (storagePath: string) => {
    openPath(storagePath);
  };

  useInput((input, key) => {
    if (addingNote) return;
    // Don't handle tab/escape keys while typing
    if (tab === 'notes' && noteInput.length > 0) return;
    if (tab === 'files' && fileInput.length > 0) return;

    if (key.escape) {
      onBack();
      return;
    }
    const tabs: Tab[] = ['info', 'notes', 'timeline', 'files'];
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

  if (!contact) {
    return <Text color="gray">Loading contact...</Text>;
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">{contact.name}</Text>
        {contact.company && <Text color="gray"> {'\u2014'} {contact.company}</Text>}
      </Box>

      {/* Sub-tabs */}
      <Box marginBottom={1}>
        <Text color={tab === 'info' ? 'cyan' : 'gray'} bold={tab === 'info'}>Info  </Text>
        <Text color={tab === 'notes' ? 'cyan' : 'gray'} bold={tab === 'notes'}>Notes({notes.length})  </Text>
        <Text color={tab === 'timeline' ? 'cyan' : 'gray'} bold={tab === 'timeline'}>Timeline({events.length})  </Text>
        <Text color={tab === 'files' ? 'cyan' : 'gray'} bold={tab === 'files'}>Files({attachments.length})</Text>
        <Text color="gray">  ←/→</Text>
      </Box>

      {tab === 'info' && (
        <Box flexDirection="column">
          <Text>Name:       <Text color="gray">{contact.name}</Text></Text>
          <Text>Email:      <Text color="gray">{contact.email || '\u2014'}</Text></Text>
          <Text>Phone:      <Text color="gray">{contact.phone || '\u2014'}</Text></Text>
          <Text>Company:    <Text color="gray">{contact.company || '\u2014'}</Text></Text>
          <Text>Type:       <Text color={contact.contact_type === 'lead' ? 'blue' : contact.contact_type === 'customer' ? 'green' : contact.contact_type === 'partner' ? 'magenta' : 'gray'}>{contact.contact_type}</Text></Text>
          <Text>Status:     <Text color={contact.status === 'active' ? 'green' : 'gray'}>{contact.status}</Text></Text>
          <Text>Created:    <Text color="gray">{getTimeAgo(contact.created_at)}</Text></Text>
          {contact.notes && <Text>Notes:      <Text color="gray">{contact.notes}</Text></Text>}
        </Box>
      )}

      {tab === 'notes' && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <InputField
              label="Add note"
              value={noteInput}
              onChange={setNoteInput}
              onSubmit={handleAddNote}
              placeholder="Type a note and press Enter"
            />
          </Box>
          {notes.length === 0 ? (
            <Text color="gray">No notes yet. Type above to add one.</Text>
          ) : (
            <ScrollableList
              items={notes}
              emptyMessage="No notes."
              renderItem={(note, _, isSelected) => (
                <Box flexDirection="column">
                  <Text bold={isSelected}>
                    <Text color="yellow">✏</Text>
                    <Text> {note.description || ''}</Text>
                  </Text>
                  <Text color="gray">  {getTimeAgo(note.created_at)}</Text>
                </Box>
              )}
            />
          )}
        </Box>
      )}

      {tab === 'timeline' && (
        <Box flexDirection="column">
          {events.length === 0 ? (
            <Text color="gray">No activity yet.</Text>
          ) : (
            <ScrollableList
              items={events}
              emptyMessage="No events."
              renderItem={(event, _, isSelected) => {
                const icon = EVENT_ICONS[event.event_type] || '·';
                const typeColor = event.event_type === 'note_added' ? 'yellow'
                  : event.event_type === 'task_completed' ? 'green'
                  : event.event_type === 'task_assigned' ? 'blue'
                  : 'gray';
                return (
                  <Text bold={isSelected}>
                    <Text color={typeColor}>{icon}</Text>
                    <Text> {event.title}</Text>
                    {event.description && <Text color="gray"> {event.description.slice(0, 50)}</Text>}
                    <Text color="gray"> {getTimeAgo(event.created_at)}</Text>
                  </Text>
                );
              }}
            />
          )}
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
        <Text color="gray">
          Esc:back  ←/→:tabs
        </Text>
      </Box>
    </Box>
  );
}
