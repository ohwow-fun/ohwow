/**
 * SYNC_REGISTRY ↔ cloud-schema agreement pin.
 *
 * Trio 3 of the 5-trio sync arc (2026-04-18) ported the autonomy-retrofit
 * tables (director_arcs, phase_trios, phase_rounds, director_phase_reports)
 * to cloud and registered them in SYNC_REGISTRY alongside the founder_inbox
 * entry from Trio 2. This test bakes in the cloud-schema column lists
 * for those 5 tables and asserts the registry's `columns` arrays line up.
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
 * When Trios 4-5 add x-intel + content-engine tables, KNOWN_CLOUD_SCHEMAS
 * MUST be updated alongside the SYNC_REGISTRY edit and the cloud
 * migration. Three-way lockstep is the point.
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
