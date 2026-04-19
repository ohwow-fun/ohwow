/**
 * SYNC_REGISTRY ↔ cloud-schema agreement pin.
 *
 * Trio 4 just landed (2026-04-18) — porting the x-intel + content engine
 * tables (posted_log, x_post_drafts, x_reply_drafts, x_dm_threads,
 * x_dm_messages, x_dm_observations) to cloud and registering them in
 * SYNC_REGISTRY alongside the autonomy-retrofit + founder_inbox entries
 * from Trios 2-3. This test bakes in the cloud-schema column lists for
 * all 11 tables and asserts the registry's `columns` arrays line up.
 *
 * Drift catches in two directions:
 *
 *   1. Registry references a column that doesn't exist cloud-side: the
 *      sync script would blow up at INSERT time against a live database.
 *      The test fails first, in CI, with a clear message.
 *
 *   2. A new cloud table ships without a SYNC_REGISTRY entry: the test
 *      fails until both halves move together.
 *
 * When Trio 5 closes the arc, KNOWN_CLOUD_SCHEMAS MUST be updated
 * alongside any new SYNC_REGISTRY edit and the cloud migration.
 * Three-way lockstep is the point.
 */

import { describe, expect, it } from 'vitest';
import { SYNC_REGISTRY } from '../registry.js';

/**
 * Snapshot of the cloud schema for every table currently in SYNC_REGISTRY.
 * Keep alphabetical. When you add a new entry to SYNC_REGISTRY, add the
 * matching cloud column list here at the same time.
 */
const KNOWN_CLOUD_SCHEMAS: Record<string, readonly string[]> = {
  director_arcs: [
    'id',
    'workspace_id',
    'opened_at',
    'closed_at',
    'mode_of_invocation',
    'thesis',
    'status',
    'budget_max_phases',
    'budget_max_minutes',
    'budget_max_inbox_qs',
    'kill_on_pulse_regression',
    'pulse_at_entry',
    'pulse_at_close',
    'exit_reason',
  ],
  director_phase_reports: [
    'id',
    'arc_id',
    'workspace_id',
    'phase_id',
    'mode',
    'goal',
    'status',
    'trios_run',
    'runtime_sha_start',
    'runtime_sha_end',
    'cloud_sha_start',
    'cloud_sha_end',
    'delta_pulse_json',
    'delta_ledger',
    'inbox_added',
    'remaining_scope',
    'next_phase_recommendation',
    'cost_trios',
    'cost_minutes',
    'cost_llm_cents',
    'raw_report',
    'started_at',
    'ended_at',
  ],
  founder_inbox: [
    'id',
    'workspace_id',
    'arc_id',
    'phase_id',
    'mode',
    'blocker',
    'context',
    'options_json',
    'recommended',
    'screenshot_path',
    'asked_at',
    'answered_at',
    'answer',
    'status',
  ],
  phase_rounds: [
    'id',
    'trio_id',
    'kind',
    'status',
    'summary',
    'findings_written',
    'commits',
    'evaluation_json',
    'raw_return',
    'started_at',
    'ended_at',
  ],
  phase_trios: [
    'id',
    'phase_id',
    'workspace_id',
    'mode',
    'outcome',
    'started_at',
    'ended_at',
  ],
  posted_log: [
    'id',
    'workspace_id',
    'platform',
    'text_hash',
    'text_preview',
    'text_length',
    'posted_at',
    'approval_id',
    'task_id',
    'source',
  ],
  x_dm_messages: [
    'id',
    'workspace_id',
    'conversation_pair',
    'message_id',
    'direction',
    'text',
    'is_media',
    'observed_at',
  ],
  x_dm_observations: [
    'id',
    'workspace_id',
    'conversation_pair',
    'primary_name',
    'preview_text',
    'preview_hash',
    'has_unread',
    'observed_at',
  ],
  x_dm_threads: [
    'id',
    'workspace_id',
    'conversation_pair',
    'primary_name',
    'last_preview',
    'last_preview_hash',
    'has_unread',
    'observation_count',
    'first_seen_at',
    'last_seen_at',
    'raw_meta',
    'last_message_id',
    'last_message_text',
    'last_message_direction',
    'counterparty_user_id',
    'contact_id',
  ],
  x_post_drafts: [
    'id',
    'workspace_id',
    'body',
    'source_finding_id',
    'status',
    'created_at',
    'approved_at',
    'rejected_at',
  ],
  x_reply_drafts: [
    'id',
    'workspace_id',
    'platform',
    'reply_to_url',
    'reply_to_author',
    'reply_to_text',
    'reply_to_likes',
    'reply_to_replies',
    'mode',
    'body',
    'alternates_json',
    'verdict_json',
    'score',
    'status',
    'created_at',
    'approved_at',
    'rejected_at',
    'applied_at',
  ],
};

describe('SYNC_REGISTRY ↔ cloud schema agreement', () => {
  it('every SYNC_REGISTRY entry has a corresponding KNOWN_CLOUD_SCHEMAS key', () => {
    for (const entry of SYNC_REGISTRY) {
      expect(KNOWN_CLOUD_SCHEMAS[entry.table]).toBeDefined();
    }
  });

  it('every KNOWN_CLOUD_SCHEMAS key has a corresponding SYNC_REGISTRY entry', () => {
    const registeredTables = new Set(SYNC_REGISTRY.map((s) => s.table));
    for (const knownTable of Object.keys(KNOWN_CLOUD_SCHEMAS)) {
      expect(registeredTables.has(knownTable)).toBe(true);
    }
  });

  it('every column in each entry exists in the matching cloud schema', () => {
    for (const entry of SYNC_REGISTRY) {
      const cloudColumns = KNOWN_CLOUD_SCHEMAS[entry.table];
      if (!cloudColumns) continue; // first test catches this case
      const cloudSet = new Set(cloudColumns);
      for (const col of entry.columns) {
        expect(cloudSet.has(col)).toBe(true);
      }
    }
  });

  it('every entry primaryKey exists in the cloud schema', () => {
    for (const entry of SYNC_REGISTRY) {
      const cloudColumns = KNOWN_CLOUD_SCHEMAS[entry.table];
      if (!cloudColumns) continue;
      expect(cloudColumns).toContain(entry.primaryKey);
    }
  });
});
