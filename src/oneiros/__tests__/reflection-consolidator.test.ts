import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  consolidateReflection,
  parseObservations,
  readDiaryWindow,
  buildReflectionPrompt,
} from '../reflection-consolidator.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ohwow-reflection-'));
}

interface Capture {
  inserts: Array<{ table: string; row: Record<string, unknown> }>;
}

function makeDb(findings: Array<Record<string, unknown>>): { db: DatabaseAdapter; capture: Capture } {
  const capture: Capture = { inserts: [] };
  const build = (table: string) => {
    const rows = table === 'self_findings' ? findings : [];
    const chain: Record<string, unknown> = {};
    const wrap = () => chain;
    chain.select = () => wrap();
    chain.eq = () => wrap();
    chain.gte = () => wrap();
    chain.lte = () => wrap();
    chain.insert = (row: Record<string, unknown>) => {
      capture.inserts.push({ table, row });
      return Promise.resolve({ data: null, error: null });
    };
    (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
      resolve({ data: rows, error: null });
    return chain;
  };
  const db = { from: (t: string) => build(t) } as unknown as DatabaseAdapter;
  return { db, capture };
}

describe('parseObservations', () => {
  it('extracts observations from clean JSON array', () => {
    const raw = '[{"kind":"repeated","text":"a pattern"},{"kind":"failed","text":"a bug"}]';
    const obs = parseObservations(raw);
    expect(obs).toHaveLength(2);
    expect(obs[0].kind).toBe('repeated');
    expect(obs[1].kind).toBe('failed');
  });
  it('strips prose around the JSON', () => {
    const raw = 'Here you go:\n[{"kind":"surprised","text":"x"}]\nthanks!';
    const obs = parseObservations(raw);
    expect(obs).toHaveLength(1);
    expect(obs[0].kind).toBe('surprised');
  });
  it('drops items with invalid kind or empty text', () => {
    const raw = '[{"kind":"nope","text":"x"},{"kind":"repeated","text":""},{"kind":"repeated","text":"ok"}]';
    const obs = parseObservations(raw);
    expect(obs).toHaveLength(1);
    expect(obs[0].text).toBe('ok');
  });
  it('returns [] on malformed input', () => {
    expect(parseObservations('not json')).toEqual([]);
    expect(parseObservations('{"not":"array"}')).toEqual([]);
  });
  it('caps at 7 observations', () => {
    const arr = Array.from({ length: 12 }, (_, i) => ({ kind: 'repeated', text: `t${i}` }));
    expect(parseObservations(JSON.stringify(arr))).toHaveLength(7);
  });
});

describe('readDiaryWindow', () => {
  it('returns [] when diary does not exist', () => {
    const dir = mkTempDir();
    expect(readDiaryWindow(dir, new Date(0), new Date())).toEqual([]);
  });

  it('filters entries by ts', () => {
    const dir = mkTempDir();
    const now = Date.now();
    const lines = [
      { ts: new Date(now - 48 * 3600_000).toISOString(), title: 'old' },
      { ts: new Date(now - 1 * 3600_000).toISOString(), title: 'recent' },
      { ts: new Date(now).toISOString(), title: 'now' },
      'not-json',
      '',
    ];
    fs.writeFileSync(
      path.join(dir, 'diary.jsonl'),
      lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'),
    );
    const entries = readDiaryWindow(dir, new Date(now - 24 * 3600_000), new Date(now + 1000));
    expect(entries.map((e) => e.title)).toEqual(['recent', 'now']);
  });
});

describe('buildReflectionPrompt', () => {
  it('includes diary + findings counts and kind enum', () => {
    const start = new Date('2026-04-14T00:00:00Z');
    const end = new Date('2026-04-15T00:00:00Z');
    const prompt = buildReflectionPrompt(
      [{ ts: end.toISOString(), status: 'completed', agent_name: 'A', title: 't' }],
      [{ ran_at: end.toISOString(), verdict: 'fail', experiment_id: 'x', subject: 's', summary: 'sm' }],
      start,
      end,
    );
    expect(prompt).toContain('repeated');
    expect(prompt).toContain('surprised');
    expect(prompt).toContain('failed');
    expect(prompt).toContain('diary.jsonl (1 entries)');
    expect(prompt).toContain('self_findings (1 rows)');
  });
});

describe('consolidateReflection', () => {
  it('returns empty_window when nothing to read', async () => {
    const dir = mkTempDir();
    const { db } = makeDb([]);
    const llm = vi.fn(async () => '[]');
    const r = await consolidateReflection({
      db, workspaceId: 'ws', dataDir: dir, llm,
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('empty_window');
    expect(llm).not.toHaveBeenCalled();
  });

  it('writes observations to affective_memories + emits event', async () => {
    const dir = mkTempDir();
    const now = new Date();
    fs.writeFileSync(
      path.join(dir, 'diary.jsonl'),
      JSON.stringify({ ts: now.toISOString(), status: 'completed', title: 't' }) + '\n',
    );
    const { db, capture } = makeDb([]);
    const llmResponse = JSON.stringify([
      { kind: 'repeated', text: 'a pattern', evidence: ['x'] },
      { kind: 'failed', text: 'a fail' },
      { kind: 'surprised', text: 'wow' },
    ]);
    const llm = vi.fn(async () => llmResponse);
    const bus = { emit: vi.fn() };
    const r = await consolidateReflection({
      db, workspaceId: 'ws', dataDir: dir, llm, bus,
      now: () => now,
    });
    expect(r.ok).toBe(true);
    expect(r.observations).toHaveLength(3);
    expect(capture.inserts).toHaveLength(3);
    expect(capture.inserts[0].table).toBe('affective_memories');
    expect(capture.inserts[0].row.workspace_id).toBe('ws');
    expect(capture.inserts[0].row.affect).toBe('repeated');
    expect(capture.inserts[1].row.affect).toBe('failed');
    expect(capture.inserts[1].row.valence).toBe(-0.4);
    expect(bus.emit).toHaveBeenCalledWith(
      'reflection:consolidated',
      expect.objectContaining({
        workspace_id: 'ws',
        diary_entries: 1,
        observations_written: 3,
      }),
    );
  });

  it('returns llm_failed when LLM throws', async () => {
    const dir = mkTempDir();
    const now = new Date();
    fs.writeFileSync(
      path.join(dir, 'diary.jsonl'),
      JSON.stringify({ ts: now.toISOString(), title: 't' }) + '\n',
    );
    const { db } = makeDb([]);
    const llm = vi.fn(async () => {
      throw new Error('timeout');
    });
    const r = await consolidateReflection({
      db, workspaceId: 'ws', dataDir: dir, llm, now: () => now,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/llm_failed/);
  });

  it('returns no_observations_parsed when LLM output is garbage', async () => {
    const dir = mkTempDir();
    const now = new Date();
    fs.writeFileSync(
      path.join(dir, 'diary.jsonl'),
      JSON.stringify({ ts: now.toISOString(), title: 't' }) + '\n',
    );
    const { db } = makeDb([]);
    const llm = vi.fn(async () => 'sorry, I cannot');
    const r = await consolidateReflection({
      db, workspaceId: 'ws', dataDir: dir, llm, now: () => now,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_observations_parsed');
  });
});
