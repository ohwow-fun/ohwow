/**
 * Eternal Systems — default EternalSpec.
 *
 * Conservative defaults any operator gets before configuring eternal settings.
 * Seven days to conservative mode mirrors a typical "away for a week" scenario.
 * Ninety days to estate is a generous runway before the system assumes the
 * operator cannot return.
 */
import type { EternalSpec } from './types.js';

export const DEFAULT_ETERNAL_SPEC: EternalSpec = {
  inactivityProtocol: {
    conservativeAfterDays: 7,
    trusteePingAfterDays: 7,
    estateAfterDays: 90,
  },
  escalationMap: [
    {
      decisionType: 'outreach',
      automatedBelow: undefined,
      requiresTrustee: false,
    },
    {
      decisionType: 'expense_small',
      automatedBelow: 50,
      requiresTrustee: false,
    },
    {
      decisionType: 'expense_large',
      automatedBelow: undefined,
      requiresTrustee: true,
    },
    {
      decisionType: 'strategic',
      automatedBelow: undefined,
      requiresTrustee: true,
    },
  ],
  contactSlaDays: {
    customer: 30,
    partner: 14,
    lead: 21,
    other: 60,
  },
};
