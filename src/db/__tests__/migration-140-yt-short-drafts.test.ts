import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '140-yt-short-drafts.sql'),
  'utf8',
);

let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(MIGRATION);
});

afterEach(() => {
  db.close();
});

describe('migration 140 — yt_short_drafts + yt_episode_metrics', () => {
  it('creates yt_short_drafts with the expected columns', () => {
    const cols = db.prepare('PRAGMA table_info(yt_short_drafts)').all() as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    for (const required of [
      'id', 'workspace_id', 'series', 'title', 'description', 'narration',
      'status', 'created_at',
    ]) {
      expect(byName[required]).toBeDefined();
    }
    // id is PK with DEFAULT; SQLite reports notnull=0 but in practice
    // it's never NULL. Assert the PK.
    expect(byName.id.pk).toBe(1);
    // The rest of the required columns must carry NOT NULL.
    for (const required of [
      'workspace_id', 'series', 'title', 'description', 'narration',
      'status', 'created_at',
    ]) {
      expect(byName[required].notnull).toBe(1);
    }
    for (const optional of [
      'brief_json', 'video_path', 'source_seed_id', 'confidence',
      'visual_review_score', 'visibility', 'video_url', 'video_id',
      'approved_at', 'rejected_at', 'uploaded_at',
    ]) {
      expect(byName[optional]).toBeDefined();
    }
  });

  it('enforces status CHECK constraint', () => {
    const insert = db.prepare(`INSERT INTO yt_short_drafts
      (id, workspace_id, series, title, description, narration, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    expect(() => insert.run('1', 'ws', 'briefing', 't', 'd', 'n', 'bogus'))
      .toThrow();
    expect(() => insert.run('2', 'ws', 'briefing', 't', 'd', 'n', 'pending'))
      .not.toThrow();
  });

  it('enforces visibility CHECK constraint (allows NULL)', () => {
    const insert = db.prepare(`INSERT INTO yt_short_drafts
      (id, workspace_id, series, title, description, narration, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    expect(() => insert.run('1', 'ws', 'briefing', 't', 'd', 'n', 'broadcast'))
      .toThrow();
    expect(() => insert.run('2', 'ws', 'briefing', 't', 'd', 'n', 'unlisted'))
      .not.toThrow();
    expect(() => insert.run('3', 'ws', 'briefing', 't', 'd', 'n', null))
      .not.toThrow();
  });

  it('UNIQUE (workspace_id, series, source_seed_id) dedupes compose reruns', () => {
    const insert = db.prepare(`INSERT INTO yt_short_drafts
      (workspace_id, series, title, description, narration, source_seed_id)
      VALUES (?, ?, ?, ?, ?, ?)`);
    insert.run('ws', 'briefing', 't1', 'd1', 'n1', 'seed-abc');
    expect(() => insert.run('ws', 'briefing', 't1-dup', 'd1', 'n1', 'seed-abc'))
      .toThrow(/UNIQUE/);
    // Same seed in a different series is allowed.
    expect(() => insert.run('ws', 'tomorrow-broke', 't1', 'd1', 'n1', 'seed-abc'))
      .not.toThrow();
  });

  it('creates yt_episode_metrics with FK to yt_short_drafts', () => {
    const draftId = 'draft-123';
    db.prepare(`INSERT INTO yt_short_drafts (id, workspace_id, series, title, description, narration)
                VALUES (?, ?, ?, ?, ?, ?)`).run(draftId, 'ws', 'briefing', 't', 'd', 'n');
    const ok = db.prepare(`INSERT INTO yt_episode_metrics
      (workspace_id, draft_id, series, video_id, poll_horizon_hours, views, likes, comments, avg_watch_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    expect(() => ok.run('ws', draftId, 'briefing', 'vid-xyz', 1, 100, 10, 2, 55.5))
      .not.toThrow();
    // Dupe (video_id, horizon) rejected by UNIQUE.
    expect(() => ok.run('ws', draftId, 'briefing', 'vid-xyz', 1, 200, 20, 4, 60))
      .toThrow(/UNIQUE/);
    // Different horizon for same video: fine.
    expect(() => ok.run('ws', draftId, 'briefing', 'vid-xyz', 24, 500, 40, 8, 58))
      .not.toThrow();
  });

  it('CASCADE delete wipes metrics when draft is removed', () => {
    const draftId = 'draft-cascade';
    db.prepare(`INSERT INTO yt_short_drafts (id, workspace_id, series, title, description, narration)
                VALUES (?, ?, ?, ?, ?, ?)`).run(draftId, 'ws', 'briefing', 't', 'd', 'n');
    db.prepare(`INSERT INTO yt_episode_metrics
      (workspace_id, draft_id, series, video_id, poll_horizon_hours)
      VALUES (?, ?, ?, ?, ?)`).run('ws', draftId, 'briefing', 'vid', 1);
    const before = db.prepare('SELECT COUNT(*) as c FROM yt_episode_metrics').get() as { c: number };
    expect(before.c).toBe(1);
    db.prepare('DELETE FROM yt_short_drafts WHERE id = ?').run(draftId);
    const after = db.prepare('SELECT COUNT(*) as c FROM yt_episode_metrics').get() as { c: number };
    expect(after.c).toBe(0);
  });

  it('supports kpi_id set at final horizon for strategist scoping', () => {
    const draftId = 'draft-kpi';
    db.prepare(`INSERT INTO yt_short_drafts (id, workspace_id, series, title, description, narration)
                VALUES (?, ?, ?, ?, ?, ?)`).run(draftId, 'ws', 'briefing', 't', 'd', 'n');
    db.prepare(`INSERT INTO yt_episode_metrics
      (workspace_id, draft_id, series, video_id, poll_horizon_hours, kpi_id)
      VALUES (?, ?, ?, ?, ?, ?)`).run('ws', draftId, 'briefing', 'v', 168, 'yt_briefing_7d_avg_watch_time');
    const rows = db.prepare(`SELECT kpi_id FROM yt_episode_metrics
      WHERE series = 'briefing' AND kpi_id LIKE 'yt_%'`).all() as Array<{ kpi_id: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].kpi_id).toMatch(/^yt_briefing_/);
  });
});
