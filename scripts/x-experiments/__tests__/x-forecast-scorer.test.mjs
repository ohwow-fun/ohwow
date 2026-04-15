/**
 * Unit tests for the pure functions in x-forecast-scorer.mjs. We avoid
 * touching the LLM or the real workspace by testing the functions that
 * load + filter predictions against a synthetic history + scores file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonl, collectMaturedPredictions, buildEvidence } from '../x-forecast-scorer.mjs';

function writeJsonl(file, rows) {
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

describe('x-forecast-scorer', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'x-fscore-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  describe('readJsonl', () => {
    it('returns [] when file missing', () => {
      expect(readJsonl(join(tmp, 'nope.jsonl'))).toEqual([]);
    });
    it('skips malformed lines', () => {
      const f = join(tmp, 'hist.jsonl');
      writeFileSync(f, '{"a":1}\nnot json\n{"b":2}\n');
      expect(readJsonl(f)).toEqual([{ a: 1 }, { b: 2 }]);
    });
  });

  describe('collectMaturedPredictions', () => {
    const today = '2026-04-15';
    const rows = [
      {
        date: '2026-03-01', bucket: 'advancements',
        predictions: [
          { id: 'P_MATURED', what: 'X ships', by_when: '2026-04-01', confidence: 0.7, made_at: '2026-03-01' },
          { id: 'P_PENDING', what: 'Y ships', by_when: '2026-05-01', confidence: 0.4, made_at: '2026-03-01' },
        ],
      },
      {
        date: '2026-03-10', bucket: 'competitors',
        predictions: [
          { id: 'P_ALREADY_SCORED', what: 'Z raises', by_when: '2026-04-01', confidence: 0.8, made_at: '2026-03-10' },
        ],
      },
      { date: '2026-03-15', bucket: 'hacks', predictions: [] },
    ];

    it('returns only predictions past by_when and not already scored', () => {
      const scoredIds = new Set(['P_ALREADY_SCORED']);
      const matured = collectMaturedPredictions(rows, scoredIds, today);
      expect(matured.map(p => p.id)).toEqual(['P_MATURED']);
      expect(matured[0].bucket).toBe('advancements');
      expect(matured[0].confidence).toBe(0.7);
    });

    it('is idempotent — matured predictions disappear once scored', () => {
      const first = collectMaturedPredictions(rows, new Set(), today);
      expect(first).toHaveLength(2); // P_MATURED + P_ALREADY_SCORED are both past
      const scoredIds = new Set(first.map(p => p.id));
      const second = collectMaturedPredictions(rows, scoredIds, today);
      expect(second).toHaveLength(0);
    });

    it('honors the today cutoff — by_when on today is matured, tomorrow is not', () => {
      const rows2 = [{
        date: '2026-03-01', bucket: 'x',
        predictions: [
          { id: 'A', what: 'a', by_when: '2026-04-15', confidence: 0.5, made_at: '2026-03-01' },
          { id: 'B', what: 'b', by_when: '2026-04-16', confidence: 0.5, made_at: '2026-03-01' },
        ],
      }];
      const matured = collectMaturedPredictions(rows2, new Set(), '2026-04-15');
      expect(matured.map(p => p.id)).toEqual(['A']);
    });
  });

  describe('buildEvidence', () => {
    it('pulls only later bucket rows within the evidence window and only cited seen posts', () => {
      const history = [
        { date: '2026-03-01', bucket: 'advancements', headline: 'earlier — should be excluded', emerging_patterns: [] },
        { date: '2026-04-05', bucket: 'advancements', headline: 'later same bucket', emerging_patterns: ['p1', 'p2'] },
        { date: '2026-04-06', bucket: 'competitors', headline: 'different bucket — excluded', emerging_patterns: [] },
        { date: '2026-06-01', bucket: 'advancements', headline: 'way past window', emerging_patterns: [] },
      ];
      const seen = [
        { permalink: '/a/status/1', author: 'a', class: 'advancements' },
        { permalink: '/b/status/2', author: 'b', class: 'hacks' },
      ];
      const pred = {
        id: 'P', bucket: 'advancements', made_at: '2026-03-01',
        by_when: '2026-04-01', what: 'x', confidence: 0.7,
        citations: ['/a/status/1', '/nobody/status/99'],
      };
      const ev = buildEvidence(history, seen, pred, 14);
      expect(ev.historyBlock).toContain('later same bucket');
      expect(ev.historyBlock).not.toContain('earlier');
      expect(ev.historyBlock).not.toContain('different bucket');
      expect(ev.historyBlock).not.toContain('way past');
      expect(ev.citedBlock).toContain('/a/status/1');
      expect(ev.citedBlock).not.toContain('/b/status/2');
      expect(ev.citedBlock).not.toContain('/nobody');
    });

    it('reports gracefully when there is no later history or cited posts left', () => {
      const pred = { id: 'P', bucket: 'advancements', made_at: '2026-03-01', by_when: '2026-04-01', what: 'x', confidence: 0.5, citations: ['/gone/status/1'] };
      const ev = buildEvidence([], [], pred, 14);
      expect(ev.historyBlock).toContain('no later briefs');
      expect(ev.citedBlock).toContain('no longer in seen store');
    });
  });
});
