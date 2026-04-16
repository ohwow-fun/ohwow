import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserProfileGuardianExperiment } from '../experiments/browser-profile-guardian.js';
import type { ExperimentContext } from '../experiment-types.js';

const TEST_SLUG = `guardian-test-${Date.now()}`;
const LEDGER_DIR = path.join(os.homedir(), '.ohwow', 'workspaces', TEST_SLUG);
const LEDGER_PATH = path.join(LEDGER_DIR, 'chrome-profile-events.jsonl');

function ctx(): ExperimentContext {
  return {
    db: { from: () => ({}) } as never,
    workspaceId: 'test',
    workspaceSlug: TEST_SLUG,
    engine: {} as never,
    recentFindings: async () => [],
  };
}

function writeEvents(lines: unknown[]): void {
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
  fs.writeFileSync(LEDGER_PATH, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}

beforeEach(() => {
  try { fs.rmSync(LEDGER_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

afterEach(() => {
  try { fs.rmSync(LEDGER_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('BrowserProfileGuardianExperiment', () => {
  it('passes when ledger is absent', async () => {
    const exp = new BrowserProfileGuardianExperiment();
    const res = await exp.probe(ctx());
    expect(res.evidence.ledger_present).toBe(false);
    expect(exp.judge(res, [])).toBe('pass');
  });

  it('passes when all launches match requested profile', async () => {
    const now = new Date().toISOString();
    writeEvents([
      { ts: now, source: 'attach', expected_profile: 'A', resolved_profile: 'A', mismatch: false },
      { ts: now, source: 'spawn', expected_profile: 'A', resolved_profile: 'A', mismatch: false },
      { ts: now, source: 'attach', expected_profile: 'A', resolved_profile: 'A', mismatch: false },
    ]);
    const exp = new BrowserProfileGuardianExperiment();
    const res = await exp.probe(ctx());
    expect(res.evidence.mismatches_in_window).toBe(0);
    expect(exp.judge(res, [])).toBe('pass');
  });

  it('warns when some launches mismatch but not most', async () => {
    const now = new Date().toISOString();
    writeEvents([
      { ts: now, source: 'attach', expected_profile: 'A', resolved_profile: 'A', mismatch: false },
      { ts: now, source: 'attach', expected_profile: 'A', resolved_profile: 'A', mismatch: false },
      { ts: now, source: 'attach', expected_profile: 'A', resolved_profile: 'A', mismatch: false },
      { ts: now, source: 'attach', expected_profile: 'A', resolved_profile: 'B', mismatch: true },
    ]);
    const exp = new BrowserProfileGuardianExperiment();
    const res = await exp.probe(ctx());
    const ev = res.evidence as { mismatches_in_window: number; pairs: Array<{ count: number }> };
    expect(ev.mismatches_in_window).toBe(1);
    expect(exp.judge(res, [])).toBe('warning');
    expect(ev.pairs[0].count).toBe(1);
  });

  it('fails when >=50% of recent launches mismatch', async () => {
    const now = new Date().toISOString();
    writeEvents([
      { ts: now, source: 'attach', expected_profile: 'A', resolved_profile: 'B', mismatch: true },
      { ts: now, source: 'attach', expected_profile: 'A', resolved_profile: 'B', mismatch: true },
      { ts: now, source: 'attach', expected_profile: 'A', resolved_profile: 'A', mismatch: false },
    ]);
    const exp = new BrowserProfileGuardianExperiment();
    const res = await exp.probe(ctx());
    expect(exp.judge(res, [])).toBe('fail');
  });

  it('ignores events outside the 6h window', async () => {
    const old = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    writeEvents([
      { ts: old, source: 'attach', expected_profile: 'A', resolved_profile: 'B', mismatch: true },
      { ts: old, source: 'attach', expected_profile: 'A', resolved_profile: 'B', mismatch: true },
    ]);
    const exp = new BrowserProfileGuardianExperiment();
    const res = await exp.probe(ctx());
    expect(res.evidence.events_in_window).toBe(0);
    expect(exp.judge(res, [])).toBe('pass');
  });
});
