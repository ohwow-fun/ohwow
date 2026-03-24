#!/usr/bin/env tsx
/**
 * Multi-environment env checker for ohwow.
 *
 * Usage:
 *   npm run check-env                        # check local .env.local (default)
 *   npm run check-env -- --env=vercel         # check Vercel production env
 *   npm run check-env -- --env=fly            # check Fly.io worker secrets
 *   npm run check-env -- --env=all            # check all three, combined report
 *   npm run check-env -- --verbose            # show all vars including set ones
 *   npm run check-env -- --tier=1,2           # only check tier 1 and 2 vars
 */

import { execSync } from 'node:child_process';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Types ───────────────────────────────────────────────

type EnvTarget = 'local' | 'vercel' | 'fly' | 'all';

interface EnvVar {
  key: string;
  optional?: boolean;
  hint?: string;
}

interface EnvGroup {
  name: string;
  tier: number;
  vars: EnvVar[];
}

interface CheckResult {
  target: string;
  groups: GroupResult[];
  missing: number;
  total: number;
}

interface GroupResult {
  name: string;
  tier: number;
  vars: VarResult[];
}

interface VarResult {
  key: string;
  set: boolean;
  optional: boolean;
  hint?: string;
  /** For name-only checks (Fly), true means the name exists */
  nameOnly?: boolean;
}

// ─── CLI Parsing ─────────────────────────────────────────

function parseArgs(): { target: EnvTarget; verbose: boolean; tiers: Set<number> | null } {
  const args = process.argv.slice(2);
  let target: EnvTarget = 'local';
  let verbose = false;
  let tiers: Set<number> | null = null;

  for (const arg of args) {
    if (arg.startsWith('--env=')) {
      const val = arg.slice(6) as EnvTarget;
      if (!['local', 'vercel', 'fly', 'all'].includes(val)) {
        console.error(`Unknown env target: ${val}. Use local, vercel, fly, or all.`);
        process.exit(1);
      }
      target = val;
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg.startsWith('--tier=')) {
      tiers = new Set(arg.slice(7).split(',').map(Number));
    }
  }

  return { target, verbose, tiers };
}

// ─── Env Group Definitions ───────────────────────────────

const localGroups: EnvGroup[] = [
  {
    name: 'Core',
    tier: 1,
    vars: [
      { key: 'OHWOW_PORT', optional: true, hint: 'defaults to 7700' },
      { key: 'OHWOW_DB_PATH', optional: true, hint: 'defaults to ~/.ohwow/ohwow.db' },
      { key: 'OHWOW_LOCAL_URL', optional: true },
      { key: 'OHWOW_CLOUD_URL', optional: true },
      { key: 'OHWOW_HEADLESS', optional: true },
      { key: 'OHWOW_LICENSE_KEY', optional: true },
    ],
  },
  {
    name: 'AI Models',
    tier: 1,
    vars: [
      { key: 'ANTHROPIC_API_KEY', optional: true, hint: 'needed for Claude models' },
      { key: 'ANTHROPIC_OAUTH_TOKEN', optional: true, hint: 'alternative to API key' },
      { key: 'OHWOW_MODEL_SOURCE', optional: true, hint: 'anthropic, ollama, or openrouter' },
      { key: 'OHWOW_CLOUD_MODEL', optional: true },
      { key: 'OHWOW_PREFER_LOCAL', optional: true },
    ],
  },
  {
    name: 'Ollama',
    tier: 2,
    vars: [
      { key: 'OHWOW_OLLAMA_URL', optional: true, hint: 'defaults to http://127.0.0.1:11434' },
      { key: 'OHWOW_OLLAMA_MODEL', optional: true, hint: 'defaults to qwen3:4b' },
      { key: 'OHWOW_ORCHESTRATOR_MODEL', optional: true },
      { key: 'OHWOW_QUICK_MODEL', optional: true },
      { key: 'OHWOW_OCR_MODEL', optional: true },
    ],
  },
  {
    name: 'OpenRouter',
    tier: 2,
    vars: [
      { key: 'OPENROUTER_API_KEY', optional: true },
      { key: 'OPENROUTER_MODEL', optional: true },
    ],
  },
  {
    name: 'Browser Automation',
    tier: 3,
    vars: [
      { key: 'OHWOW_BROWSER_HEADLESS', optional: true },
    ],
  },
  {
    name: 'Scrapling',
    tier: 3,
    vars: [
      { key: 'OHWOW_SCRAPLING_PORT', optional: true },
      { key: 'OHWOW_SCRAPLING_AUTO_START', optional: true },
      { key: 'OHWOW_SCRAPLING_PROXY', optional: true },
    ],
  },
  {
    name: 'Networking',
    tier: 2,
    vars: [
      { key: 'OHWOW_WORKSPACE_GROUP', optional: true },
      { key: 'OHWOW_DEVICE_ROLE', optional: true },
      { key: 'OHWOW_TUNNEL_ENABLED', optional: true },
    ],
  },
  {
    name: 'Enterprise',
    tier: 3,
    vars: [
      { key: 'ENTERPRISE_JWT_SECRET', optional: true },
    ],
  },
];

const vercelGroups: EnvGroup[] = [
  {
    name: 'Core (Vercel)',
    tier: 1,
    vars: [
      { key: 'OHWOW_LICENSE_KEY' },
      { key: 'OHWOW_CLOUD_URL', optional: true },
    ],
  },
  {
    name: 'AI Models (Vercel)',
    tier: 1,
    vars: [
      { key: 'ANTHROPIC_API_KEY', hint: 'needed for Claude models' },
      { key: 'OHWOW_MODEL_SOURCE', optional: true },
      { key: 'OHWOW_CLOUD_MODEL', optional: true },
    ],
  },
  {
    name: 'Enterprise (Vercel)',
    tier: 2,
    vars: [
      { key: 'ENTERPRISE_JWT_SECRET', optional: true },
    ],
  },
];

const flyGroups: EnvGroup[] = [
  {
    name: 'Supabase (Worker)',
    tier: 1,
    vars: [
      { key: 'SUPABASE_URL' },
      { key: 'SUPABASE_SERVICE_KEY' },
    ],
  },
  {
    name: 'App Connectivity',
    tier: 1,
    vars: [
      { key: 'WEBHOOK_SECRET' },
      { key: 'APP_BASE_URL' },
    ],
  },
  {
    name: 'Voice (Worker)',
    tier: 3,
    vars: [
      { key: 'ELEVENLABS_API_KEY', optional: true },
      { key: 'DEEPGRAM_API_KEY', optional: true },
      { key: 'WORKER_PUBLIC_URL', optional: true },
    ],
  },
  {
    name: 'Worker Config',
    tier: 2,
    vars: [
      { key: 'PORT', optional: true, hint: 'defaults to 8080 on Fly' },
    ],
  },
];

// ─── Env Loaders ─────────────────────────────────────────

function parseDotenv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loadLocalEnv(): Record<string, string> {
  const envPath = resolve(process.cwd(), '.env.local');
  if (!existsSync(envPath)) {
    console.warn('  No .env.local found. Checking process.env only.\n');
    return { ...process.env } as Record<string, string>;
  }
  const content = readFileSync(envPath, 'utf-8');
  const fileEnv = parseDotenv(content);
  // Merge: file vars + process.env (process.env takes precedence)
  return { ...fileEnv, ...process.env } as Record<string, string>;
}

function loadVercelEnv(): Record<string, string> {
  const tmpPath = '/tmp/.env.vercel.ohwow';
  try {
    execSync('which vercel', { stdio: 'ignore' });
  } catch {
    console.error('  vercel CLI not found. Install with: npm i -g vercel');
    process.exit(1);
  }

  try {
    execSync(`vercel env pull ${tmpPath} --environment=production --yes`, {
      stdio: 'pipe',
      timeout: 30_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Failed to pull Vercel env: ${msg}`);
    console.error('  Make sure you have run "vercel link" in this project.');
    process.exit(1);
  }

  try {
    const content = readFileSync(tmpPath, 'utf-8');
    return parseDotenv(content);
  } finally {
    try { unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
  }
}

function loadFlySecretNames(): Set<string> {
  try {
    execSync('which flyctl', { stdio: 'ignore' });
  } catch {
    console.error('  flyctl CLI not found. Install from: https://fly.io/docs/flyctl/install/');
    process.exit(1);
  }

  try {
    const output = execSync('flyctl secrets list -a ohwow-worker --json', {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    }).toString();
    const secrets = JSON.parse(output) as Array<{ Name: string }>;
    return new Set(secrets.map((s) => s.Name));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Failed to list Fly secrets: ${msg}`);
    console.error('  Make sure you are authenticated with flyctl.');
    process.exit(1);
  }
}

// ─── Check Logic ─────────────────────────────────────────

type EnvSource = Record<string, string> | Set<string>;

function checkEnv(
  groups: EnvGroup[],
  source: EnvSource,
  label: string,
  tiers: Set<number> | null,
  verbose: boolean,
): CheckResult {
  const isNameSet = source instanceof Set;
  const filteredGroups = tiers
    ? groups.filter((g) => tiers.has(g.tier))
    : groups;

  const groupResults: GroupResult[] = [];
  let missing = 0;
  let total = 0;

  for (const group of filteredGroups) {
    const varResults: VarResult[] = [];

    for (const v of group.vars) {
      total++;
      const isSet = isNameSet ? source.has(v.key) : !!(source as Record<string, string>)[v.key];
      if (!isSet && !v.optional) missing++;

      varResults.push({
        key: v.key,
        set: isSet,
        optional: v.optional ?? false,
        hint: v.hint,
        nameOnly: isNameSet ? true : undefined,
      });
    }

    groupResults.push({ name: group.name, tier: group.tier, vars: varResults });
  }

  return { target: label, groups: groupResults, missing, total };
}

// ─── Display ─────────────────────────────────────────────

function printResult(result: CheckResult, verbose: boolean): void {
  const { target, groups, missing, total } = result;
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  ${target}`);
  console.log('='.repeat(50));

  for (const group of groups) {
    const groupMissing = group.vars.filter((v) => !v.set && !v.optional);
    const hasIssues = groupMissing.length > 0;

    if (!verbose && !hasIssues) {
      // Show compact line for fully-set groups
      const setCount = group.vars.filter((v) => v.set).length;
      console.log(`  [OK] ${group.name} (${setCount}/${group.vars.length} set)`);
      continue;
    }

    console.log(`\n  ${group.name} (tier ${group.tier}):`);
    for (const v of group.vars) {
      if (!verbose && v.set) continue;
      const icon = v.set ? '\x1b[32m+\x1b[0m' : (v.optional ? '\x1b[33m-\x1b[0m' : '\x1b[31mx\x1b[0m');
      const label = v.nameOnly ? '(name exists)' : (v.set ? 'set' : 'missing');
      const hint = v.hint ? ` (${v.hint})` : '';
      const opt = v.optional && !v.set ? ' [optional]' : '';
      console.log(`    ${icon} ${v.key}: ${label}${opt}${hint}`);
    }
  }

  const setCount = total - missing;
  const statusColor = missing === 0 ? '\x1b[32m' : '\x1b[31m';
  console.log(`\n  ${statusColor}${setCount}/${total} required vars set\x1b[0m`);
  if (missing > 0) {
    console.log(`  \x1b[31m${missing} required var(s) missing\x1b[0m`);
  }
}

function printCrossEnvCheck(results: CheckResult[]): void {
  // Find vars that appear in multiple environments and check consistency
  const varsByEnv = new Map<string, Set<string>>();
  for (const result of results) {
    const vars = new Set<string>();
    for (const group of result.groups) {
      for (const v of group.vars) {
        if (v.set) vars.add(v.key);
      }
    }
    varsByEnv.set(result.target, vars);
  }

  // Find shared var names across environments
  const allVarNames = new Set<string>();
  for (const vars of varsByEnv.values()) {
    for (const v of vars) allVarNames.add(v);
  }

  const inconsistencies: string[] = [];
  const envNames = [...varsByEnv.keys()];

  for (const varName of allVarNames) {
    const presentIn = envNames.filter((env) => varsByEnv.get(env)!.has(varName));
    const absentFrom = envNames.filter((env) => !varsByEnv.get(env)!.has(varName));

    // Only flag if the var is expected in the absent environment
    // (i.e., it appears in that environment's group definitions)
    if (presentIn.length > 0 && absentFrom.length > 0) {
      const allGroupVars = new Map<string, Set<string>>();
      for (const result of results) {
        const expected = new Set<string>();
        for (const group of result.groups) {
          for (const v of group.vars) expected.add(v.key);
        }
        allGroupVars.set(result.target, expected);
      }

      const expectedAbsent = absentFrom.filter((env) => allGroupVars.get(env)!.has(varName));
      if (expectedAbsent.length > 0) {
        inconsistencies.push(
          `  ${varName}: set in [${presentIn.join(', ')}], missing in [${expectedAbsent.join(', ')}]`
        );
      }
    }
  }

  if (inconsistencies.length > 0) {
    console.log(`\n${'='.repeat(50)}`);
    console.log('  Cross-Environment Consistency');
    console.log('='.repeat(50));
    console.log('\n  Shared vars with mismatches:\n');
    for (const line of inconsistencies) {
      console.log(`  \x1b[33m${line}\x1b[0m`);
    }
  }
}

// ─── Main ────────────────────────────────────────────────

function main(): void {
  const { target, verbose, tiers } = parseArgs();

  const targets: EnvTarget[] = target === 'all' ? ['local', 'vercel', 'fly'] : [target];
  const results: CheckResult[] = [];
  let hasFailure = false;

  for (const t of targets) {
    switch (t) {
      case 'local': {
        console.log('\nChecking local environment...');
        const env = loadLocalEnv();
        const result = checkEnv(localGroups, env, 'Local (.env.local)', tiers, verbose);
        printResult(result, verbose);
        results.push(result);
        if (result.missing > 0) hasFailure = true;
        break;
      }
      case 'vercel': {
        console.log('\nChecking Vercel production environment...');
        const env = loadVercelEnv();
        const result = checkEnv(vercelGroups, env, 'Vercel (production)', tiers, verbose);
        printResult(result, verbose);
        results.push(result);
        if (result.missing > 0) hasFailure = true;
        break;
      }
      case 'fly': {
        console.log('\nChecking Fly.io worker secrets...');
        const names = loadFlySecretNames();
        const result = checkEnv(flyGroups, names, 'Fly.io (ohwow-worker)', tiers, verbose);
        printResult(result, verbose);
        results.push(result);
        if (result.missing > 0) hasFailure = true;
        break;
      }
    }
  }

  if (target === 'all' && results.length > 1) {
    printCrossEnvCheck(results);
  }

  // Summary for --env=all
  if (target === 'all') {
    console.log(`\n${'='.repeat(50)}`);
    console.log('  Summary');
    console.log('='.repeat(50));
    for (const r of results) {
      const icon = r.missing === 0 ? '\x1b[32m[OK]\x1b[0m' : '\x1b[31m[!!]\x1b[0m';
      console.log(`  ${icon} ${r.target}: ${r.total - r.missing}/${r.total} required`);
    }
    console.log();
  }

  if (hasFailure) {
    process.exit(1);
  }
}

main();
