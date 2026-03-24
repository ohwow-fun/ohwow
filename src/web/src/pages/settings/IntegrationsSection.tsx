import { useState, useCallback } from 'react';
import { useApi } from '../../hooks/useApi';
import { api } from '../../api/client';
import { toast } from '../../components/Toast';
import { Toggle } from '../../components/Toggle';
import { InfoRow } from './RuntimeSection';
import { McpServersSection } from '../agent/McpServersSection';
import type { McpServerConfig } from '../agent/McpServersSection';

interface NotificationChannels {
  email: boolean;
  slack: boolean;
  telegram: boolean;
  whatsapp: boolean;
}

export function IntegrationsSection() {

  const { data: tunnelData } = useApi<{ key: string; value: string } | null>('/api/settings/tunnel_url');
  const { data: cloudUrlData } = useApi<{ key: string; value: string } | null>('/api/settings/cloud_url');
  const { data: notifData, refetch: refetchNotif } = useApi<{ key: string; value: string } | null>('/api/settings/notification_channels');
  const { data: mcpData, refetch: refetchMcp } = useApi<{ key: string; value: string } | null>('/api/settings/global_mcp_servers');

  const tunnelUrl = tunnelData?.value;
  const [saving, setSaving] = useState(false);
  const [savingMcp, setSavingMcp] = useState(false);

  const globalMcpServers: McpServerConfig[] = (() => {
    try { return mcpData?.value ? (JSON.parse(mcpData.value) as McpServerConfig[]) : []; }
    catch { return []; }
  })();

  // Parse notification channels
  const channels: NotificationChannels = (() => {
    try {
      return notifData?.value ? JSON.parse(notifData.value) : { email: false, slack: false, telegram: false, whatsapp: false };
    } catch {
      return { email: false, slack: false, telegram: false, whatsapp: false };
    }
  })();

  const saveGlobalMcpServers = useCallback(async (servers: McpServerConfig[]) => {
    setSavingMcp(true);
    try {
      await api('/api/settings/global_mcp_servers', {
        method: 'PUT',
        body: JSON.stringify({ value: JSON.stringify(servers) }),
      });
      refetchMcp();
      toast('success', 'Global MCP servers updated');
    } catch {
      toast('error', 'Couldn\'t update MCP servers');
    } finally {
      setSavingMcp(false);
    }
  }, [refetchMcp]);

  const toggleChannel = useCallback(async (channel: keyof NotificationChannels) => {
    setSaving(true);
    const updated = { ...channels, [channel]: !channels[channel] };
    try {
      await api('/api/settings/notification_channels', {
        method: 'PUT',
        body: JSON.stringify({ value: JSON.stringify(updated) }),
      });
      refetchNotif();
      toast('success', `${channel} notifications ${updated[channel] ? 'enabled' : 'disabled'}`);
    } catch {
      toast('error', 'Couldn\'t update notification settings');
    } finally {
      setSaving(false);
    }
  }, [channels, refetchNotif]);

  return (
    <>
      {/* Webhooks / Tunnel */}
      <div className="mb-6">
        <h2 className="text-sm font-medium text-neutral-400 uppercase tracking-wider mb-3">Webhooks</h2>
        <div className="bg-white/5 border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
          <InfoRow
            label="Tunnel"
            value={tunnelUrl ? 'Active' : 'Not connected'}
            valueColor={tunnelUrl ? 'text-success' : 'text-neutral-400'}
          />
          {tunnelUrl && (
            <>
              <InfoRow label="URL" value={tunnelUrl} />
              <InfoRow label="GHL Hook" value={`${tunnelUrl}/webhooks/ghl`} />
            </>
          )}
          {!tunnelUrl && cloudUrlData?.value && (
            <InfoRow label="Cloud proxy" value={cloudUrlData.value} valueColor="text-success" />
          )}
        </div>
      </div>

      {/* Global MCP Servers */}
      <div className="mb-6">
        <h2 className="text-sm font-medium text-neutral-400 uppercase tracking-wider mb-1">MCP Servers</h2>
        <p className="text-xs text-neutral-400 mb-3">MCP servers extend what your AI team can do. Connect tools like GitHub, databases, or file systems.</p>
        <McpServersSection
          servers={globalMcpServers}
          onChange={saveGlobalMcpServers}
          disabled={savingMcp}
        />
      </div>

      {/* Notification channels */}
      <div className="mb-6">
        <h2 className="text-sm font-medium text-neutral-400 uppercase tracking-wider mb-3">Notifications</h2>
        <div className="bg-white/5 border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
          {(['email', 'slack', 'telegram', 'whatsapp'] as const).map(ch => (
            <div key={ch} className="flex items-center justify-between px-4 py-3">
              <span className="text-sm capitalize">{ch}</span>
              <Toggle
                checked={channels[ch]}
                onChange={() => toggleChannel(ch)}
                disabled={saving}
                size="sm"
              />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
