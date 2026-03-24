/**
 * ConfirmDialog Component
 * Y/N confirmation overlay.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';

interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ message, onConfirm, onCancel }: ConfirmDialogProps) {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') {
      onConfirm();
    } else if (input === 'n' || input === 'N' || key.escape) {
      onCancel();
    }
  });

  return (
    <Box
      borderStyle="double"
      borderColor="yellow"
      paddingX={2}
      paddingY={1}
      flexDirection="column"
      alignItems="center"
    >
      <Text bold color="yellow">{message}</Text>
      <Text color="gray">Press <Text bold>y</Text> to confirm, <Text bold>n</Text> to cancel</Text>
    </Box>
  );
}
