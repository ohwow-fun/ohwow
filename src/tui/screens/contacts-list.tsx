/**
 * ContactsList Screen
 * Contact roster with type badges and status.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { ScrollableList } from '../components/scrollable-list.js';
import { ContactCard } from '../components/contact-card.js';

interface Contact {
  id: string;
  name: string;
  email: string | null;
  company: string | null;
  contactType: string;
  status: string;
}

interface ContactsListProps {
  contacts: Contact[];
  onSelect: (id: string) => void;
}

export function ContactsList({ contacts, onSelect }: ContactsListProps) {
  return (
    <Box flexDirection="column">
      <Text bold>Contacts ({contacts.length})</Text>
      <Box marginTop={1}>
        <ScrollableList
          items={contacts}
          onSelect={(contact) => onSelect(contact.id)}
          emptyMessage="No contacts yet. Use chat to create your first one."
          renderItem={(contact, _, isSelected) => (
            <ContactCard
              name={contact.name}
              company={contact.company}
              contactType={contact.contactType}
              status={contact.status}
              email={contact.email}
              isSelected={isSelected}
            />
          )}
        />
      </Box>
    </Box>
  );
}
