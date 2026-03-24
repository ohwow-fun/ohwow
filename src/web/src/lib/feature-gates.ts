/**
 * Feature Gates (Web Dashboard)
 * All nav items are always visible regardless of tier.
 */

export type RuntimeTier = 'free' | 'connected';

export interface NavVisibility {
  approvals: boolean;
  schedules: boolean;
  connections: boolean;
}

export function getNavVisibility(_tier: RuntimeTier): NavVisibility {
  return {
    approvals: true,
    schedules: true,
    connections: true,
  };
}
