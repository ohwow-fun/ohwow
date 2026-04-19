import type { ModeLens } from './types.js';

/**
 * Revenue lens — distilled from
 * `.claude/skills/be-ohwow/briefs/revenue.md`. Tables / verbs / families
 * mirror the spec's "Mode lenses" table verbatim.
 */
export const revenueLens: ModeLens = {
  mode: 'revenue',
  description:
    'Execute one pipeline move: fire an approval, send a queued DM, advance a rotting deal, or reach a qualified lead.',
  plan_brief_preamble: [
    'MODE: revenue. Pick exactly ONE pipeline move; never batch.',
    'Allowed moves: fire/refine an approval; advance a rotting deal via stage change; draft outreach (always through the approval queue, never cold).',
    'Voice: observer/philosophical, humor preferred, never reveal product.',
    'Code edits are not the goal here; if a helper edit is required, stop and re-route as plumbing/tooling.',
    'QA verifies via read-only MCP (ohwow_list_approvals, ohwow_list_x_drafts, ohwow_list_deals) and logs the outcome to progress/revenue.md.',
  ].join('\n'),
  // X channel permanently banned 2026-04-19 — account suspended for automated behavior.
  // x_post_drafts, x_reply_drafts, x_dm_drafts removed from tables;
  // ohwow_approve_x_draft and ohwow_approve_x_reply_draft removed from mcp_verbs.
  tables: [
    'deals',
    'deal_stages',
    'agent_workforce_contacts',
    'approvals',
  ],
  mcp_verbs: [
    'ohwow_list_approvals',
    'ohwow_preview_approval',
    'ohwow_update_deal',
    'ohwow_pipeline_summary',
    'ohwow_revenue_summary',
  ],
  experiment_families: [
    'attribution-observer',
    'contact-conversation-analyst',
    'agent-outcomes',
    'next-step-dispatcher',
    'burn-rate',
    'burn-guard',
  ],
};
