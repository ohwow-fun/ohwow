import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { useTier } from '../hooks/useTier';
import { PageHeader } from '../components/PageHeader';
import { clearToken } from '../api/client';
import { useNavigate, NavLink } from 'react-router-dom';
import { RuntimeSection, InfoRow, formatUptime, type HealthData } from './settings/RuntimeSection';
import { IntegrationsSection } from './settings/IntegrationsSection';
import { ModelSection } from './settings/ModelSection';
import { VoiceSection } from './settings/VoiceSection';

const CLOUD_FEATURES = [
  'Cloud sync across devices',
  'Cloud task dispatch',
  'OAuth integrations (Gmail, Slack)',
  'Webhook relay',
  'Cloud dashboard at ohwow.fun',
  'Team management',
];

type SettingsTab = 'general' | 'integrations' | 'models';

export function SettingsPage() {
  const { tier, loading: tierLoading } = useTier();
  const navigate = useNavigate();
  const [tab, setTab] = useState<SettingsTab>('general');

  const isConnected = tier !== 'free';

  // Runtime health (cached by useApi, shared with RuntimeSection)
  const { data: health } = useApi<HealthData>('/health');

  // Connected settings from runtime_settings
  const { data: licenseData } = useApi<{ key: string; value: string } | null>('/api/settings/license_key');
  const { data: cloudUrlData } = useApi<{ key: string; value: string } | null>('/api/settings/cloud_url');

  const handleLogout = () => {
    clearToken();
    navigate('/login', { replace: true });
  };

  const maskedKey = (val: string | undefined | null, showLen = 8) => {
    if (!val) return 'Not set';
    return val.slice(0, showLen) + '\u2022'.repeat(Math.max(0, Math.min(val.length - showLen, 20)));
  };

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader title="Settings" subtitle="Runtime configuration" />

      {/* Tier badge */}
      {!tierLoading && (
        <div className="mb-6">
          <span data-testid="runtime-settings-tier-badge" className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold ${
            isConnected
              ? 'bg-success/15 text-success'
              : 'bg-cyan-500/15 text-cyan-400'
          }`}>
            {isConnected ? 'Connected' : 'Local'}
          </span>
        </div>
      )}

      {/* Compact runtime status */}
      {health && (
        <div className="mb-2 text-xs text-neutral-400">
          <span className={health.status === 'healthy' ? 'text-success' : 'text-warning'}>●</span>
          {' '}Connected · Running on v{health.version} · Up {formatUptime(health.uptime)}
        </div>
      )}

      {/* Tab switcher */}
      <div className="flex gap-1 mb-6 border-b border-white/[0.08]">
        {([
          { key: 'general' as const, label: 'General' },
          { key: 'integrations' as const, label: 'Integrations' },
          { key: 'models' as const, label: 'Models' },
        ]).map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              tab === t.key ? 'border-white text-white' : 'border-transparent text-neutral-400 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* General tab */}
      {tab === 'general' && (
        <>
          {/* Connected: Cloud connection info */}
          {isConnected && !tierLoading && (
            <div className="mb-6">
              <h2 className="text-sm font-medium text-neutral-400 uppercase tracking-wider mb-3">Connection</h2>
              <div className="bg-white/5 border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
                <InfoRow label="Cloud URL" value={cloudUrlData?.value || 'Not configured'} />
                <InfoRow label="Status" value="Connected" valueColor="text-success" />
                <InfoRow label="License key" value={maskedKey(licenseData?.value)} />
              </div>
            </div>
          )}

          <RuntimeSection />

          {/* Quick links */}
          {(
            <div className="mb-6">
              <h2 className="text-sm font-medium text-neutral-400 uppercase tracking-wider mb-3">Quick links</h2>
              <div className="flex gap-2 flex-wrap">
                <NavLink
                  to="/connections"
                  className="px-3 py-1.5 text-xs font-medium bg-white/5 border border-white/[0.08] rounded-lg hover:border-white/20 transition-colors"
                >
                  A2A Connections
                </NavLink>
                <NavLink
                  to="/schedules"
                  className="px-3 py-1.5 text-xs font-medium bg-white/5 border border-white/[0.08] rounded-lg hover:border-white/20 transition-colors"
                >
                  Schedules
                </NavLink>
                <NavLink
                  to="/automations"
                  className="px-3 py-1.5 text-xs font-medium bg-white/5 border border-white/[0.08] rounded-lg hover:border-white/20 transition-colors"
                >
                  Automations
                </NavLink>
              </div>
            </div>
          )}

          {/* Connect to cloud CTA */}
          {!isConnected && !tierLoading && (
            <div data-testid="runtime-settings-upgrade-cta" className="mb-6 bg-white/[0.02] border border-white/[0.08] rounded-lg p-5">
              <h3 className="text-sm font-semibold text-white mb-2">Connect to ohwow.fun cloud</h3>
              <p className="text-xs text-neutral-400 mb-4">
                Add cloud features to your local runtime:
              </p>
              <ul className="space-y-1.5 mb-4">
                {CLOUD_FEATURES.map(feature => (
                  <li key={feature} className="flex items-center gap-2 text-xs text-neutral-400">
                    <span className="text-white">+</span>
                    {feature}
                  </li>
                ))}
              </ul>
              <a
                data-testid="runtime-settings-upgrade-link"
                href="https://ohwow.fun"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center px-3 py-1.5 text-xs font-medium bg-white text-black rounded-md hover:bg-neutral-200 transition-colors"
              >
                Get a license key
              </a>
            </div>
          )}

          <div className="mb-6">
            <button
              onClick={handleLogout}
              className="px-4 py-2 text-sm text-critical border border-critical/30 rounded-lg hover:bg-critical/10 transition-colors"
            >
              Disconnect
            </button>
          </div>
        </>
      )}

      {/* Integrations tab */}
      {tab === 'integrations' && <IntegrationsSection />}

      {/* Models tab */}
      {tab === 'models' && <ModelSection />}

      {/* Voice is always visible in integrations */}
      {tab === 'integrations' && <VoiceSection />}
    </div>
  );
}
