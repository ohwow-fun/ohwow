import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  selectApprovedDraft,
  markDraftConsumed,
  collectConsumedIds,
} from '../approved-draft-queue.js';

function tmpJsonl(lines: Array<Record<string, unknown>>): string {
  const p = path.join(os.tmpdir(), `approvals-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

describe('selectApprovedDraft', () => {
  it('returns null for a missing file', () => {
    expect(selectApprovedDraft(path.join(os.tmpdir(), 'does-not-exist.jsonl'))).toBeNull();
  });

  it('returns null when only pending rows exist', () => {
    const p = tmpJsonl([
      { id: 'a', ts: '2026-04-15T00:00:00Z', kind: 'x_outbound_post', status: 'pending', payload: { post_text: 'x' } },
    ]);
    expect(selectApprovedDraft(p)).toBeNull();
  });

  it('picks the oldest approved draft (FIFO fairness)', () => {
    const p = tmpJsonl([
      { id: 'newer', ts: '2026-04-16T10:00:00Z', kind: 'x_outbound_post', status: 'auto_applied', payload: { post_text: 'B' } },
      { id: 'older', ts: '2026-04-15T10:00:00Z', kind: 'x_outbound_post', status: 'auto_applied', payload: { post_text: 'A' } },
    ]);
    const picked = selectApprovedDraft(p);
    expect(picked?.id).toBe('older');
    expect(picked?.text).toBe('A');
  });

  it('skips drafts whose notes mark them posted', () => {
    const p = tmpJsonl([
      { id: 'a', ts: '2026-04-15T00:00:00Z', kind: 'x_outbound_post', status: 'auto_applied', payload: { post_text: 'A' }, notes: 'applied: {"posted":true}' },
      { id: 'b', ts: '2026-04-16T00:00:00Z', kind: 'x_outbound_post', status: 'auto_applied', payload: { post_text: 'B' } },
    ]);
    const picked = selectApprovedDraft(p);
    expect(picked?.id).toBe('b');
  });

  it('skips drafts whose latest status is applied or rejected', () => {
    const p = tmpJsonl([
      { id: 'applied', ts: '2026-04-15T00:00:00Z', kind: 'x_outbound_post', status: 'applied', payload: { post_text: 'used' } },
      { id: 'rejected', ts: '2026-04-15T01:00:00Z', kind: 'x_outbound_post', status: 'rejected', payload: { post_text: 'no' } },
      { id: 'ok', ts: '2026-04-16T00:00:00Z', kind: 'x_outbound_post', status: 'approved', payload: { post_text: 'yes' } },
    ]);
    const picked = selectApprovedDraft(p);
    expect(picked?.id).toBe('ok');
  });

  it('filters by kind by default (ignores replies on the dispatcher path)', () => {
    const p = tmpJsonl([
      { id: 'reply', ts: '2026-04-15T00:00:00Z', kind: 'x_outbound_reply', status: 'auto_applied', payload: { post_text: 'r' } },
      { id: 'post', ts: '2026-04-16T00:00:00Z', kind: 'x_outbound_post', status: 'auto_applied', payload: { post_text: 'p' } },
    ]);
    const picked = selectApprovedDraft(p);
    expect(picked?.id).toBe('post');
  });

  it('falls back to payload.draft when post_text missing', () => {
    const p = tmpJsonl([
      { id: 'a', ts: '2026-04-15T00:00:00Z', kind: 'x_outbound_post', status: 'approved', payload: { draft: 'from draft' } },
    ]);
    const picked = selectApprovedDraft(p);
    expect(picked?.text).toBe('from draft');
  });

  it('respects last-write-wins when the same id appears multiple times', () => {
    const p = tmpJsonl([
      { id: 'x', ts: '2026-04-15T00:00:00Z', kind: 'x_outbound_post', status: 'pending', payload: { post_text: 'v1' } },
      { id: 'x', ts: '2026-04-16T00:00:00Z', kind: 'x_outbound_post', status: 'approved', payload: { post_text: 'v1' } },
      { id: 'x', ts: '2026-04-16T01:00:00Z', kind: 'x_outbound_post', status: 'rejected', payload: { post_text: 'v1' } },
    ]);
    // Rejected ⇒ consumed ⇒ not returned even though an earlier row said approved.
    expect(selectApprovedDraft(p)).toBeNull();
  });

  it('skips rows with empty post_text', () => {
    const p = tmpJsonl([
      { id: 'a', ts: '2026-04-15T00:00:00Z', kind: 'x_outbound_post', status: 'approved', payload: { post_text: '   ' } },
      { id: 'b', ts: '2026-04-16T00:00:00Z', kind: 'x_outbound_post', status: 'approved', payload: { post_text: 'real' } },
    ]);
    const picked = selectApprovedDraft(p);
    expect(picked?.id).toBe('b');
  });
});

describe('collectConsumedIds', () => {
  it('counts both applied/rejected rows and notes:posted:true as consumed', () => {
    const set = collectConsumedIds([
      { id: 'a', status: 'applied' },
      { id: 'b', status: 'rejected' },
      { id: 'c', status: 'approved', notes: 'applied: {"posted":true}' },
      { id: 'd', status: 'approved' },
    ]);
    expect(set.has('a')).toBe(true);
    expect(set.has('b')).toBe(true);
    expect(set.has('c')).toBe(true);
    expect(set.has('d')).toBe(false);
  });
});

describe('markDraftConsumed', () => {
  it('appends a row that selectApprovedDraft will skip next time', () => {
    const p = tmpJsonl([
      { id: 'target', ts: '2026-04-15T00:00:00Z', kind: 'x_outbound_post', status: 'approved', payload: { post_text: 'text' } },
    ]);
    expect(selectApprovedDraft(p)?.id).toBe('target');
    markDraftConsumed(p, 'target', 'task-123');
    expect(selectApprovedDraft(p)).toBeNull();
    const raw = fs.readFileSync(p, 'utf-8').trim().split('\n');
    const lastRow = JSON.parse(raw[raw.length - 1]);
    expect(lastRow.id).toBe('target');
    expect(lastRow.status).toBe('applied');
    expect(lastRow.notes).toContain('task-123');
  });
});
