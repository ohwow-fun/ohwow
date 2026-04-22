/**
 * BootSplash — cinematic typed boot crawl shown before the dashboard loads.
 * Lines appear one at a time every 220ms; onDone() fires at 1800ms.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { C } from '../theme.js';

interface BootSplashProps {
  onDone: () => void;
  version: string;
}

const SEPARATOR = '▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓';
const RULE      = '──────────────────────────────────────────────';

export function BootSplash({ onDone, version }: BootSplashProps) {
  const [visibleLines, setVisibleLines] = useState(0);

  useEffect(() => {
    // Schedule each line appearance and the final onDone call
    const timers: ReturnType<typeof setTimeout>[] = [];

    for (let i = 1; i <= 8; i++) {
      timers.push(setTimeout(() => setVisibleLines(i), i * 220));
    }

    timers.push(setTimeout(() => onDone(), 1800));

    return () => {
      for (const t of timers) clearTimeout(t);
    };
    // onDone is stable (useState setter wrapper) — intentionally empty dep array
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* Line 1 — separator bar */}
      {visibleLines >= 1 && (
        <Text color={C.slate} dimColor>{SEPARATOR}</Text>
      )}

      {/* Line 2 — product title */}
      {visibleLines >= 2 && (
        <Text bold color={C.cyan}>{'   '}OHWOW v{version} — Neural Business Runtime</Text>
      )}

      {/* Line 3 — separator bar */}
      {visibleLines >= 3 && (
        <Text color={C.slate} dimColor>{SEPARATOR}</Text>
      )}

      {/* Line 4 — connecting */}
      {visibleLines >= 4 && (
        <Text color={C.dim}>{' ◌  Connecting to workspace...'}</Text>
      )}

      {/* Line 5 — roster */}
      {visibleLines >= 5 && (
        <Text color={C.dim}>{' ◌  Loading operative roster...'}</Text>
      )}

      {/* Line 6 — cloud link */}
      {visibleLines >= 6 && (
        <Text color={C.dim}>{' ◌  Establishing cloud link...'}</Text>
      )}

      {/* Line 7 — rule */}
      {visibleLines >= 7 && (
        <Text color={C.slate} dimColor>{RULE}</Text>
      )}

      {/* Line 8 — ready */}
      {visibleLines >= 8 && (
        <Text bold color={C.green}>{'      '}YOUR TEAM IS READY.</Text>
      )}
    </Box>
  );
}
