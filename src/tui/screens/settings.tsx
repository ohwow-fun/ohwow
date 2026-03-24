/**
 * Settings Screen
 * Coordinator with subtabs: General, Integrations, Stats.
 * Follows the automations-tab.tsx pattern for Q/W/E subtab switching.
 */

import React, { useState, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { updateConfigFile } from '../../config.js';
import type { RuntimeConfig } from '../../config.js';
import type { HealthMetrics } from '../types.js';
import { GeneralTab } from './settings/general-tab.js';
import { IntegrationsTab } from './settings/integrations-tab.js';
import { StatsTab } from './settings/stats-tab.js';
import { ResourcesTab } from './settings/resources-tab.js';

interface VoiceProviderInfo {
  name: string;
  label: string;
  available: boolean;
}

interface VoiceProvidersData {
  stt: VoiceProviderInfo[];
  tts: VoiceProviderInfo[];
  anyAvailable: boolean;
  voiceboxAvailable: boolean;
}

interface SettingsProps {
  config: RuntimeConfig;
  health: HealthMetrics;
  cloudConnected: boolean;
  whatsappStatus?: { status: string; phoneNumber: string | null };
  ollamaConnected?: boolean;
  ollamaModel?: string;
  modelReady?: boolean;
  tunnelUrl?: string | null;
  cloudWebhookBaseUrl?: string | null;
  voiceProviders?: VoiceProvidersData | null;
  voiceboxStarting?: boolean;
  voiceboxError?: string | null;
  subTabFocused?: boolean;
  globalMcpCount?: number;
  onMcpServers?: () => void;
  onConfigChange?: (config: RuntimeConfig) => void;
}

export function formatUptime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

type SubTab = 'general' | 'integrations' | 'stats' | 'resources';

export function Settings({ config, health, cloudConnected, whatsappStatus, ollamaConnected, ollamaModel, modelReady, tunnelUrl, cloudWebhookBaseUrl, voiceProviders, voiceboxStarting, voiceboxError, subTabFocused, globalMcpCount, onMcpServers, onConfigChange }: SettingsProps) {
  const [subTab, setSubTab] = useState<SubTab>('general');
  const [showQr, setShowQr] = useState(false);
  const toggling = useRef(false);

  const subTabs: SubTab[] = ['general', 'integrations', 'stats', 'resources'];

  useInput((input, key) => {
    if (subTabFocused === false) return; // main tabs have focus

    // Toggle Claude Code MCP server in Integrations tab
    if ((input === 'x' || input === 'X') && subTab === 'integrations') {
      if (toggling.current) return;
      toggling.current = true;
      const newEnabled = !config.mcpServerEnabled;
      updateConfigFile({ mcpServerEnabled: newEnabled });
      const setupPromise = newEnabled
        ? import('../../mcp-server/setup.js').then(m => m.enableClaudeCodeIntegration())
        : import('../../mcp-server/setup.js').then(m => m.disableClaudeCodeIntegration());
      setupPromise.catch(() => {}).finally(() => { toggling.current = false; });
      onConfigChange?.({ ...config, mcpServerEnabled: newEnabled });
      return;
    }

    // Toggle QR code display in General tab
    if ((input === 'q' || input === 'Q') && subTab === 'general') {
      setShowQr(prev => !prev);
      return;
    }

    // Toggle cost confirmation in General tab
    if ((input === 'c' || input === 'C') && subTab === 'general') {
      const newSkip = !config.skipMediaCostConfirmation;
      updateConfigFile({ skipMediaCostConfirmation: newSkip });
      fetch(`http://127.0.0.1:${config.port}/api/set-cost-confirmation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skip: newSkip }),
      }).catch(() => {});
      onConfigChange?.({ ...config, skipMediaCostConfirmation: newSkip });
      return;
    }

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
      <Text bold>Settings</Text>

      {/* Sub-tab bar */}
      <Box marginTop={1}>
        <Text color={subTab === 'general' ? 'cyan' : 'gray'} bold={subTab === 'general'}>
          General
        </Text>
        <Text>  </Text>
        <Text color={subTab === 'integrations' ? 'cyan' : 'gray'} bold={subTab === 'integrations'}>
          Integrations
        </Text>
        <Text>  </Text>
        <Text color={subTab === 'stats' ? 'cyan' : 'gray'} bold={subTab === 'stats'}>
          Stats
        </Text>
        <Text>  </Text>
        <Text color={subTab === 'resources' ? 'cyan' : 'gray'} bold={subTab === 'resources'}>
          Resources
        </Text>
        <Text color="gray">  ←/→</Text>
      </Box>

      {/* Sub-tab content */}
      <Box marginTop={1} flexDirection="column">
        {subTab === 'general' && (
          <GeneralTab
            config={config}
            health={health}
            cloudConnected={cloudConnected}
            showQr={showQr}
          />
        )}
        {subTab === 'integrations' && (
          <IntegrationsTab
            config={config}
            whatsappStatus={whatsappStatus}
            ollamaConnected={ollamaConnected}
            ollamaModel={ollamaModel}
            modelReady={modelReady}
            tunnelUrl={tunnelUrl}
            cloudWebhookBaseUrl={cloudWebhookBaseUrl}
            voiceProviders={voiceProviders}
            voiceboxStarting={voiceboxStarting}
            voiceboxError={voiceboxError}
            globalMcpCount={globalMcpCount}
            onMcpServers={onMcpServers}
            onClaudeCodeToggle={() => {}}
          />
        )}
        {subTab === 'stats' && (
          <StatsTab health={health} />
        )}
        {subTab === 'resources' && (
          <ResourcesTab port={config.port} />
        )}
      </Box>
    </Box>
  );
}
