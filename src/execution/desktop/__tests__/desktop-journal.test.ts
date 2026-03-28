import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DesktopJournal } from '../desktop-journal.js';
import type { DesktopAction, DesktopActionResult } from '../desktop-types.js';

describe('DesktopJournal', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ohwow-journal-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates JSONL file and appends entries', () => {
    const journal = new DesktopJournal(tempDir, 'test-session');
    const action: DesktopAction = { type: 'left_click', x: 100, y: 200 };
    const result: DesktopActionResult = {
      success: true,
      type: 'left_click',
      frontmostApp: 'chrome',
    };

    journal.log(action, result, 42);

    const filePath = join(tempDir, 'desktop-journal', 'test-session.jsonl');
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.sessionId).toBe('test-session');
    expect(entry.actionType).toBe('left_click');
    expect(entry.success).toBe(true);
    expect(entry.frontmostApp).toBe('chrome');
    expect(entry.durationMs).toBe(42);
    expect(entry.timestamp).toBeDefined();
  });

  it('appends multiple entries as separate lines', () => {
    const journal = new DesktopJournal(tempDir, 'multi');
    const click: DesktopAction = { type: 'left_click', x: 10, y: 20 };
    const type_text: DesktopAction = { type: 'type_text', text: 'hello' };

    journal.log(click, { success: true, type: 'left_click' }, 10);
    journal.log(type_text, { success: true, type: 'type_text' }, 20);

    const filePath = join(tempDir, 'desktop-journal', 'multi.jsonl');
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).actionType).toBe('left_click');
    expect(JSON.parse(lines[1]).actionType).toBe('type_text');
  });

  it('includes error field when action fails', () => {
    const journal = new DesktopJournal(tempDir, 'err');
    const action: DesktopAction = { type: 'key', key: 'cmd+q' };
    const result: DesktopActionResult = {
      success: false,
      type: 'key',
      error: 'Action blocked by safety guard.',
    };

    journal.log(action, result, 5);

    const filePath = join(tempDir, 'desktop-journal', 'err.jsonl');
    const entry = JSON.parse(readFileSync(filePath, 'utf-8').trim());
    expect(entry.success).toBe(false);
    expect(entry.error).toBe('Action blocked by safety guard.');
  });

  it('excludes screenshot data from entries', () => {
    const journal = new DesktopJournal(tempDir, 'no-screenshot');
    const action: DesktopAction = { type: 'screenshot' };
    const result: DesktopActionResult = {
      success: true,
      type: 'screenshot',
      screenshot: 'base64dataaaaaaa',
      scaledWidth: 1280,
      scaledHeight: 800,
    };

    journal.log(action, result, 100);

    const filePath = join(tempDir, 'desktop-journal', 'no-screenshot.jsonl');
    const raw = readFileSync(filePath, 'utf-8').trim();
    const entry = JSON.parse(raw);
    // Base64 screenshot data must not be included in journal entries
    expect(raw).not.toContain('base64dataaaaaaa');
    expect(entry.screenshot).toBeUndefined();
    expect(entry.scaledWidth).toBeUndefined();
    expect(entry.scaledHeight).toBeUndefined();
  });

  it('log() does not throw on write failure', () => {
    // Create a journal, then make the file path unwritable by pointing to a directory
    const journal = new DesktopJournal(tempDir, 'write-fail');
    // Overwrite the internal file path to something unwritable
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (journal as any).filePath = '/dev/null/impossible';

    const action: DesktopAction = { type: 'left_click', x: 0, y: 0 };
    const result: DesktopActionResult = { success: true, type: 'left_click' };

    // Should not throw even though write will fail
    expect(() => journal.log(action, result, 1)).not.toThrow();
  });
});
