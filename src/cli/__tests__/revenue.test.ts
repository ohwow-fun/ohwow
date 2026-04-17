import { describe, it, expect } from 'vitest';
import { parseAddArgs } from '../revenue.js';

describe('parseAddArgs', () => {
  it('requires an amount', () => {
    const r = parseAddArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/amount/i);
  });

  it('rejects non-integer amount', () => {
    const r = parseAddArgs(['abc']);
    expect(r.ok).toBe(false);
  });

  it('rejects zero and negative amount', () => {
    expect(parseAddArgs(['0']).ok).toBe(false);
    expect(parseAddArgs(['-10']).ok).toBe(false);
  });

  it('accepts a bare amount', () => {
    const r = parseAddArgs(['50000']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.amount_cents).toBe(50000);
      expect(r.args.contact_id).toBeUndefined();
    }
  });

  it('parses --flag=value form', () => {
    const r = parseAddArgs([
      '2500',
      '--contact=c_abc',
      '--source=stripe',
      '--note=Q2 deal',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.amount_cents).toBe(2500);
      expect(r.args.contact_id).toBe('c_abc');
      expect(r.args.source).toBe('stripe');
      expect(r.args.notes).toBe('Q2 deal');
    }
  });

  it('parses --flag value form (space-separated)', () => {
    const r = parseAddArgs(['1000', '--contact', 'c_xyz', '--source', 'manual']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.contact_id).toBe('c_xyz');
      expect(r.args.source).toBe('manual');
    }
  });

  it('validates --month range', () => {
    expect(parseAddArgs(['100', '--month=0']).ok).toBe(false);
    expect(parseAddArgs(['100', '--month=13']).ok).toBe(false);
    const r = parseAddArgs(['100', '--month=6']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.month).toBe(6);
  });

  it('validates --year range', () => {
    expect(parseAddArgs(['100', '--year=1999']).ok).toBe(false);
    expect(parseAddArgs(['100', '--year=2101']).ok).toBe(false);
    const r = parseAddArgs(['100', '--year=2026']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.year).toBe(2026);
  });
});
