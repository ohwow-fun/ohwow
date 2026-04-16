import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  listApprovalsForKind,
  markApprovalApplied,
  proposeApproval,
  readApprovalRows,
  type ApprovalEntry,
} from '../approval-queue.js';

const WS = 'ws-approval-queue';

describe('approval-queue', () => {
  let dir: string;
  let jsonl: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ohwow-approval-queue-'));
    jsonl = join(dir, 'x-approvals.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('proposeApproval', () => {
    it('writes a pending entry when no prior history exists', () => {
      const entry = proposeApproval(jsonl, {
        kind: 'x_dm_outbound',
        workspace: WS,
        summary: 'Reply to Alice',
        payload: { conversation_pair: '1:2', text: 'Hello back' },
      });
      expect(entry.status).toBe('pending');
      expect(entry.trustStats?.priorApproved).toBe(0);
      expect(entry.trustStats?.priorRejected).toBe(0);

      const rows = readApprovalRows(jsonl);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(entry.id);
    });

    it('auto-applies once autoApproveAfter prior approvals accumulate and rejected=0', () => {
      for (let i = 0; i < 3; i++) {
        proposeApproval(jsonl, {
          kind: 'x_dm_outbound',
          workspace: WS,
          summary: `msg ${i}`,
          payload: { text: `t${i}` },
        });
      }
      // Simulate operator approving all three via the CLI: append
      // rows with the same id and status='approved' so the reader's
      // latest-by-id dedup picks the approved state.
      const rows = readApprovalRows(jsonl);
      const approveLines = rows.map((r) => ({
        ...r,
        status: 'approved' as const,
        ratedAt: new Date().toISOString(),
      }));
      appendFileSync(
        jsonl,
        approveLines.map((r) => JSON.stringify(r)).join('\n') + '\n',
      );

      const next = proposeApproval(jsonl, {
        kind: 'x_dm_outbound',
        workspace: WS,
        summary: 'fourth proposal',
        payload: { text: 'auto?' },
        autoApproveAfter: 3,
        maxPriorRejected: 0,
      });
      expect(next.status).toBe('auto_applied');
      expect(next.trustStats?.priorApproved).toBe(3);
      expect(next.trustStats?.priorRejected).toBe(0);
    });

    it('respects maxPriorRejected=0: one rejection blocks auto-apply even after threshold met', () => {
      const oldEntries: ApprovalEntry[] = [];
      for (let i = 0; i < 5; i++) {
        oldEntries.push({
          id: `approved-${i}`,
          ts: new Date(Date.now() - i * 1000).toISOString(),
          kind: 'x_dm_outbound',
          workspace: WS,
          summary: '',
          payload: {},
          status: 'approved',
        });
      }
      oldEntries.push({
        id: 'rejected-1',
        ts: new Date().toISOString(),
        kind: 'x_dm_outbound',
        workspace: WS,
        summary: '',
        payload: {},
        status: 'rejected',
      });
      writeFileSync(jsonl, oldEntries.map((e) => JSON.stringify(e)).join('\n') + '\n');

      const entry = proposeApproval(jsonl, {
        kind: 'x_dm_outbound',
        workspace: WS,
        summary: 'next',
        payload: { text: 'blocked by rejection' },
        autoApproveAfter: 3,
        maxPriorRejected: 0,
      });
      expect(entry.status).toBe('pending');
      expect(entry.trustStats?.priorApproved).toBe(5);
      expect(entry.trustStats?.priorRejected).toBe(1);
    });

    it('bucketBy scopes trust counts to the payload bucket', () => {
      const history: ApprovalEntry[] = [];
      for (let i = 0; i < 3; i++) {
        history.push({
          id: `humor-${i}`,
          ts: new Date(Date.now() - (10 - i) * 1000).toISOString(),
          kind: 'x_outbound_post',
          workspace: WS,
          summary: '',
          payload: { shape: 'humor' },
          status: 'approved',
        });
      }
      writeFileSync(jsonl, history.map((e) => JSON.stringify(e)).join('\n') + '\n');

      // Tactical tip has 0 prior approvals in its bucket → pending.
      const tactical = proposeApproval(jsonl, {
        kind: 'x_outbound_post',
        workspace: WS,
        summary: '',
        payload: { shape: 'tactical_tip' },
        autoApproveAfter: 3,
        maxPriorRejected: 0,
        bucketBy: 'shape',
      });
      expect(tactical.status).toBe('pending');

      // Humor has 3 prior approvals in bucket → auto_applied.
      const humor = proposeApproval(jsonl, {
        kind: 'x_outbound_post',
        workspace: WS,
        summary: '',
        payload: { shape: 'humor' },
        autoApproveAfter: 3,
        maxPriorRejected: 0,
        bucketBy: 'shape',
      });
      expect(humor.status).toBe('auto_applied');
    });

    it('fails closed when the gate throws', () => {
      const history: ApprovalEntry[] = [];
      for (let i = 0; i < 3; i++) {
        history.push({
          id: `a-${i}`,
          ts: new Date().toISOString(),
          kind: 'x_dm_outbound',
          workspace: WS,
          summary: '',
          payload: {},
          status: 'approved',
        });
      }
      writeFileSync(jsonl, history.map((e) => JSON.stringify(e)).join('\n') + '\n');

      const entry = proposeApproval(jsonl, {
        kind: 'x_dm_outbound',
        workspace: WS,
        summary: '',
        payload: { text: 'gated' },
        autoApproveAfter: 3,
        maxPriorRejected: 0,
        gate: () => { throw new Error('boom'); },
      });
      expect(entry.status).toBe('pending');
    });
  });

  describe('listApprovalsForKind', () => {
    it('returns approved + auto_applied entries oldest-first, filters by kind, skips applied', () => {
      const rows: ApprovalEntry[] = [
        { id: 'a', ts: '2026-04-10T10:00:00Z', kind: 'x_dm_outbound', workspace: WS, summary: '', payload: { text: 'first' }, status: 'approved' },
        { id: 'b', ts: '2026-04-11T10:00:00Z', kind: 'x_outbound_post', workspace: WS, summary: '', payload: {}, status: 'approved' },
        { id: 'c', ts: '2026-04-12T10:00:00Z', kind: 'x_dm_outbound', workspace: WS, summary: '', payload: { text: 'second' }, status: 'auto_applied' },
        { id: 'd', ts: '2026-04-13T10:00:00Z', kind: 'x_dm_outbound', workspace: WS, summary: '', payload: {}, status: 'pending' },
        { id: 'e', ts: '2026-04-14T10:00:00Z', kind: 'x_dm_outbound', workspace: WS, summary: '', payload: {}, status: 'rejected' },
      ];
      writeFileSync(jsonl, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const out = listApprovalsForKind(jsonl, 'x_dm_outbound');
      expect(out.map((e) => e.id)).toEqual(['a', 'c']);
    });

    it('treats an appended applied event as consumed (last-row-wins per id)', () => {
      const a: ApprovalEntry = {
        id: 'a', ts: '2026-04-10T10:00:00Z', kind: 'x_dm_outbound', workspace: WS,
        summary: '', payload: { text: 'once' }, status: 'approved',
      };
      writeFileSync(jsonl, JSON.stringify(a) + '\n');
      expect(listApprovalsForKind(jsonl, 'x_dm_outbound').map((e) => e.id)).toEqual(['a']);

      markApprovalApplied(jsonl, 'a', { posted: true, by: 'test' });
      expect(listApprovalsForKind(jsonl, 'x_dm_outbound')).toEqual([]);
    });

    it('returns empty when the file does not exist', () => {
      expect(listApprovalsForKind(jsonl, 'x_dm_outbound')).toEqual([]);
    });
  });

  describe('markApprovalApplied', () => {
    it('appends an applied row with JSON notes and does not touch prior rows', () => {
      const original: ApprovalEntry = {
        id: 'a', ts: '2026-04-10T10:00:00Z', kind: 'x_dm_outbound', workspace: WS,
        summary: '', payload: { text: 'hi' }, status: 'approved',
      };
      writeFileSync(jsonl, JSON.stringify(original) + '\n');
      markApprovalApplied(jsonl, 'a', { posted: true, by: 'dispatcher', message_id: 'outbound-xyz' });

      const content = readFileSync(jsonl, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual(original);
      const appended = JSON.parse(lines[1]);
      expect(appended.id).toBe('a');
      expect(appended.status).toBe('applied');
      expect(JSON.parse(appended.notes)).toEqual({
        posted: true, by: 'dispatcher', message_id: 'outbound-xyz',
      });
    });
  });
});
