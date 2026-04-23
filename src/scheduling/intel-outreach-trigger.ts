/**
 * IntelOutreachTrigger — reads market intel briefs and creates agent tasks
 * for buyer_intent signals that haven't been processed yet.
 *
 * Call tick() on a schedule (e.g. hourly) from the daemon.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';

interface IntelBrief {
  id: string;
  bucket: string;
  headline: string;
  ohwow_implications: string;
  score: number;
}

export class IntelOutreachTrigger {
  private db: DatabaseAdapter;
  private workspaceId: string;
  private workspaceName: string;

  constructor(db: DatabaseAdapter, workspaceId: string, workspaceName = 'default') {
    this.db = db;
    this.workspaceId = workspaceId;
    this.workspaceName = workspaceName;
  }

  async tick(): Promise<void> {
    const intelDir = path.join(
      os.homedir(), '.ohwow', 'workspaces', this.workspaceName, 'intel'
    );
    if (!fs.existsSync(intelDir)) return;

    // Find the latest day directory (YYYY-MM-DD)
    const days = fs.readdirSync(intelDir)
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .reverse();
    if (days.length === 0) return;

    const dayDir = path.join(intelDir, days[0]);
    const briefsPath = path.join(dayDir, 'briefs.json');
    if (!fs.existsSync(briefsPath)) return;

    let briefs: IntelBrief[] = [];
    try {
      briefs = JSON.parse(fs.readFileSync(briefsPath, 'utf8')) as IntelBrief[];
    } catch {
      return;
    }

    const seenPath = path.join(dayDir, 'outreach-seen.json');
    let seen: string[] = [];
    try {
      seen = JSON.parse(fs.readFileSync(seenPath, 'utf8')) as string[];
    } catch { /* first run — seen list starts empty */ }

    const unseen = briefs.filter(
      b => b.bucket === 'buyer_intent' && !seen.includes(b.id)
    );

    for (const brief of unseen) {
      const id = randomUUID();
      const now = new Date().toISOString();
      try {
        await this.db.from('agent_workforce_tasks').insert({
          id,
          workspace_id: this.workspaceId,
          title: `Follow up on buyer intent signal: ${brief.headline}`,
          description: brief.ohwow_implications || brief.headline,
          status: 'pending',
          priority: 'high',
          source: 'intel_outreach_trigger',
          created_at: now,
          updated_at: now,
        });
        seen.push(brief.id);
        logger.info(
          { briefId: brief.id, headline: brief.headline },
          '[intel-outreach] task created for buyer_intent signal',
        );
      } catch (err) {
        logger.warn({ err, briefId: brief.id }, '[intel-outreach] failed to create task');
      }
    }

    if (unseen.length > 0) {
      fs.writeFileSync(seenPath, JSON.stringify(seen, null, 2));
    }
  }
}
