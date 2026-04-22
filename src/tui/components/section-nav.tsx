/**
 * SectionNav
 * Persistent 4-section nav bar rendered at the bottom of every view.
 * [1] Today  [2] Team  [3] Work  [4] Settings
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from '../types.js';

const SECTIONS: Array<{ key: string; label: string; section: Section }> = [
  { key: '1', label: 'Today', section: Section.Today },
  { key: '2', label: 'Team', section: Section.Team },
  { key: '3', label: 'Work', section: Section.Work },
  { key: '4', label: 'Settings', section: Section.Settings },
];

interface SectionNavProps {
  activeSection: Section;
}

export function SectionNav({ activeSection }: SectionNavProps) {
  return (
    <Box
      flexDirection="row"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      marginTop={0}
    >
      {SECTIONS.map((s, i) => {
        const isActive = s.section === activeSection;
        return (
          <Box key={s.section} marginRight={i < SECTIONS.length - 1 ? 2 : 0}>
            <Text
              color={isActive ? 'white' : 'gray'}
              bold={isActive}
              inverse={isActive}
            >
              [{s.key}] {s.label}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
