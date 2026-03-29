/**
 * SQLite-backed Auth State for Baileys
 * Stores WhatsApp authentication credentials in the runtime SQLite database
 * instead of the filesystem (Baileys default).
 */

import type { AuthenticationCreds, SignalDataTypeMap } from '@whiskeysockets/baileys';
import { proto } from '@whiskeysockets/baileys';
import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import type Database from 'better-sqlite3';

export interface SqliteAuthState {
  state: {
    creds: AuthenticationCreds;
    keys: {
      get: <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => Record<string, SignalDataTypeMap[T]>;
      set: (data: Record<string, Record<string, unknown>>) => void;
    };
  };
  saveCreds: () => void;
}

/**
 * Create a Baileys auth state backed by SQLite.
 * Stores creds in whatsapp_connections.auth_state and signal keys in a JSON blob.
 */
/**
 * Export the raw auth state JSON for a connection.
 * Used for failover: transfer auth to another device.
 * Returns null if no auth state exists.
 */
export function exportAuthState(rawDb: Database.Database, connectionId: string): string | null {
  const row = rawDb.prepare(
    'SELECT auth_state FROM whatsapp_connections WHERE id = ?',
  ).get(connectionId) as { auth_state: string | null } | undefined;
  return row?.auth_state ?? null;
}

/**
 * Import a raw auth state JSON into a connection row.
 * Used for failover: receive auth from another device.
 * The connection row must already exist.
 */
export function importAuthState(rawDb: Database.Database, connectionId: string, authStateJson: string): void {
  rawDb.prepare(
    'UPDATE whatsapp_connections SET auth_state = ?, updated_at = datetime(\'now\') WHERE id = ?',
  ).run(authStateJson, connectionId);
}

/**
 * Create a Baileys auth state backed by SQLite.
 * Stores creds in whatsapp_connections.auth_state and signal keys in a JSON blob.
 */
/**
 * Acquire a connection lock, preventing another device from connecting the same WhatsApp number.
 * Returns true if the lock was acquired, false if another device holds a fresh lock (heartbeat < 60s).
 */
export function acquireConnectionLock(rawDb: Database.Database, connectionId: string, deviceId: string): boolean {
  const row = rawDb.prepare(
    'SELECT device_id, heartbeat_at FROM connection_locks WHERE connection_id = ?',
  ).get(connectionId) as { device_id: string; heartbeat_at: string } | undefined;

  if (row) {
    // Same device can always re-acquire
    if (row.device_id === deviceId) {
      rawDb.prepare(
        'UPDATE connection_locks SET heartbeat_at = datetime(\'now\') WHERE connection_id = ?',
      ).run(connectionId);
      return true;
    }

    // Another device holds the lock — check if heartbeat is stale (>60s)
    const heartbeatAge = (Date.now() - new Date(row.heartbeat_at + 'Z').getTime()) / 1000;
    if (heartbeatAge < 60) {
      return false; // Lock held by another device with recent heartbeat
    }
  }

  // Lock is available (no row, stale heartbeat, or same device) — upsert
  rawDb.prepare(`
    INSERT INTO connection_locks (connection_id, device_id, locked_at, heartbeat_at)
    VALUES (?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(connection_id) DO UPDATE SET
      device_id = excluded.device_id,
      locked_at = datetime('now'),
      heartbeat_at = datetime('now')
  `).run(connectionId, deviceId);
  return true;
}

/**
 * Renew the heartbeat on a connection lock.
 */
export function renewConnectionLock(rawDb: Database.Database, connectionId: string, deviceId: string): void {
  rawDb.prepare(
    'UPDATE connection_locks SET heartbeat_at = datetime(\'now\') WHERE connection_id = ? AND device_id = ?',
  ).run(connectionId, deviceId);
}

/**
 * Release a connection lock.
 */
export function releaseConnectionLock(rawDb: Database.Database, connectionId: string): void {
  rawDb.prepare('DELETE FROM connection_locks WHERE connection_id = ?').run(connectionId);
}

/**
 * Fetch auth state from a peer and import it locally.
 * Used during failover when a peer with connections goes offline.
 * Returns true if auth was successfully fetched and imported.
 */
export async function fetchAndImportAuthState(
  rawDb: Database.Database,
  peerBaseUrl: string,
  peerToken: string,
  connectionId: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${peerBaseUrl}/api/peers/auth-state/${connectionId}`, {
      headers: { 'X-Peer-Token': peerToken },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { authState?: string };
    if (!data.authState) return false;
    importAuthState(rawDb, connectionId, data.authState);
    return true;
  } catch {
    return false;
  }
}

export function createSqliteAuthState(rawDb: Database.Database, connectionId: string): SqliteAuthState {
  // Helper to read the auth_state JSON from the connection row
  const readAuthState = (): { creds?: unknown; keys?: Record<string, Record<string, unknown>> } => {
    const row = rawDb.prepare(
      'SELECT auth_state FROM whatsapp_connections WHERE id = ?',
    ).get(connectionId) as { auth_state: string | null } | undefined;

    if (!row?.auth_state) return {};
    try {
      return JSON.parse(row.auth_state, BufferJSON.reviver);
    } catch {
      return {};
    }
  };

  // Helper to write the auth_state JSON
  const writeAuthState = (data: { creds: unknown; keys: Record<string, Record<string, unknown>> }) => {
    const json = JSON.stringify(data, BufferJSON.replacer);
    rawDb.prepare(
      'UPDATE whatsapp_connections SET auth_state = ?, updated_at = datetime(\'now\') WHERE id = ?',
    ).run(json, connectionId);
  };

  // Load existing or initialize fresh creds
  const stored = readAuthState();
  const creds: AuthenticationCreds = stored.creds
    ? Object.assign(initAuthCreds(), stored.creds)
    : initAuthCreds();

  const keys: Record<string, Record<string, unknown>> = stored.keys || {};

  const saveCreds = () => {
    writeAuthState({ creds, keys });
  };

  return {
    state: {
      creds,
      keys: {
        get(type, ids) {
          const data: Record<string, unknown> = {};
          const typeStore = keys[type];
          if (!typeStore) return data as Record<string, SignalDataTypeMap[typeof type]>;

          for (const id of ids) {
            let value = typeStore[id];
            if (value) {
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value as Record<string, unknown>);
              }
              data[id] = value;
            }
          }
          return data as Record<string, SignalDataTypeMap[typeof type]>;
        },
        set(data) {
          for (const category in data) {
            if (!keys[category]) keys[category] = {};
            Object.assign(keys[category], data[category]);
            // Remove null entries
            for (const id in data[category]) {
              if (data[category][id] === null || data[category][id] === undefined) {
                delete keys[category][id];
              }
            }
          }
          saveCreds();
        },
      },
    },
    saveCreds,
  };
}
