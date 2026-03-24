/**
 * OpenClaw Security Module
 * Detects OpenClaw installation, audits skills for safety,
 * manages rate limiting, and creates sandboxed execution environments.
 */

import { execSync, type SpawnSyncOptions } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { logger } from '../../lib/logger.js';
import type { OpenClawSkillManifest, OpenClawAuditResult, AuditFinding } from './types.js';

// ============================================================================
// KNOWN MALICIOUS SKILLS
// ============================================================================

/** Skills flagged by the ClawHavoc security audit (March 2026) */
const KNOWN_MALICIOUS_SKILLS = new Set([
  'claw-keylogger-v1',
  'claw-exfil-env',
  'claw-reverse-shell',
  'claw-crypto-miner',
  'claw-credential-harvest',
]);

// ============================================================================
// DANGEROUS PATTERNS
// ============================================================================

const DANGEROUS_PATTERNS = [
  { pattern: /\beval\s*\(/, category: 'code_injection', message: 'Uses eval() which can execute arbitrary code' },
  { pattern: /\bexec\s*\(/, category: 'code_injection', message: 'Uses exec() which can run arbitrary commands' },
  { pattern: /\bchild_process\b/, category: 'process_spawn', message: 'Imports child_process module' },
  { pattern: /\bfs\.write/, category: 'filesystem_write', message: 'Writes to filesystem outside sandbox' },
  { pattern: /\bfs\.unlink/, category: 'filesystem_delete', message: 'Deletes files' },
  { pattern: /\bfs\.rmdir/, category: 'filesystem_delete', message: 'Removes directories' },
  { pattern: /\bprocess\.env\b/, category: 'env_access', message: 'Accesses environment variables' },
  { pattern: /\brequire\s*\(\s*['"]https?:/, category: 'remote_code', message: 'Loads remote code' },
  { pattern: /\bfetch\s*\(/, category: 'network', message: 'Makes network requests' },
  { pattern: /\bWebSocket\b/, category: 'network', message: 'Opens WebSocket connections' },
  { pattern: /\bnet\.connect\b/, category: 'network', message: 'Opens raw network connections' },
];

// ============================================================================
// INSTALL DETECTION
// ============================================================================

/**
 * Detect if OpenClaw is installed on the system.
 * Checks common paths and the PATH environment variable.
 */
export function detectOpenClawInstall(): { installed: boolean; path: string; version: string } {
  const commonPaths = process.platform === 'win32'
    ? [
        join(homedir(), '.openclaw', 'bin', 'openclaw.exe'),
        join(process.env.LOCALAPPDATA || '', 'openclaw', 'openclaw.exe'),
      ]
    : [
        join(homedir(), '.openclaw', 'bin', 'openclaw'),
        '/usr/local/bin/openclaw',
        '/opt/homebrew/bin/openclaw',
      ];

  // Check common paths first
  for (const p of commonPaths) {
    if (existsSync(p)) {
      const version = getOpenClawVersion(p);
      if (version) {
        logger.info({ path: p, version }, '[OpenClaw] Detected installation');
        return { installed: true, path: p, version };
      }
    }
  }

  // Check PATH
  try {
    const whichCmd = process.platform === 'win32' ? 'where.exe openclaw' : 'which openclaw';
    const whichResult = execSync(whichCmd, { encoding: 'utf-8', timeout: 5000 }).trim();
    if (whichResult && existsSync(whichResult)) {
      const version = getOpenClawVersion(whichResult);
      if (version) {
        logger.info({ path: whichResult, version }, '[OpenClaw] Detected installation via PATH');
        return { installed: true, path: whichResult, version };
      }
    }
  } catch {
    // Not in PATH
  }

  return { installed: false, path: '', version: '' };
}

function getOpenClawVersion(binaryPath: string): string {
  try {
    const output = execSync(`"${binaryPath}" --version`, { encoding: 'utf-8', timeout: 5000 }).trim();
    // Expected format: "openclaw v1.2.3" or "1.2.3"
    const match = output.match(/v?(\d+\.\d+\.\d+)/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

// ============================================================================
// SKILL AUDIT
// ============================================================================

/**
 * Audit a skill for security issues before allowlisting.
 * Scans for dangerous patterns, known malicious IDs, and permission escalation.
 */
export function auditSkill(manifest: OpenClawSkillManifest, skillSourceDir?: string): OpenClawAuditResult {
  const findings: AuditFinding[] = [];
  const scannedAt = new Date().toISOString();

  // Check against known malicious list
  if (KNOWN_MALICIOUS_SKILLS.has(manifest.id)) {
    findings.push({
      severity: 'critical',
      category: 'known_malicious',
      message: `Skill "${manifest.id}" is in the known malicious skills list (ClawHavoc)`,
    });
  }

  // Check permissions
  if (manifest.permissions.includes('network')) {
    findings.push({
      severity: 'warning',
      category: 'permission',
      message: 'Skill requests network access',
    });
  }
  if (manifest.permissions.includes('filesystem')) {
    findings.push({
      severity: 'warning',
      category: 'permission',
      message: 'Skill requests filesystem access',
    });
  }
  if (manifest.permissions.includes('env')) {
    findings.push({
      severity: 'critical',
      category: 'permission',
      message: 'Skill requests access to environment variables',
    });
  }

  // Scan source files for dangerous patterns
  if (skillSourceDir && existsSync(skillSourceDir)) {
    const sourceFindings = scanDirectoryForPatterns(skillSourceDir);
    findings.push(...sourceFindings);
  }

  const hasDangerousPatterns = findings.some(f => f.severity === 'critical');
  const passed = !hasDangerousPatterns;

  logger.info(
    { skillId: manifest.id, passed, findingsCount: findings.length },
    '[OpenClaw] Skill audit completed'
  );

  return {
    skillId: manifest.id,
    passed,
    findings,
    scannedAt,
    hasDangerousPatterns,
  };
}

function scanDirectoryForPatterns(dir: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const scanExtensions = new Set(['.js', '.ts', '.mjs', '.cjs', '.py', '.sh']);

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        findings.push(...scanDirectoryForPatterns(fullPath));
      } else if (entry.isFile()) {
        const ext = entry.name.substring(entry.name.lastIndexOf('.'));
        if (scanExtensions.has(ext) && statSync(fullPath).size < 1_000_000) {
          const content = readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            for (const { pattern, category, message } of DANGEROUS_PATTERNS) {
              if (pattern.test(lines[i])) {
                findings.push({
                  severity: category === 'code_injection' || category === 'remote_code' ? 'critical' : 'warning',
                  category,
                  message,
                  line: i + 1,
                  file: fullPath,
                });
              }
            }
          }
        }
      }
    }
  } catch (err) {
    logger.warn({ err, dir }, '[OpenClaw] Error scanning directory');
  }

  return findings;
}

// ============================================================================
// RATE LIMITER
// ============================================================================

export class RateLimiter {
  private minuteBuckets = new Map<string, number[]>();
  private hourBuckets = new Map<string, number[]>();

  constructor(
    private maxPerMinute: number,
    private maxPerHour: number,
  ) {}

  /**
   * Check if a call is allowed. Returns true if within limits.
   * Automatically records the call if allowed.
   */
  tryConsume(skillId: string): boolean {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;
    const oneHourAgo = now - 3_600_000;

    // Clean and check minute bucket
    const minuteCalls = (this.minuteBuckets.get(skillId) ?? []).filter(t => t > oneMinuteAgo);
    if (minuteCalls.length >= this.maxPerMinute) {
      logger.warn({ skillId, count: minuteCalls.length }, '[OpenClaw] Rate limit exceeded (per-minute)');
      return false;
    }

    // Clean and check hour bucket
    const hourCalls = (this.hourBuckets.get(skillId) ?? []).filter(t => t > oneHourAgo);
    if (hourCalls.length >= this.maxPerHour) {
      logger.warn({ skillId, count: hourCalls.length }, '[OpenClaw] Rate limit exceeded (per-hour)');
      return false;
    }

    // Record the call
    minuteCalls.push(now);
    hourCalls.push(now);
    this.minuteBuckets.set(skillId, minuteCalls);
    this.hourBuckets.set(skillId, hourCalls);

    return true;
  }

  /** Get current usage for a skill */
  getUsage(skillId: string): { minuteCount: number; hourCount: number } {
    const now = Date.now();
    const minuteCalls = (this.minuteBuckets.get(skillId) ?? []).filter(t => t > now - 60_000);
    const hourCalls = (this.hourBuckets.get(skillId) ?? []).filter(t => t > now - 3_600_000);
    return { minuteCount: minuteCalls.length, hourCount: hourCalls.length };
  }
}

// ============================================================================
// SANDBOX ENVIRONMENT
// ============================================================================

/**
 * Create a sandboxed environment for running OpenClaw skills.
 * Strips PATH to minimum, uses temp HOME, and optionally blocks network.
 */
export function createSandboxEnv(allowNetwork: boolean): Record<string, string> {
  const sandboxHome = join(tmpdir(), 'openclaw-sandbox-' + Date.now());

  const isWin = process.platform === 'win32';
  const env: Record<string, string> = {
    ...(isWin
      ? { USERPROFILE: sandboxHome, TEMP: sandboxHome, TMP: sandboxHome, PATH: 'C:\\Windows\\System32;C:\\Windows' }
      : { HOME: sandboxHome, TMPDIR: sandboxHome, PATH: '/usr/bin:/bin' }),
    LANG: 'en_US.UTF-8',
    OPENCLAW_SANDBOX: '1',
  };

  if (!allowNetwork) {
    // Set a flag that the shim can use to enforce network isolation
    env['OPENCLAW_NO_NETWORK'] = '1';
  }

  return env;
}

/**
 * Get spawn options for a sandboxed OpenClaw skill execution.
 */
export function getSandboxSpawnOptions(
  allowNetwork: boolean,
  timeoutMs: number,
): SpawnSyncOptions {
  return {
    env: createSandboxEnv(allowNetwork),
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024, // 10MB max output
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  };
}
