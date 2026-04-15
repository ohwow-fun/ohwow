import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installDiaryHook } from '../diary-hook.js';

function seedDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE agent_workforce_agents (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE agent_workforce_tasks (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      title TEXT,
      status TEXT,
      duration_seconds INTEGER,
      tokens_used INTEGER,
      cost_cents INTEGER,
      model_used TEXT,
      output TEXT
    );
    INSERT INTO agent_workforce_agents (id, name) VALUES ('agent-1', 'diary-tester');
    INSERT INTO agent_workforce_tasks
      (id, agent_id, title, status, duration_seconds, tokens_used, cost_cents, model_used, output)
    VALUES
      ('task-1', 'agent-1', 'warmup check', 'completed', 7, 1234, 5, 'test-model',
       'a rambling multi-line   output   with   whitespace\nand a second line');
  `);
}

describe('installDiaryHook', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-hook-'));
    db = new Database(':memory:');
    seedDb(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends a JSONL entry on task:completed', async () => {
    const bus = new EventEmitter();
    installDiaryHook(bus, db, { dataDir: tmpDir });
    bus.emit('task:completed', {
      taskId: 'task-1',
      agentId: 'agent-1',
      status: 'completed',
      tokensUsed: 1234,
      costCents: 5,
    });
    // fs.appendFile is async; give it a tick.
    await new Promise((r) => setTimeout(r, 30));

    const diaryPath = path.join(tmpDir, 'diary.jsonl');
    const content = fs.readFileSync(diaryPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);

    expect(entry.task_id).toBe('task-1');
    expect(entry.agent_id).toBe('agent-1');
    expect(entry.agent_name).toBe('diary-tester');
    expect(entry.status).toBe('completed');
    expect(entry.tokens).toBe(1234);
    expect(entry.cost_cents).toBe(5);
    expect(entry.duration_seconds).toBe(7);
    expect(entry.model).toBe('test-model');
    expect(entry.title).toBe('warmup check');
    // Whitespace collapsed, single-line preview
    expect(entry.output_preview).toMatch(/^a rambling multi-line output/);
    expect(entry.output_preview).not.toContain('\n');
    // ISO timestamp present
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('silently skips when the task row is missing', async () => {
    const bus = new EventEmitter();
    installDiaryHook(bus, db, { dataDir: tmpDir });
    bus.emit('task:completed', {
      taskId: 'nonexistent',
      agentId: 'whoever',
      status: 'completed',
      tokensUsed: 0,
      costCents: 0,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(fs.existsSync(path.join(tmpDir, 'diary.jsonl'))).toBe(false);
  });

  it('truncates long titles and output previews', async () => {
    const longTitle = 'x'.repeat(200);
    const longOutput = 'y'.repeat(500);
    db.prepare(
      `INSERT INTO agent_workforce_tasks (id, agent_id, title, status, output)
       VALUES ('long', 'agent-1', ?, 'completed', ?)`,
    ).run(longTitle, longOutput);

    const bus = new EventEmitter();
    installDiaryHook(bus, db, { dataDir: tmpDir, outputPreviewChars: 50 });
    bus.emit('task:completed', {
      taskId: 'long',
      agentId: 'agent-1',
      status: 'completed',
      tokensUsed: 0,
      costCents: 0,
    });
    await new Promise((r) => setTimeout(r, 30));

    const entry = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'diary.jsonl'), 'utf-8').trim(),
    );
    expect(entry.title.length).toBe(80);
    expect(entry.title.endsWith('…')).toBe(true);
    expect(entry.output_preview.length).toBe(50);
    expect(entry.output_preview.endsWith('…')).toBe(true);
  });

  it('returns an uninstall function that stops appending', async () => {
    const bus = new EventEmitter();
    const uninstall = installDiaryHook(bus, db, { dataDir: tmpDir });
    uninstall();
    bus.emit('task:completed', {
      taskId: 'task-1',
      agentId: 'agent-1',
      status: 'completed',
      tokensUsed: 0,
      costCents: 0,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(fs.existsSync(path.join(tmpDir, 'diary.jsonl'))).toBe(false);
  });
});
