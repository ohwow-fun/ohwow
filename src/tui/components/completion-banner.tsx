/**
 * CompletionBanner component
 * Slide-in notification strip for task complete / error / approval events.
 * Displayed inline above the StatusBar.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { C } from '../theme.js';
import { useAnimationTick } from '../hooks/use-animation-frame.js';
import type { BannerState } from '../hooks/use-completion-banner.js';

const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const REVEAL_TICKS = 4;

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

interface CompletionBannerProps {
  banner: BannerState;
}

export function CompletionBanner({ banner }: CompletionBannerProps): React.JSX.Element {
  const tick = useAnimationTick(120);

  const borderColor =
    banner.kind === 'completed' ? C.mint :
    banner.kind === 'failed'    ? C.red  : C.amber;

  const icon =
    banner.kind === 'completed' ? '✓' :
    banner.kind === 'failed'    ? '✕' : '⚑';

  const kindLabel =
    banner.kind === 'completed' ? 'Done' :
    banner.kind === 'failed'    ? 'Stopped' : 'Needs review';

  // Slide-in: reveal characters over first REVEAL_TICKS ticks
  const spinner = BRAILLE[tick % BRAILLE.length];
  const isRevealing = tick < REVEAL_TICKS;

  const titleFull = truncate(banner.title, 40);
  const titleVisible = isRevealing
    ? titleFull.slice(0, Math.floor((tick / REVEAL_TICKS) * titleFull.length))
    : titleFull;

  const agentSuffix = banner.agentName ? ` via ${banner.agentName}` : '';

  return (
    <Box
      borderStyle="single"
      borderColor={borderColor}
      paddingX={1}
      flexDirection="row"
      justifyContent="space-between"
    >
      <Box flexDirection="row" gap={1}>
        <Text color={borderColor}>
          {isRevealing ? spinner : icon}
        </Text>
        <Text bold color={borderColor}>{kindLabel}</Text>
        <Text color="white">{titleVisible}{agentSuffix}</Text>
      </Box>
      <Text dimColor>dismissing…</Text>
    </Box>
  );
}
