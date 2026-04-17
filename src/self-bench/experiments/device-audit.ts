/**
 * DeviceAuditExperiment — runs scripts/device-audit/audit.sh on a 30-minute
 * cadence and lands its warnings as self_findings rows.
 *
 * Probe shells out to the bash script, parses the JSON snapshot, and
 * summarises the `warnings` array into a verdict:
 *   - any `critical` severity warning -> fail
 *   - any `warn` severity warning -> warning
 *   - otherwise -> pass
 * Runner errors (script crash, timeout, bad JSON) become a warning so a
 * flaky probe never masquerades as a clean device.
 *
 * macOS-only by nature of the underlying script. On other platforms the
 * script returns {"error":"unsupported_os",...} and the probe records a
 * quiet warning so the absence is still auditable but doesn't pollute the
 * ledger with noisy failures.
 *
 * Observe-only — no intervene(). Remediation for the warning codes is
 * intentionally operator-driven (kill a pegged process, free disk, reboot).
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { getSelfCommitStatus } from '../self-commit.js';

const execFileP = promisify(execFile);

const SCRIPT_REL = 'scripts/device-audit/audit.sh';
const DEFAULT_TIMEOUT_MS = 15_000;
const SUBJECT = 'meta:device-health';

export type WarningSeverity = 'warn' | 'critical';

export interface DeviceAuditWarning {
  code: string;
  severity: WarningSeverity;
  message: string;
  remediation: string;
  pid?: number;
}

export interface DeviceAuditEvidence extends Record<string, unknown> {
  warnings: DeviceAuditWarning[];
  warning_codes: string[];
  critical_count: number;
  warn_count: number;
  ram_used_pct: number | null;
  swap_used_pct: number | null;
  load_per_core_15m: number | null;
  primary_volume_capacity_pct: number | null;
  runner_error: string | null;
  platform: string;
}

export interface RawAuditOutput {
  error?: string;
  os?: string;
  warnings?: DeviceAuditWarning[];
  memory?: {
    ram?: { used_pct?: number };
    swap?: { used_pct?: number };
  };
  load?: { load_per_core?: Record<string, number> };
  disk?: { primary_data_volume?: { capacity_pct?: number } | null };
}

export class DeviceAuditExperiment implements Experiment {
  readonly id = 'device-audit';
  readonly name = 'Local device performance audit';
  readonly category: ExperimentCategory = 'handler_audit';
  readonly hypothesis =
    'The host running the daemon should have enough free RAM, swap headroom, ' +
    'CPU headroom, and disk headroom that ohwow operations do not stall. ' +
    'Sustained breach of any threshold should surface as a finding so the ' +
    'operator can free resources before the runtime degrades.';
  readonly cadence = { everyMs: 30 * 60 * 1000, runOnBoot: true };

  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    const { repoRoot } = getSelfCommitStatus();
    if (!repoRoot) {
      return {
        subject: SUBJECT,
        summary: 'device-audit: no repo root configured',
        evidence: emptyEvidence('no repo root'),
      };
    }
    const scriptPath = path.join(repoRoot, SCRIPT_REL);
    const run = await runAuditScript(scriptPath, this.timeoutMs);
    if (!run.json) {
      return {
        subject: SUBJECT,
        summary: `device-audit runner error: ${run.error ?? 'unknown'}`,
        evidence: emptyEvidence(run.error ?? 'unknown'),
      };
    }
    if (run.json.error === 'unsupported_os') {
      const evidence = emptyEvidence(null);
      evidence.platform = run.json.os ?? process.platform;
      return {
        subject: SUBJECT,
        summary: `device-audit unsupported on ${evidence.platform}`,
        evidence,
      };
    }
    const evidence = buildEvidence(run.json);
    return { subject: SUBJECT, summary: summarise(evidence), evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as DeviceAuditEvidence;
    if (ev.runner_error && ev.warnings.length === 0) return 'warning';
    if (ev.critical_count > 0) return 'fail';
    if (ev.warn_count > 0) return 'warning';
    return 'pass';
  }
}

export async function runAuditScript(
  scriptPath: string,
  timeoutMs: number,
): Promise<{ json: RawAuditOutput | null; error: string | null }> {
  try {
    const { stdout } = await execFileP(scriptPath, [], {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    const json = safeParse(stdout);
    return json
      ? { json, error: null }
      : { json: null, error: `audit.sh produced no parseable JSON (stdout_len=${stdout.length})` };
  } catch (err) {
    const stdout = (err as { stdout?: string | Buffer }).stdout;
    const text = typeof stdout === 'string' ? stdout : stdout?.toString('utf-8') ?? '';
    const json = safeParse(text);
    const message = err instanceof Error ? err.message : String(err);
    return json ? { json, error: null } : { json: null, error: message };
  }
}

export function buildEvidence(raw: RawAuditOutput): DeviceAuditEvidence {
  const warnings = Array.isArray(raw.warnings) ? raw.warnings : [];
  return {
    warnings,
    warning_codes: warnings.map((w) => w.code),
    critical_count: warnings.filter((w) => w.severity === 'critical').length,
    warn_count: warnings.filter((w) => w.severity === 'warn').length,
    ram_used_pct: raw.memory?.ram?.used_pct ?? null,
    swap_used_pct: raw.memory?.swap?.used_pct ?? null,
    load_per_core_15m: raw.load?.load_per_core?.['15m'] ?? null,
    primary_volume_capacity_pct: raw.disk?.primary_data_volume?.capacity_pct ?? null,
    runner_error: null,
    platform: 'darwin',
  };
}

function summarise(ev: DeviceAuditEvidence): string {
  if (ev.critical_count === 0 && ev.warn_count === 0) {
    return 'device healthy — no warnings';
  }
  const severities: string[] = [];
  if (ev.critical_count > 0) severities.push(`${ev.critical_count} critical`);
  if (ev.warn_count > 0) severities.push(`${ev.warn_count} warn`);
  const codesPreview = ev.warnings.slice(0, 3).map((w) => w.code).join(', ');
  const more = ev.warnings.length > 3 ? `, +${ev.warnings.length - 3} more` : '';
  return `${severities.join(', ')}: ${codesPreview}${more}`;
}

function safeParse(raw: string): RawAuditOutput | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RawAuditOutput;
  } catch {
    return null;
  }
}

function emptyEvidence(runnerError: string | null): DeviceAuditEvidence {
  return {
    warnings: [],
    warning_codes: [],
    critical_count: 0,
    warn_count: 0,
    ram_used_pct: null,
    swap_used_pct: null,
    load_per_core_15m: null,
    primary_volume_capacity_pct: null,
    runner_error: runnerError,
    platform: process.platform,
  };
}
