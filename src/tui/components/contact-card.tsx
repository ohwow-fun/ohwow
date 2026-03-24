/**
 * ContactCard Component
 * Contact summary row for lists.
 */

import React from 'react';
import { Box, Text } from 'ink';

interface ContactCardProps {
  name: string;
  company: string | null;
  contactType: string;
  status: string;
  email: string | null;
  isSelected?: boolean;
}

const typeColors: Record<string, string> = {
  lead: 'blue',
  customer: 'green',
  partner: 'magenta',
  other: 'gray',
};

export function ContactCard({ name, company, contactType, status, email, isSelected }: ContactCardProps) {
  const typeColor = typeColors[contactType] || 'gray';
  const statusIcon = status === 'active' ? '●' : '○';
  const statusColor = status === 'active' ? 'green' : 'gray';

  return (
    <Box>
      <Text color={statusColor}>{statusIcon}</Text>
      <Text> </Text>
      <Text bold={isSelected}>{name.padEnd(22)}</Text>
      <Text color={typeColor}>{contactType.padEnd(10)}</Text>
      <Text color="gray">{(company || '').slice(0, 18).padEnd(18)}</Text>
      <Text color="gray">{email || ''}</Text>
    </Box>
  );
}
