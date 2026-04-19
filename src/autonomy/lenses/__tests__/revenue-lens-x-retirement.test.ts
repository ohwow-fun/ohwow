/**
 * Criterion 4: revenue lens X tables and verbs removed.
 *
 * 2026-04-19: X account permanently banned. The revenue lens must not
 * reference X draft tables or X-specific MCP verbs that no longer exist.
 *
 * Pinned assertions (frozen — any regression here is a bug, not a test gap):
 *   - tables: x_post_drafts, x_reply_drafts, x_dm_drafts must be absent
 *   - mcp_verbs: ohwow_approve_x_draft, ohwow_draft_x_dm must be absent
 *   - mcp_verbs: ohwow_approve_x_reply_draft must be absent
 */

import { describe, it, expect } from 'vitest';
import { revenueLens } from '../revenue.js';

describe('revenueLens — X deprecation (criterion 4)', () => {
  describe('tables', () => {
    it('does not include x_post_drafts', () => {
      expect(revenueLens.tables).not.toContain('x_post_drafts');
    });

    it('does not include x_reply_drafts', () => {
      expect(revenueLens.tables).not.toContain('x_reply_drafts');
    });

    it('does not include x_dm_drafts', () => {
      expect(revenueLens.tables).not.toContain('x_dm_drafts');
    });
  });

  describe('mcp_verbs', () => {
    it('does not include ohwow_approve_x_draft', () => {
      expect(revenueLens.mcp_verbs).not.toContain('ohwow_approve_x_draft');
    });

    it('does not include ohwow_draft_x_dm', () => {
      expect(revenueLens.mcp_verbs).not.toContain('ohwow_draft_x_dm');
    });

    it('does not include ohwow_approve_x_reply_draft', () => {
      expect(revenueLens.mcp_verbs).not.toContain('ohwow_approve_x_reply_draft');
    });
  });

  describe('retained entries (sanity)', () => {
    it('still includes core deal pipeline tables', () => {
      expect(revenueLens.tables).toContain('deals');
      expect(revenueLens.tables).toContain('approvals');
    });

    it('still includes core pipeline verbs', () => {
      expect(revenueLens.mcp_verbs).toContain('ohwow_list_approvals');
      expect(revenueLens.mcp_verbs).toContain('ohwow_pipeline_summary');
      expect(revenueLens.mcp_verbs).toContain('ohwow_revenue_summary');
    });
  });
});
