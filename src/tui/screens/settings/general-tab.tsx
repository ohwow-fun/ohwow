/**
 * General Settings Subtab
 * Tier badge, Connection, License, API, Runtime, Navigation, Upgrade prompt.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { RuntimeConfig } from '../../../config.js';
import type { HealthMetrics } from '../../types.js';
import { formatUptime } from '../settings.js';

interface GeneralTabProps {
  config: RuntimeConfig;
  health: HealthMetrics;
  cloudConnected: boolean;
  showQr?: boolean;
}

export function GeneralTab({ config, health, cloudConnected, showQr }: GeneralTabProps) {
  const isConnected = config.tier !== 'free';
  const tierLabel = config.tier === 'free'
    ? 'Local'
    : config.planName
      ? config.planName.charAt(0).toUpperCase() + config.planName.slice(1)
      : 'Connected';

  return (
    <Box flexDirection="column">
      {/* Tier badge */}
      <Box>
        <Text>
          {'  Tier:       '}
          <Text color={isConnected ? 'green' : 'cyan'} bold>
            {tierLabel}
          </Text>
        </Text>
      </Box>

      {/* Connected: Cloud connection info */}
      {isConnected && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">Cloud Connection</Text>
          <Text>  Cloud URL:  <Text color="gray">{config.cloudUrl}</Text></Text>
          <Text>  Status:     <Text color={cloudConnected ? 'green' : 'red'}>{cloudConnected ? 'Connected' : 'Offline'}</Text></Text>
          <Text>  Local URL:  <Text color="gray">{config.localUrl}</Text></Text>
          <Text>  Port:       <Text color="gray">{config.port}</Text></Text>
          <Text color="gray">{'  Press '}<Text bold color="white">q</Text>{' to show QR code for mobile access'}</Text>
        </Box>
      )}

      {/* QR code for mobile access */}
      {isConnected && cloudConnected && showQr && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">Open on Phone</Text>
          <Text color="gray">  Scan to open the dashboard on your phone:</Text>
          <MobileQrCode url={config.cloudUrl} />
          <Text color="gray">  {config.cloudUrl}</Text>
          <Text color="gray">{'  Press '}<Text bold color="white">q</Text>{' to hide'}</Text>
        </Box>
      )}

      {/* Connected: License */}
      {isConnected && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">License</Text>
          <Text>  Key:        <Text color="gray">{config.licenseKey.slice(0, 8)}{'*'.repeat(Math.max(0, config.licenseKey.length - 8))}</Text></Text>
        </Box>
      )}

      {/* API keys (always visible, BYOK) */}
      {config.anthropicApiKey && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">API</Text>
          <Text>  Anthropic:  <Text color="gray">{config.anthropicApiKey.slice(0, 12)}...</Text></Text>
        </Box>
      )}

      {/* Runtime info (all tiers) */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="cyan">Runtime</Text>
        <Text>  Uptime:     <Text color="gray">{formatUptime(health.uptime)}</Text></Text>
        <Text>  Memory:     <Text color="gray">{health.memoryPercent}%</Text></Text>
        <Text>  DB Path:    <Text color="gray">{config.dbPath}</Text></Text>
        <Text>  Port:       <Text color="gray">{config.port}</Text></Text>
      </Box>

      {/* Media */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="cyan">Media</Text>
        <Text>
          {'  Cost Confirm: '}
          <Text color={config.skipMediaCostConfirmation ? 'yellow' : 'green'}>
            {config.skipMediaCostConfirmation ? 'Skipped' : 'Enabled'}
          </Text>
          <Text color="gray">  (press </Text><Text bold color="white">c</Text><Text color="gray"> to toggle)</Text>
        </Text>
      </Box>

      {/* Navigation (always visible) */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="cyan">Navigation</Text>
        <Text color="gray">{'  Press '}<Text bold color="white">a</Text>{' for A2A, '}<Text bold color="white">l</Text>{' for plans, '}<Text bold color="white">i</Text>{' for notifications, '}<Text bold color="white">u</Text>{' for tunnel'}</Text>
      </Box>

      {/* Free tier: connect to cloud prompt */}
      {!isConnected && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
          <Text bold color="cyan">Connect to ohwow.fun</Text>
          <Text color="gray">
            Get cloud sync, cloud task dispatch, OAuth integrations
            (Gmail, Slack), webhook relay, and the cloud dashboard.
          </Text>
          <Box marginTop={1}>
            <Text color="gray">Visit <Text color="cyan" bold>ohwow.fun</Text> to get a license key.</Text>
          </Box>
          <Box>
            <Text color="gray">Press <Text bold color="white">l</Text> to enter a license key.</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

/**
 * Renders a QR code in the terminal for mobile dashboard access.
 * Reuses the same qrcode-terminal pattern from whatsapp.tsx.
 */
function MobileQrCode({ url }: { url: string }) {
  const [qrText, setQrText] = useState<string | null>(null);

  useEffect(() => {
    import('qrcode-terminal').then((mod) => {
      const qrModule = mod.default || mod;
      qrModule.generate(url, { small: true }, (text: string) => {
        setQrText(text);
      });
    }).catch(() => {
      setQrText(null);
    });
  }, [url]);

  if (!qrText) return <Text color="gray">  Generating QR code...</Text>;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {qrText.split('\n').map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
}
