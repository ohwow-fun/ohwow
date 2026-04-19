import Database from 'better-sqlite3';
import { workspaceLayoutFor } from '../config.js';

export class WorkspaceDbPool {
  private readonly cache = new Map<string, Database.Database>();

  get(workspaceName: string): Database.Database {
    const hit = this.cache.get(workspaceName);
    if (hit) return hit;
    const layout = workspaceLayoutFor(workspaceName);
    const db = new Database(layout.dbPath);
    this.cache.set(workspaceName, db);
    return db;
  }

  close(workspaceName: string): void {
    const db = this.cache.get(workspaceName);
    if (db) { db.close(); this.cache.delete(workspaceName); }
  }

  closeAll(): void {
    for (const [name] of this.cache) this.close(name);
  }
}
