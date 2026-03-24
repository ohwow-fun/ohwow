/**
 * Integrations Settings Subtab
 * WhatsApp, Webhooks/Tunnel, Local Models (Ollama), Voice.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { RuntimeConfig } from '../../../config.js';
import { MODEL_CATALOG } from '../../../lib/ollama-models.js';

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

interface IntegrationsTabProps {
  config: RuntimeConfig;
  whatsappStatus?: { status: string; phoneNumber: string | null };
  ollamaConnected?: boolean;
  ollamaModel?: string;
  modelReady?: boolean;
  tunnelUrl?: string | null;
  cloudWebhookBaseUrl?: string | null;
  voiceProviders?: VoiceProvidersData | null;
  voiceboxStarting?: boolean;
  voiceboxError?: string | null;
  globalMcpCount?: number;
  onMcpServers?: () => void;
  onClaudeCodeToggle?: () => void;
}

export function IntegrationsTab({ config, whatsappStatus, ollamaConnected, ollamaModel, modelReady, tunnelUrl, cloudWebhookBaseUrl, voiceProviders, voiceboxStarting, voiceboxError, globalMcpCount, onMcpServers, onClaudeCodeToggle }: IntegrationsTabProps) {
  const activeModelTag = ollamaModel || config.ollamaModel;
  const catalogEntry = MODEL_CATALOG.find(m => m.tag === activeModelTag);
  const hasVision = catalogEntry?.vision ?? false;
  const hasApiKey = !!config.anthropicApiKey;

  return (
    <Box flexDirection="column">
      {/* WhatsApp (always visible) */}
      <Box flexDirection="column">
        <Text bold color="cyan">WhatsApp</Text>
          <Text>
            {'  Status:     '}
            <Text color={whatsappStatus?.status === 'connected' ? 'green' : whatsappStatus?.status === 'qr_pending' ? 'yellow' : 'gray'}>
              {whatsappStatus?.status || 'not initialized'}
            </Text>
          </Text>
          {whatsappStatus?.phoneNumber && (
            <Text>{'  Phone:      '}<Text color="gray">{whatsappStatus.phoneNumber}</Text></Text>
          )}
          <Text color="gray">{'  Press '}<Text bold color="white">p</Text>{' to manage WhatsApp'}</Text>
        </Box>

      {/* Webhooks / Tunnel */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="cyan">Webhooks</Text>
        {cloudWebhookBaseUrl ? (
          <>
            <Text>
              {'  Cloud Proxy: '}
              <Text color="green">Connected</Text>
            </Text>
            <Text>{'  GHL Hook:   '}<Text color="cyan">{cloudWebhookBaseUrl}/ghl</Text></Text>
          </>
        ) : (
          <>
            <Text>
              {'  Tunnel:     '}
              <Text color={tunnelUrl ? 'green' : 'gray'}>
                {tunnelUrl ? 'Active' : config.tunnelEnabled ? 'Starting...' : 'Disabled'}
              </Text>
            </Text>
            {tunnelUrl && (
              <>
                <Text>{'  URL:        '}<Text color="gray">{tunnelUrl}</Text></Text>
                <Text>{'  GHL Hook:   '}<Text color="gray">{tunnelUrl}/webhooks/ghl</Text></Text>
              </>
            )}
            {!tunnelUrl && !config.tunnelEnabled && (
              <Text color="gray">{'  Press '}<Text bold color="white">u</Text>{' to set up a tunnel'}</Text>
            )}
          </>
        )}
        <Text color="gray">{'  Press '}<Text bold color="white">g</Text>{' to view GHL webhook'}</Text>
      </Box>

      {/* Local Models (both tiers) */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="cyan">Local Models (Ollama)</Text>
        <Text>
          {'  Status:     '}
          <Text color={ollamaConnected && modelReady ? 'green' : ollamaConnected ? 'yellow' : 'gray'}>
            {ollamaConnected && modelReady
              ? 'Ready'
              : ollamaConnected
                ? 'Ollama running, model not downloaded'
                : 'Not running'}
          </Text>
        </Text>
        <Text>{'  URL:        '}<Text color="gray">{config.ollamaUrl}</Text></Text>
        <Text>{'  Model:      '}<Text color="gray">{activeModelTag}</Text></Text>
        <Text>
          {'  Vision:     '}
          {hasVision ? (
            <Text color="green">Yes</Text>
          ) : hasApiKey ? (
            <Text color="gray">No (image tasks use Claude)</Text>
          ) : (
            <Text color="gray">No</Text>
          )}
        </Text>
        <Text>{'  Orchestrator: '}<Text color="gray">{config.orchestratorModel || 'Auto (same as model)'}</Text></Text>
        <Text>{'  Preferred:  '}<Text color="gray">{config.preferLocalModel ? 'Yes' : 'No'}</Text></Text>
        <Text color="gray">{'  Press '}<Text bold color="white">m</Text>{' to manage models'}</Text>
        {!modelReady ? (
          <Text color="yellow">{'  Press '}<Text bold color="white">o</Text>{' to set up local AI'}</Text>
        ) : (
          <Text color="gray">{'  Press '}<Text bold color="white">o</Text>{' to set up local AI'}</Text>
        )}
      </Box>

      {/* Workspace Peers */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="cyan">Workspace Peers</Text>
        <Text color="gray">{'  Connect to other ohwow workspaces on your network'}</Text>
        <Text color="gray">{'  Press '}<Text bold color="white">r</Text>{' to manage peers'}</Text>
      </Box>

      {/* MCP Servers */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="cyan">MCP Servers</Text>
        <Text>
          {'  Configured: '}
          <Text color={globalMcpCount ? 'green' : 'gray'}>
            {globalMcpCount ? `${globalMcpCount} server${globalMcpCount === 1 ? '' : 's'}` : 'none'}
          </Text>
        </Text>
        {onMcpServers && (
          <Text color="gray">{'  Press '}<Text bold color="white">c</Text>{' to manage global MCP servers'}</Text>
        )}
      </Box>

      {/* Claude Code Integration */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="cyan">Claude Code</Text>
        <Text>
          {'  MCP Server: '}
          <Text color={config.mcpServerEnabled ? 'green' : 'gray'}>
            {config.mcpServerEnabled ? 'Enabled' : 'Disabled'}
          </Text>
        </Text>
        {config.mcpServerEnabled ? (
          <Text color="gray">{'  Claude Code can use your agents and orchestrator'}</Text>
        ) : (
          <Text color="gray">{'  Let Claude Code access your OHWOW workspace'}</Text>
        )}
        {onClaudeCodeToggle && (
          <Text color="gray">
            {'  Press '}<Text bold color="white">x</Text>
            {config.mcpServerEnabled ? ' to disable' : ' to enable'}
          </Text>
        )}
      </Box>

      {/* Voice */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="cyan">Voice</Text>
        {voiceboxError && (
          <Text color="red">{'  ✗ '}{voiceboxError}</Text>
        )}
        {voiceboxStarting && (
          <Text color="yellow">{'  ◉ Starting Voicebox...'}</Text>
        )}
        {voiceProviders ? (
          <>
            {voiceProviders.stt.map(p => (
              <Text key={p.name}>
                {'  STT: '}
                <Text color={p.available ? 'green' : 'gray'}>
                  {p.available ? '●' : '○'} {p.label}
                </Text>
              </Text>
            ))}
            {voiceProviders.tts.map(p => (
              <Text key={p.name}>
                {'  TTS: '}
                <Text color={p.available ? 'green' : 'gray'}>
                  {p.available ? '●' : '○'} {p.label}
                </Text>
              </Text>
            ))}
            {!voiceProviders.voiceboxAvailable && !voiceboxStarting && (
              <Text color="gray">{'  Press '}<Text bold color="white">v</Text>{' to enable Voicebox'}</Text>
            )}
          </>
        ) : (
          <>
            <Text>{'  Status:     '}<Text color="gray">Checking...</Text></Text>
            {!voiceboxStarting && (
              <Text color="gray">{'  Press '}<Text bold color="white">v</Text>{' to enable Voicebox'}</Text>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}
