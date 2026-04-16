import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  hashFilePaths,
  normalizeHashPath,
  recordProposedPatch,
  updateAttemptOutcome,
  markCommitReverted,
  hasRecentlyRevertedPatch,
  recentRevertedAttempts,
} from '../patches-attempted-log.js';

type Row = Record<string, unknown>;

/**
 * In-memory adapter stub: holds one table's rows, supports
 * insert/update/select with .eq/.gte/.in/.order/.limit. Close enough
 * to the real sqlite-adapter to exercise the helper's behavior
 * without spinning a real DB.
 */
function buildDb(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  function makeBuilder() {
    const filters: Array<{ col: string; op: 'eq' | 'gte' | 'in'; val: unknown }> = [];
    let limitN: number | null = null;
    let orderCol: string | null = null;
    let orderAsc = true;
    let updatePayload: Record<string, unknown> | null = null;

    const matches = (row: Row) =>
      filters.every((f) => {
        if (f.op === 'eq') return row[f.col] === f.val;
        if (f.op === 'gte') return String(row[f.col] ?? '') >= String(f.val);
        if (f.op === 'in') return Array.isArray(f.val) && (f.val as unknown[]).includes(row[f.col]);
        return true;
      });

    const applyRead = () => {
      let out = rows.filter(matches);
      if (orderCol) {
        out = [...out].sort((a, b) =>
          orderAsc
            ? String(a[orderCol!] ?? '').localeCompare(String(b[orderCol!] ?? ''))
            : String(b[orderCol!] ?? '').localeCompare(String(a[orderCol!] ?? '')),
        );
      }
      if (limitN !== null) out = out.slice(0, limitN);
      return out;
    };

    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => { filters.push({ col, op: 'eq', val }); return builder; };
    builder.gte = (col: string, val: unknown) => { filters.push({ col, op: 'gte', val }); return builder; };
    builder.in = (col: string, vals: unknown[]) => { filters.push({ col, op: 'in', val: vals }); return builder; };
    builder.order = (col: string, opts: { ascending: boolean }) => {
      orderCol = col;
      orderAsc = opts.ascending;
      return builder;
    };
    builder.limit = (n: number) => {
      limitN = n;
      return Promise.resolve({ data: applyRead(), error: null });
    };
    builder.then = (resolve: (v: unknown) => void) => {
      if (updatePayload !== null) {
        for (const row of rows) {
          if (matches(row)) Object.assign(row, updatePayload);
        }
        resolve({ data: null, error: null });
        return;
      }
      resolve({ data: applyRead(), error: null });
    };
    builder.insert = (row: Row) => {
      const uniqueKey = JSON.stringify([row.workspace_id, row.finding_id, row.file_paths_hash]);
      const dup = rows.find(
        (r) => JSON.stringify([r.workspace_id, r.finding_id, r.file_paths_hash]) === uniqueKey,
      );
      if (dup) {
        return Promise.resolve({ data: null, error: { message: 'UNIQUE constraint failed' } });
      }
      rows.push({ ...row });
      return Promise.resolve({ data: null, error: null });
    };
    builder.update = (payload: Record<string, unknown>) => {
      updatePayload = payload;
      return builder;
    };
    return builder;
  }

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: { from: vi.fn().mockImplementation(() => makeBuilder()) } as any,
    rows,
  };
}

describe('patches-attempted-log hashing', () => {
  it('normalizes forward slashes and trims', () => {
    expect(normalizeHashPath('  src\\foo/bar.ts  ')).toBe('src/foo/bar.ts');
  });

  it('produces the same hash regardless of input order or duplicates', () => {
    const h1 = hashFilePaths(['b', 'a', 'a', 'c']);
    const h2 = hashFilePaths(['c', 'a', 'b']);
    expect(h1).toBe(h2);
  });

  it('different file sets produce different hashes', () => {
    expect(hashFilePaths(['a'])).not.toBe(hashFilePaths(['b']));
    expect(hashFilePaths(['a', 'b'])).not.toBe(hashFilePaths(['a']));
  });
});

describe('patches-attempted-log recording', () => {
  let env: ReturnType<typeof buildDb>;
  beforeEach(() => { env = buildDb([]); });

  it('recordProposedPatch inserts a pending row with the shape hash', async () => {
    const res = await recordProposedPatch({
      db: env.db,
      workspaceId: 'ws-1',
      findingId: 'f-1',
      filePaths: ['src/web/src/pages/Agents.tsx'],
      commitSha: 'abc123',
      patchMode: 'string-literal',
      tier: 'tier-2',
    });
    expect(res.wroteNewRow).toBe(true);
    expect(res.fileHash).toHaveLength(64);
    expect(env.rows).toHaveLength(1);
    expect(env.rows[0]).toMatchObject({
      workspace_id: 'ws-1',
      finding_id: 'f-1',
      commit_sha: 'abc123',
      outcome: 'pending',
      patch_mode: 'string-literal',
      tier: 'tier-2',
    });
  });

  it('double-insert of the same shape silently no-ops (UNIQUE constraint)', async () => {
    const first = await recordProposedPatch({
      db: env.db,
      workspaceId: 'ws-1',
      findingId: 'f-1',
      filePaths: ['a.ts'],
    });
    const second = await recordProposedPatch({
      db: env.db,
      workspaceId: 'ws-1',
      findingId: 'f-1',
      filePaths: ['a.ts'],
    });
    expect(first.wroteNewRow).toBe(true);
    expect(second.wroteNewRow).toBe(false);
    expect(env.rows).toHaveLength(1);
  });

  it('markCommitReverted flips every row tagged with a commit sha', async () => {
    await recordProposedPatch({ db: env.db, workspaceId: 'ws-1', findingId: 'f-1', filePaths: ['a.ts'], commitSha: 'abc' });
    await recordProposedPatch({ db: env.db, workspaceId: 'ws-1', findingId: 'f-2', filePaths: ['b.ts'], commitSha: 'abc' });
    await recordProposedPatch({ db: env.db, workspaceId: 'ws-1', findingId: 'f-3', filePaths: ['c.ts'], commitSha: 'def' });
    await markCommitReverted(env.db, 'ws-1', 'abc');
    const revertedRows = env.rows.filter((r) => r.outcome === 'reverted');
    expect(revertedRows).toHaveLength(2);
    expect(revertedRows.map((r) => r.finding_id).sort()).toEqual(['f-1', 'f-2']);
    const resolvedAts = revertedRows.map((r) => r.resolved_at);
    expect(resolvedAts.every((t) => typeof t === 'string' && t.length > 0)).toBe(true);
  });

  it('updateAttemptOutcome narrows by finding+hash', async () => {
    const { fileHash } = await recordProposedPatch({
      db: env.db,
      workspaceId: 'ws-1',
      findingId: 'f-1',
      filePaths: ['a.ts'],
    });
    await updateAttemptOutcome(env.db, {
      workspaceId: 'ws-1',
      findingId: 'f-1',
      fileHash,
      outcome: 'held',
    });
    expect(env.rows[0].outcome).toBe('held');
    expect(env.rows[0].resolved_at).toEqual(expect.any(String));
  });
});

describe('patches-attempted-log lookup', () => {
  it('hasRecentlyRevertedPatch catches a recent revert on the same (finding, files) tuple', async () => {
    const env = buildDb([
      {
        id: 'r1',
        workspace_id: 'ws-1',
        finding_id: 'f-1',
        file_paths_hash: hashFilePaths(['a.ts']),
        commit_sha: 'abc',
        outcome: 'reverted',
        proposed_at: new Date().toISOString(),
        resolved_at: new Date().toISOString(),
      },
    ]);
    const hit = await hasRecentlyRevertedPatch(env.db, 'ws-1', 'f-1', ['a.ts']);
    expect(hit.alreadyReverted).toBe(true);
    expect(hit.commitSha).toBe('abc');
  });

  it('hasRecentlyRevertedPatch returns false for a different file shape', async () => {
    const env = buildDb([
      {
        id: 'r1',
        workspace_id: 'ws-1',
        finding_id: 'f-1',
        file_paths_hash: hashFilePaths(['a.ts']),
        commit_sha: 'abc',
        outcome: 'reverted',
        proposed_at: new Date().toISOString(),
      },
    ]);
    const hit = await hasRecentlyRevertedPatch(env.db, 'ws-1', 'f-1', ['different.ts']);
    expect(hit.alreadyReverted).toBe(false);
  });

  it('hasRecentlyRevertedPatch returns false for a stale row outside lookback', async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const env = buildDb([
      {
        id: 'r1',
        workspace_id: 'ws-1',
        finding_id: 'f-1',
        file_paths_hash: hashFilePaths(['a.ts']),
        outcome: 'reverted',
        proposed_at: old,
      },
    ]);
    const hit = await hasRecentlyRevertedPatch(env.db, 'ws-1', 'f-1', ['a.ts']);
    expect(hit.alreadyReverted).toBe(false);
  });

  it('hasRecentlyRevertedPatch ignores pending/held rows', async () => {
    const env = buildDb([
      {
        id: 'r1',
        workspace_id: 'ws-1',
        finding_id: 'f-1',
        file_paths_hash: hashFilePaths(['a.ts']),
        outcome: 'pending',
        proposed_at: new Date().toISOString(),
      },
      {
        id: 'r2',
        workspace_id: 'ws-1',
        finding_id: 'f-2',
        file_paths_hash: hashFilePaths(['b.ts']),
        outcome: 'held',
        proposed_at: new Date().toISOString(),
      },
    ]);
    const a = await hasRecentlyRevertedPatch(env.db, 'ws-1', 'f-1', ['a.ts']);
    const b = await hasRecentlyRevertedPatch(env.db, 'ws-1', 'f-2', ['b.ts']);
    expect(a.alreadyReverted).toBe(false);
    expect(b.alreadyReverted).toBe(false);
  });

  it('recentRevertedAttempts returns rows newest-first', async () => {
    const iso = (d: number) => new Date(d).toISOString();
    const env = buildDb([
      { id: '1', workspace_id: 'ws-1', finding_id: 'f-1', file_paths_hash: 'h1', outcome: 'reverted', proposed_at: iso(1000), resolved_at: iso(2000), commit_sha: 'c1', patch_mode: 'string-literal' },
      { id: '2', workspace_id: 'ws-1', finding_id: 'f-2', file_paths_hash: 'h2', outcome: 'reverted', proposed_at: iso(3000), resolved_at: iso(4000), commit_sha: 'c2', patch_mode: 'whole-file' },
      { id: '3', workspace_id: 'ws-1', finding_id: 'f-3', file_paths_hash: 'h3', outcome: 'held', proposed_at: iso(5000), resolved_at: iso(6000), commit_sha: 'c3', patch_mode: 'string-literal' },
    ]);
    const out = await recentRevertedAttempts(env.db, 'ws-1', 10);
    expect(out).toHaveLength(2);
    expect(out[0].findingId).toBe('f-2');
    expect(out[1].findingId).toBe('f-1');
    expect(out[0].commitSha).toBe('c2');
  });

  it('lookup survives a throwing DB and returns alreadyReverted: false', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad: any = { from: () => { throw new Error('db down'); } };
    const hit = await hasRecentlyRevertedPatch(bad, 'ws-1', 'f-1', ['a.ts']);
    expect(hit.alreadyReverted).toBe(false);
  });
});
