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
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      {hints.map((hint, i) => (
        <Box key={i} marginRight={2}>
          <Text bold color="yellow">{hint.key}</Text>
          <Text color="gray">:{hint.label}</Text>
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
  const sectionLabel = subsection
    ? `${section} › ${subsection}`
    : section;

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      flexDirection="row"
      flexWrap="nowrap"
    >
      {/* Section badge */}
      <Box marginRight={2}>
        <Text bold color="white">[</Text>
        <Text bold color="cyan">{sectionLabel}</Text>
        <Text bold color="white">]</Text>
      </Box>

      {/* Universal hints */}
      <Box marginRight={2}>
        <Text bold color="yellow">j/k</Text>
        <Text color="gray">:nav</Text>
      </Box>
      <Box marginRight={2}>
        <Text bold color="yellow">Enter</Text>
        <Text color="gray">:open</Text>
      </Box>
      <Box marginRight={2}>
        <Text bold color="yellow">Esc</Text>
        <Text color="gray">:back</Text>
      </Box>
      {!hideDispatch && (
        <Box marginRight={2}>
          <Text bold color="yellow">d</Text>
          <Text color="gray">:dispatch</Text>
        </Box>
      )}
      <Box marginRight={2}>
        <Text bold color="yellow">?</Text>
        <Text color="gray">:help</Text>
      </Box>

      {/* Context-specific extras */}
      {extraHints && extraHints.map((hint, i) => (
        <Box key={i} marginRight={2}>
          <Text bold color="yellow">{hint.key}</Text>
          <Text color="gray">:{hint.label}</Text>
        </Box>
      ))}
    </Box>
  );
}
