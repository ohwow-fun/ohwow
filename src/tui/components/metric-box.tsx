/**
 * MetricBox Component
 * Stat card showing a number + label.
 */

import React from 'react';
import { Box, Text } from 'ink';

interface MetricBoxProps {
  label: string;
  value: string;
  color?: string;
}

export function MetricBox({ label, value, color = 'white' }: MetricBoxProps) {
  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      paddingX={2}
      marginRight={1}
      flexDirection="column"
      alignItems="center"
      width={14}
    >
      <Text color={color} bold>{value}</Text>
      <Text color="gray">{label}</Text>
    </Box>
  );
}
