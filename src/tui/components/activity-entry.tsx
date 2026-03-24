/**
 * ActivityEntry Component
 * Single activity log entry.
 */

import React from 'react';
import { Box, Text } from 'ink';

interface ActivityEntryProps {
  activityType: string;
  title: string;
  description: string | null;
  timeAgo: string;
  isSelected?: boolean;
}

const TYPE_ICONS: Record<string, { icon: string; color: string }> = {
  task_completed: { icon: '✓', color: 'green' },
  task_failed: { icon: '✗', color: 'red' },
  task_started: { icon: '▸', color: 'yellow' },
  memory_extracted: { icon: '◆', color: 'cyan' },
  agent_created: { icon: '+', color: 'green' },
  config_sync: { icon: '↻', color: 'blue' },
};

export function ActivityEntry({ activityType, title, description, timeAgo, isSelected }: ActivityEntryProps) {
  const typeInfo = TYPE_ICONS[activityType] || { icon: '•', color: 'gray' };

  return (
    <Box>
      <Text color={typeInfo.color}>{typeInfo.icon}</Text>
      <Text> </Text>
      <Text bold={isSelected}>{title.slice(0, 45).padEnd(45)}</Text>
      {description && <Text color="gray">{description.slice(0, 20).padEnd(20)}</Text>}
      <Text color="gray">{timeAgo}</Text>
    </Box>
  );
}
