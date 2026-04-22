/**
 * SectionNav
 * Persistent 4-section nav bar rendered at the bottom of every view.
 * [1] Today  [2] Team  [3] Work  [4] Settings
 *
 * When inside Team or Work sections, shows a sub-tab strip above the primary nav.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from '../types.js';
import { C } from '../theme.js';

const SECTIONS: Array<{ key: string; label: string; section: Section }> = [
  { key: '1', label: 'Today', section: Section.Today },
  { key: '2', label: 'Team', section: Section.Team },
  { key: '3', label: 'Work', section: Section.Work },
  { key: '4', label: 'Settings', section: Section.Settings },
];

export type TeamSubTab = 'agents' | 'contacts' | 'people';
export type WorkSubTab = 'tasks' | 'activity' | 'automations';

const TEAM_SUBTABS: Array<{ key: string; label: string; tab: TeamSubTab }> = [
  { key: 'a', label: 'Agents', tab: 'agents' },
  { key: 'c', label: 'Contacts', tab: 'contacts' },
  { key: 'p', label: 'People', tab: 'people' },
];

const WORK_SUBTABS: Array<{ key: string; label: string; tab: WorkSubTab }> = [
  { key: 't', label: 'Tasks', tab: 'tasks' },
  { key: 'v', label: 'Activity', tab: 'activity' },
  { key: 'x', label: 'Automations', tab: 'automations' },
];

interface SectionNavProps {
  activeSection: Section;
  teamSubTab?: TeamSubTab;
  workSubTab?: WorkSubTab;
}

export function SectionNav({ activeSection, teamSubTab, workSubTab }: SectionNavProps) {
  const showTeamSubTabs = activeSection === Section.Team && teamSubTab !== undefined;
  const showWorkSubTabs = activeSection === Section.Work && workSubTab !== undefined;

  return (
    <Box flexDirection="column">
      {/* Sub-tab strip for Team section */}
      {showTeamSubTabs && (
        <Box
          flexDirection="row"
          borderStyle="single"
          borderColor={C.cyan}
          paddingX={1}
          marginTop={0}
        >
          <Text dimColor>Team: </Text>
          {TEAM_SUBTABS.map((s, i) => {
            const isActive = s.tab === teamSubTab;
            return (
              <Box key={s.tab} marginRight={i < TEAM_SUBTABS.length - 1 ? 2 : 0}>
                <Text
                  color={isActive ? C.cyan : C.slate}
                  bold={isActive}
                  inverse={isActive}
                >
                  [{s.key}] {isActive ? `▐ ${s.label} ▌` : s.label}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Sub-tab strip for Work section */}
      {showWorkSubTabs && (
        <Box
          flexDirection="row"
          borderStyle="single"
          borderColor={C.cyan}
          paddingX={1}
          marginTop={0}
        >
          <Text dimColor>Work: </Text>
          {WORK_SUBTABS.map((s, i) => {
            const isActive = s.tab === workSubTab;
            return (
              <Box key={s.tab} marginRight={i < WORK_SUBTABS.length - 1 ? 2 : 0}>
                <Text
                  color={isActive ? C.cyan : C.slate}
                  bold={isActive}
                  inverse={isActive}
                >
                  [{s.key}] {isActive ? `▐ ${s.label} ▌` : s.label}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Primary section nav */}
      <Box
        flexDirection="row"
        borderStyle="single"
        borderColor={C.slate}
        paddingX={1}
        marginTop={0}
      >
        {SECTIONS.map((s, i) => {
          const isActive = s.section === activeSection;
          return (
            <Box key={s.section} marginRight={i < SECTIONS.length - 1 ? 2 : 0}>
              <Text
                color={isActive ? C.cyan : C.slate}
                bold={isActive}
                inverse={isActive}
              >
                [{s.key}] {isActive ? `▌${s.label}▐` : s.label}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
