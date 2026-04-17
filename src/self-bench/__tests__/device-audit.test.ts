import { describe, it, expect } from 'vitest';
import {
  DeviceAuditExperiment,
  buildEvidence,
  type DeviceAuditEvidence,
  type RawAuditOutput,
} from '../experiments/device-audit.js';
import type { ProbeResult } from '../experiment-types.js';

function probe(ev: DeviceAuditEvidence): ProbeResult {
  return { subject: 'meta:device-health', summary: '', evidence: ev };
}

function baseEvidence(over: Partial<DeviceAuditEvidence> = {}): DeviceAuditEvidence {
  return {
    warnings: [],
    warning_codes: [],
    critical_count: 0,
    warn_count: 0,
    ram_used_pct: 50,
    swap_used_pct: 10,
    load_per_core_15m: 0.5,
    primary_volume_capacity_pct: 50,
    runner_error: null,
    platform: 'darwin',
    ...over,
  };
}

describe('DeviceAuditExperiment.judge', () => {
  const exp = new DeviceAuditExperiment();

  it('passes when no warnings are present', () => {
    expect(exp.judge(probe(baseEvidence()), [])).toBe('pass');
  });

  it('warns when only warn-severity findings are present', () => {
    const ev = baseEvidence({
      warnings: [
        { code: 'swap_near_limit', severity: 'warn', message: 'm', remediation: 'r' },
      ],
      warning_codes: ['swap_near_limit'],
      warn_count: 1,
    });
    expect(exp.judge(probe(ev), [])).toBe('warning');
  });

  it('fails when any critical-severity warning is present', () => {
    const ev = baseEvidence({
      warnings: [
        { code: 'swap_near_limit', severity: 'warn', message: '', remediation: '' },
        { code: 'pegged_long_running', severity: 'critical', message: '', remediation: '' },
      ],
      warning_codes: ['swap_near_limit', 'pegged_long_running'],
      warn_count: 1,
      critical_count: 1,
    });
    expect(exp.judge(probe(ev), [])).toBe('fail');
  });

  it('warns when the runner errored before producing warnings', () => {
    expect(exp.judge(probe(baseEvidence({ runner_error: 'timeout' })), [])).toBe('warning');
  });
});

describe('buildEvidence', () => {
  it('counts severities and extracts key metrics', () => {
    const raw: RawAuditOutput = {
      warnings: [
        { code: 'a', severity: 'warn', message: '', remediation: '' },
        { code: 'b', severity: 'critical', message: '', remediation: '' },
        { code: 'c', severity: 'critical', message: '', remediation: '' },
      ],
      memory: { ram: { used_pct: 80 }, swap: { used_pct: 92 } },
      load: { load_per_core: { '15m': 2.1 } },
      disk: { primary_data_volume: { capacity_pct: 88 } },
    };
    const ev = buildEvidence(raw);
    expect(ev.warn_count).toBe(1);
    expect(ev.critical_count).toBe(2);
    expect(ev.warning_codes).toEqual(['a', 'b', 'c']);
    expect(ev.swap_used_pct).toBe(92);
    expect(ev.load_per_core_15m).toBe(2.1);
    expect(ev.primary_volume_capacity_pct).toBe(88);
  });

  it('treats missing optional fields as null without throwing', () => {
    const ev = buildEvidence({});
    expect(ev.warnings).toEqual([]);
    expect(ev.warning_codes).toEqual([]);
    expect(ev.ram_used_pct).toBeNull();
    expect(ev.swap_used_pct).toBeNull();
    expect(ev.load_per_core_15m).toBeNull();
    expect(ev.primary_volume_capacity_pct).toBeNull();
  });
});
