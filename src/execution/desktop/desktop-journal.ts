/**
 * Desktop Action Journal
 * Writes a JSONL audit log of every desktop action to disk.
 * Each line is a self-contained JSON object with timestamp, action, result, and timing.
 * Screenshots are excluded to keep the journal compact.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../../lib/logger.js';
import type { DesktopAction, DesktopActionResult } from './desktop-types.js';

export interface JournalEntry {
  timestamp: string;
  sessionId: string;
  actionType: string;
  success: boolean;
  error?: string;
  frontmostApp?: string;
  durationMs: number;
}

export class DesktopJournal {
  private filePath: string;
  private sessionId: string;

  constructor(dataDir: string, sessionId: string) {
    this.sessionId = sessionId;
    const journalDir = join(dataDir, 'desktop-journal');
    mkdirSync(journalDir, { recursive: true });
    this.filePath = join(journalDir, `${sessionId}.jsonl`);
  }

  /**
   * Append an action entry to the journal. Never throws — failures are logged and swallowed.
   */
  log(action: DesktopAction, result: DesktopActionResult, durationMs: number): void {
    const entry: JournalEntry = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      actionType: action.type,
      success: result.success,
      error: result.error,
      frontmostApp: result.frontmostApp,
      durationMs,
    };

    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
    } catch (err) {
      logger.warn(`[desktop-journal] Failed to write entry: ${err}`);
    }
  }
}
