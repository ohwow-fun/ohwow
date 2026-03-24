/**
 * StatusIndicator Component
 * Cloud connection status badge.
 */

import React from 'react';
import { Text } from 'ink';

interface StatusIndicatorProps {
  connected: boolean;
  label?: string;
}

export function StatusIndicator({ connected, label }: StatusIndicatorProps) {
  return (
    <Text color={connected ? 'green' : 'red'}>
      {connected ? '●' : '○'} {label ?? (connected ? 'Connected' : 'Offline')}
    </Text>
  );
}
