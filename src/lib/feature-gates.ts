/**
 * Feature Gates
 * All local features are free. Cloud features require a connected tier.
 * Plan-specific enforcement (device limits, webhook limits, etc.) happens
 * on the cloud side, not in the runtime.
 */

import type { RuntimeTier } from '../config.js';

/** Whether the runtime has cloud connectivity (any paid plan). */
export function isCloudConnected(tier: RuntimeTier): boolean {
  return tier !== 'free';
}

/** Cloud features available when connected. Shown to free users as upgrade prompts. */
export const CLOUD_FEATURES = [
  { feature: 'cloud_dashboard', label: 'Cloud Dashboard', description: 'Manage your workspace from ohwow.fun' },
  { feature: 'cloud_sync', label: 'Cloud Sync', description: 'Sync with the ohwow.fun dashboard' },
  { feature: 'cloud_tasks', label: 'Cloud Tasks', description: 'Receive tasks dispatched from the cloud' },
  { feature: 'deferred_actions', label: 'OAuth Integrations', description: 'Gmail, Slack, and other OAuth-based integrations' },
  { feature: 'heartbeats', label: 'Telemetry', description: 'Health monitoring and metrics' },
  { feature: 'webhook_relay', label: 'Webhook Relay', description: 'Cloud-proxied webhooks for external services' },
  { feature: 'api_access', label: 'API Access', description: 'Programmatic access to your workspace' },
  { feature: 'fleet_management', label: 'Device Management', description: 'Manage multiple devices' },
] as const;

/** Get cloud features to show in upgrade prompts (for free users). */
export function getLockedCloudFeatures(tier: RuntimeTier): Array<{ feature: string; label: string; description: string }> {
  if (isCloudConnected(tier)) return [];
  return [...CLOUD_FEATURES];
}

/** Nav items visibility — all screens always visible regardless of tier. */
export interface NavVisibility {
  dashboard: boolean;
  agents: boolean;
  tasks: boolean;
  approvals: boolean;
  activity: boolean;
  schedules: boolean;
  chat: boolean;
  settings: boolean;
}

export function getNavVisibility(_tier: RuntimeTier): NavVisibility {
  return {
    dashboard: true,
    agents: true,
    tasks: true,
    approvals: true,
    activity: true,
    schedules: true,
    chat: true,
    settings: true,
  };
}
