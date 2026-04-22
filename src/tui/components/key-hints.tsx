/**
 * StatusBar / Key Hints Component
 * Persistent one-line bar at the bottom of every screen showing
 * the active section name and universal keyboard hints.
 *
 * Format: [SECTION] j/k:nav  Enter:open  Esc:back  d:dispatch  ?:help
 * Subsection: [TEAM › Agents] j/k:nav  Enter:open  Esc:back  ...
 */

import React from 'react';
import { Box, Text } from 'ink';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { C } from '../theme.js';

export interface KeyHint {
  key: string;
  label: string;
}

// Legacy prop-driven variant (kept for compatibility with old call sites)
interface KeyHintsProps {
  hints: KeyHint[];
}

/** @deprecated Use StatusBar instead */
export function KeyHints({ hints }: KeyHintsProps) {
  if (hints.length === 0) return null;

  return (
    <Box borderStyle="single" borderColor={C.slate} paddingX={1}>
      {hints.map((hint, i) => (
        <Box key={i} marginRight={2}>
          <Text bold color={C.amber}>{hint.key}</Text>
          <Text color={C.dim}>:{hint.label}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ─── Universal Status Bar ────────────────────────────────────────────────────

export interface StatusBarProps {
  /** Primary section label e.g. "TODAY", "TEAM", "WORK", "SETTINGS" */
  section: string;
  /** Optional subsection e.g. "Agents", "Tasks" — shown as "[TEAM › Agents]" */
  subsection?: string;
  /** Extra context-specific hints appended after the universal set */
  extraHints?: KeyHint[];
  /** When true, hide the d:dispatch hint (e.g. inside dispatch wizard itself) */
  hideDispatch?: boolean;
}

export function StatusBar({ section, subsection, extraHints, hideDispatch }: StatusBarProps) {
  const cols = useTerminalSize();
  const narrow = cols < 90;
  const compact = cols < 70;

  const sectionLabel = subsection
    ? `${section} › ${subsection}`
    : section;

  return (
    <Box
      borderStyle="single"
      borderColor={C.slate}
      paddingX={1}
      flexDirection="row"
      flexWrap="wrap"
    >
      {/* Section badge */}
      <Box marginRight={2}>
        <Text bold color="white">[</Text>
        <Text bold color={C.cyan}>{sectionLabel}</Text>
        <Text bold color="white">]</Text>
      </Box>

      {/* Universal hints — trim on narrow */}
      {!compact && (
        <Box marginRight={2}>
          <Text bold color={C.amber}>j/k</Text>
          <Text color={C.dim}>:nav</Text>
        </Box>
      )}
      <Box marginRight={2}>
        <Text bold color={C.amber}>Enter</Text>
        <Text color={C.dim}>:open</Text>
      </Box>
      <Box marginRight={2}>
        <Text bold color={C.amber}>Esc</Text>
        <Text color={C.dim}>:back</Text>
      </Box>
      {!hideDispatch && (
        <Box marginRight={2}>
          <Text bold color={C.amber}>d</Text>
          <Text color={C.dim}>:dispatch</Text>
        </Box>
      )}
      {!compact && (
        <Box marginRight={2}>
          <Text bold color={C.amber}>?</Text>
          <Text color={C.dim}>:help</Text>
        </Box>
      )}

      {/* Context-specific extras — only on wide terminals */}
      {!narrow && extraHints && extraHints.map((hint, i) => (
        <Box key={i} marginRight={2}>
          <Text bold color={C.amber}>{hint.key}</Text>
          <Text color={C.dim}>:{hint.label}</Text>
        </Box>
      ))}
    </Box>
  );
}
