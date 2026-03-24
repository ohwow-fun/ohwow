/**
 * Automations Tab
 * Main tab coordinator for Triggers, Schedules, and Workflows sub-tabs.
 * Embeds the existing screen components with an `embedded` prop.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { Automations } from './automations.js';
import { Schedules } from './schedules.js';
import { Workflows } from './workflows.js';

type SubTab = 'triggers' | 'schedules' | 'workflows';

interface AutomationsTabProps {
  db: DatabaseAdapter | null;
  engine: { executeTask: (agentId: string, taskId: string) => Promise<unknown> } | null;
  workspaceId: string;
  onSelectTrigger: (id: string) => void;
  onCreateTrigger: () => void;
  subTabFocused?: boolean;
}

export function AutomationsTab({ db, engine, workspaceId, onSelectTrigger, onCreateTrigger, subTabFocused }: AutomationsTabProps) {
  const [subTab, setSubTab] = useState<SubTab>('triggers');

  const subTabs: SubTab[] = ['triggers', 'schedules', 'workflows'];

  useInput((_input, key) => {
    if (subTabFocused === false) return; // main tabs have focus
    if (key.leftArrow) {
      setSubTab(prev => {
        const idx = subTabs.indexOf(prev);
        return subTabs[(idx - 1 + subTabs.length) % subTabs.length];
      });
      return;
    }
    if (key.rightArrow) {
      setSubTab(prev => {
        const idx = subTabs.indexOf(prev);
        return subTabs[(idx + 1) % subTabs.length];
      });
      return;
    }
  });

  return (
    <Box flexDirection="column">
      {/* Sub-tab bar */}
      <Box>
        <Text color={subTab === 'triggers' ? 'cyan' : 'gray'} bold={subTab === 'triggers'}>
          Triggers
        </Text>
        <Text>  </Text>
        <Text color={subTab === 'schedules' ? 'cyan' : 'gray'} bold={subTab === 'schedules'}>
          Schedules
        </Text>
        <Text>  </Text>
        <Text color={subTab === 'workflows' ? 'cyan' : 'gray'} bold={subTab === 'workflows'}>
          Workflows
        </Text>
        <Text color="gray">  ←/→</Text>
      </Box>

      {/* Sub-tab content */}
      <Box marginTop={1} flexDirection="column">
        {subTab === 'triggers' && (
          <Automations
            db={db}
            onBack={() => {}}
            onSelectTrigger={onSelectTrigger}
            onCreateTrigger={onCreateTrigger}
            embedded
          />
        )}
        {subTab === 'schedules' && (
          <Schedules
            db={db}
            onBack={() => {}}
            embedded
          />
        )}
        {subTab === 'workflows' && (
          <Workflows
            db={db}
            engine={engine}
            workspaceId={workspaceId}
            onBack={() => {}}
            embedded
          />
        )}
      </Box>
    </Box>
  );
}
