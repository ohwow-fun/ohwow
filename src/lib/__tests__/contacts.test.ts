import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

import { initDatabase } from '../../db/init.js';
import { createSqliteAdapter } from '../../db/sqlite-adapter.js';
import { findContactByXUserId } from '../contacts.js';

const WS = 'ws-contacts-test';

describe('findContactByXUserId', () => {
  let dir: string;
  let rawDb: Database.Database;
  let db: ReturnType<typeof createSqliteAdapter>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ohwow-contacts-'));
    rawDb = initDatabase(join(dir, 'runtime.db'));
    db = createSqliteAdapter(rawDb);
  });

  afterEach(() => {
    rawDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(name: string, customFields: Record<string, unknown>): string {
    const id = `contact-${Math.random().toString(36).slice(2, 10)}`;
    rawDb.prepare(
      `INSERT INTO agent_workforce_contacts (id, workspace_id, name, custom_fields)
       VALUES (?, ?, ?, ?)`,
    ).run(id, WS, name, JSON.stringify(customFields));
    return id;
  }

  it('returns the contact whose custom_fields.x_user_id matches', async () => {
    const id = seed('Alice', { x_user_id: '1877225919862951937', role: 'partner' });
    seed('Bob', { x_user_id: '2033915109555499008' });

    const hit = await findContactByXUserId(db, WS, '1877225919862951937');
    expect(hit?.id).toBe(id);
    expect(hit?.name).toBe('Alice');
  });

  it('returns null when no contact has the matching x_user_id', async () => {
    seed('Alice', { x_user_id: '9999999999' });
    const miss = await findContactByXUserId(db, WS, '1877225919862951937');
    expect(miss).toBeNull();
  });

  it('returns null when the contacts table is empty', async () => {
    const miss = await findContactByXUserId(db, WS, '1877225919862951937');
    expect(miss).toBeNull();
  });

  it('isolates by workspace_id', async () => {
    seed('Alice', { x_user_id: '1877225919862951937' });
    const otherWs = await findContactByXUserId(db, 'ws-other', '1877225919862951937');
    expect(otherWs).toBeNull();
  });

  it('ignores contacts without x_user_id in custom_fields', async () => {
    seed('Alice', { email: 'alice@example.com' });
    const miss = await findContactByXUserId(db, WS, '1877225919862951937');
    expect(miss).toBeNull();
  });

  it('returns null for an empty xUserId (defensive)', async () => {
    seed('Alice', { x_user_id: '1877225919862951937' });
    expect(await findContactByXUserId(db, WS, '')).toBeNull();
  });
});
