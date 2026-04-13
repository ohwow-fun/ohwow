/* eslint-disable no-console */
/**
 * ohwow — Runtime Entry Point
 *
 * CLI:
 *   ohwow          → Start TUI (default)
 *   ohwow stop     → Stop the daemon
 *   ohwow status   → Check daemon status
 *   ohwow logs     → Tail daemon logs
 *   ohwow restart  → Restart the daemon
 *   ohwow --daemon → Start daemon in foreground (for systemd/launchd/Docker)
 *
 * Tiers:
 * - Free: Local agents, local LLM, chat, basic dashboard. No cloud connection.
 * - Connected: Full features including cloud sync, integrations, scheduling.
 */

import { checkForUpdate } from './update-check.js';
import { startTui } from './tui/render.js';
import { VERSION } from './version.js';

// Parse --workspace=<name> early so all downstream code (subcommands, the
// daemon, dynamically loaded config) honors it uniformly through the resolver
// in src/config.ts. The env var is the single source of truth at runtime.
const workspaceFlag = process.argv.find((a) => a.startsWith('--workspace='))?.split('=')[1];
if (workspaceFlag) {
  process.env.OHWOW_WORKSPACE = workspaceFlag;
}

await checkForUpdate(VERSION);

const subcommand = process.argv[2];
const isDaemon = process.argv.includes('--daemon') || process.env.OHWOW_HEADLESS === '1';

if (subcommand === 'logs') {
  const { dirname } = await import('path');
  const { loadConfig, resolveActiveWorkspace } = await import('./config.js');
  let dataDir: string;
  try {
    const config = loadConfig();
    dataDir = dirname(config.dbPath);
  } catch {
    dataDir = resolveActiveWorkspace().dataDir;
  }
  const { getLogPath } = await import('./daemon/lifecycle.js');
  const logPath = getLogPath(dataDir);
  const { existsSync } = await import('fs');
  if (!existsSync(logPath)) {
    console.log('No daemon log file found. Start the daemon first.');
    process.exit(1);
  }
  const { spawn: spawnTail } = await import('child_process');
  const logArgs = process.platform === 'win32'
    ? { cmd: 'powershell.exe', args: ['-NoProfile', '-Command', `Get-Content -Path '${logPath}' -Tail 100 -Wait`] }
    : { cmd: 'tail', args: ['-f', '-n', '100', logPath] };
  const tail = spawnTail(logArgs.cmd, logArgs.args, { stdio: 'inherit' });
  tail.on('exit', (code) => process.exit(code ?? 0));
  process.on('SIGINT', () => { tail.kill(); process.exit(0); });
} else if (subcommand === 'stop') {
  const { dirname } = await import('path');
  const { loadConfig, resolveActiveWorkspace } = await import('./config.js');
  let dataDir: string;
  try {
    const config = loadConfig();
    dataDir = dirname(config.dbPath);
  } catch {
    dataDir = resolveActiveWorkspace().dataDir;
  }
  const { stopDaemon } = await import('./daemon/lifecycle.js');
  const stopped = await stopDaemon(dataDir);
  console.log(stopped ? 'Daemon stopped.' : 'No daemon running.');
  process.exit(0);
} else if (subcommand === 'restart') {
  const { dirname } = await import('path');
  const { loadConfig, resolveActiveWorkspace, DEFAULT_PORT } = await import('./config.js');
  let dataDir: string;
  let port: number;
  try {
    const config = loadConfig();
    dataDir = dirname(config.dbPath);
    port = config.port;
  } catch {
    dataDir = resolveActiveWorkspace().dataDir;
    port = DEFAULT_PORT;
  }
  const { stopDaemon, waitForDaemonStop, startDaemonBackground, waitForDaemon } = await import('./daemon/lifecycle.js');
  const stopped = await stopDaemon(dataDir);
  if (stopped) {
    console.log('Stopping daemon...');
    await waitForDaemonStop(dataDir, 5000);
  }
  const { fileURLToPath } = await import('url');
  // When running via tsx (dev), import.meta.url points to .ts — resolve to .ts so lifecycle uses tsx loader
  const selfPath = fileURLToPath(import.meta.url);
  const entryPath = selfPath.endsWith('.ts') ? selfPath : fileURLToPath(new URL('./index.js', import.meta.url));
  startDaemonBackground(entryPath, port, dataDir);
  const ready = await waitForDaemon(port, 15000);
  console.log(ready ? 'Daemon restarted.' : 'Daemon restart timed out. Check "ohwow logs" for details.');
  process.exit(0);
} else if (subcommand === 'status') {
  const { dirname } = await import('path');
  const { loadConfig, resolveActiveWorkspace, DEFAULT_PORT } = await import('./config.js');
  let dataDir: string;
  let port: number;
  const active = resolveActiveWorkspace();
  try {
    const config = loadConfig();
    dataDir = dirname(config.dbPath);
    port = config.port;
  } catch {
    dataDir = active.dataDir;
    port = DEFAULT_PORT;
  }
  const { isDaemonRunning } = await import('./daemon/lifecycle.js');
  const result = await isDaemonRunning(dataDir, port);
  if (result.running) {
    console.log(`Daemon running (PID ${result.pid}) on port ${port} — workspace "${active.name}"`);
  } else {
    console.log(`No daemon running. (workspace "${active.name}")`);
  }
  process.exit(0);
} else if (subcommand === 'workspace') {
  const action = process.argv[3];
  const {
    resolveActiveWorkspace,
    listWorkspaces,
    workspaceLayoutFor,
    writeWorkspacePointer,
    isValidWorkspaceName,
    loadConfig,
    DEFAULT_PORT,
  } = await import('./config.js');

  if (!action || action === 'list') {
    const active = resolveActiveWorkspace();
    const all = new Set(listWorkspaces());
    // The active workspace may not have a directory yet (legacy install or
    // fresh install before first daemon boot). Show it anyway.
    all.add(active.name);
    const sorted = Array.from(all).sort();
    for (const name of sorted) {
      const marker = name === active.name ? '*' : ' ';
      console.log(`${marker} ${name}`);
    }
    if (sorted.length === 1) {
      console.log('');
      console.log('Run "ohwow workspace create <name>" to add another workspace.');
    }
    process.exit(0);
  }

  if (action === 'current') {
    console.log(resolveActiveWorkspace().name);
    process.exit(0);
  }

  if (action === 'create') {
    const name = process.argv[4];
    if (!name) {
      console.error('Usage: ohwow workspace create <name>');
      process.exit(1);
    }
    if (!isValidWorkspaceName(name)) {
      console.error('Workspace name must be alphanumeric, dash, or underscore (no leading dot/dash).');
      process.exit(1);
    }
    const { mkdirSync, existsSync } = await import('fs');
    const layout = workspaceLayoutFor(name);
    if (existsSync(layout.dataDir)) {
      console.log(`Workspace "${name}" already exists at ${layout.dataDir}`);
      process.exit(0);
    }
    mkdirSync(layout.dataDir, { recursive: true });
    console.log(`Created workspace "${name}" at ${layout.dataDir}`);
    console.log(`Run "ohwow workspace use ${name}" to switch.`);
    process.exit(0);
  }

  if (action === 'use') {
    const name = process.argv[4];
    const force = process.argv.includes('--restart');
    if (!name) {
      console.error('Usage: ohwow workspace use <name> [--restart]');
      process.exit(1);
    }
    if (!isValidWorkspaceName(name)) {
      console.error('Workspace name must be alphanumeric, dash, or underscore.');
      process.exit(1);
    }

    const current = resolveActiveWorkspace();
    if (current.name === name && !force) {
      console.log(`Already on workspace "${name}". Pass --restart to force a daemon restart.`);
      process.exit(0);
    }

    const {
      stopDaemon,
      waitForDaemonStop,
      startDaemonBackground,
      waitForDaemon,
      isDaemonRunning,
    } = await import('./daemon/lifecycle.js');

    let port: number;
    try {
      port = loadConfig().port;
    } catch {
      port = DEFAULT_PORT;
    }

    // Was the daemon running on the current workspace?
    const status = await isDaemonRunning(current.dataDir, port);
    const wasRunning = status.running;

    if (wasRunning) {
      console.log(`Stopping daemon on workspace "${current.name}"...`);
      const stopped = await stopDaemon(current.dataDir);
      if (stopped) await waitForDaemonStop(current.dataDir, 5000);
    }

    // Ensure the target workspace dir exists, then update the pointer.
    const targetLayout = workspaceLayoutFor(name);
    const { mkdirSync, existsSync } = await import('fs');
    if (!existsSync(targetLayout.dataDir)) {
      mkdirSync(targetLayout.dataDir, { recursive: true });
    }
    writeWorkspacePointer(name);
    console.log(`Switched to workspace "${name}".`);

    // Restart the daemon only if one was running, or if --restart was passed.
    if (wasRunning || force) {
      // Make the resolver in the spawned child see the new workspace
      // immediately (writeWorkspacePointer + env both work, env is faster).
      process.env.OHWOW_WORKSPACE = name;

      const { fileURLToPath } = await import('url');
      // When running via tsx (dev), import.meta.url points to .ts — resolve to
      // .ts so lifecycle uses the tsx loader.
      const selfPath = fileURLToPath(import.meta.url);
      const entryPath = selfPath.endsWith('.ts')
        ? selfPath
        : fileURLToPath(new URL('./index.js', import.meta.url));
      startDaemonBackground(entryPath, port, targetLayout.dataDir);
      const ready = await waitForDaemon(port, 15000);
      console.log(
        ready
          ? `Daemon started on workspace "${name}".`
          : `Daemon start timed out. Check "ohwow logs" for details.`,
      );
    }

    process.exit(0);
  }

  console.error(`Unknown workspace action: ${action}`);
  console.error('Usage: ohwow workspace [list|current|create <name>|use <name> [--restart]]');
  process.exit(1);
} else if (subcommand === 'mcp-server') {
  const { startMcpServer } = await import('./mcp-server/index.js');
  await startMcpServer();
} else if (subcommand === 'setup-claude-code') {
  const { enableClaudeCodeIntegration } = await import('./mcp-server/setup.js');
  const msg = enableClaudeCodeIntegration();
  console.log(msg);
  process.exit(0);
} else if (subcommand === 'improve') {
  // Self-improvement cycle: compress memories, mine patterns, synthesize skills, etc.
  const { loadConfig } = await import('./config.js');
  const { initDatabase } = await import('./db/init.js');
  const { createSqliteAdapter } = await import('./db/sqlite-adapter.js');
  const { ModelRouter } = await import('./execution/model-router.js');
  const { runImprovementCycle } = await import('./lib/self-improvement/improve.js');

  const config = loadConfig();
  const rawDb = initDatabase(config.dbPath);
  const db = createSqliteAdapter(rawDb);
  const router = new ModelRouter({
    anthropicApiKey: config.anthropicApiKey,
    ollamaUrl: config.ollamaUrl,
    ollamaModel: config.ollamaModel,
    preferLocalModel: config.preferLocalModel,
    modelSource: config.modelSource,
    claudeCodeCliPath: config.claudeCodeCliPath || undefined,
    claudeCodeCliModel: config.claudeCodeCliModel || undefined,
  });

  const skipLLM = process.argv.includes('--local-only');
  const agentId = process.argv.find((a) => a.startsWith('--agent='))?.split('=')[1];

  console.log('Running self-improvement cycle...');
  if (skipLLM) console.log('(LLM-dependent steps skipped with --local-only)');
  console.log('');

  try {
    const result = await runImprovementCycle(db, router, config.workspaceGroup || 'default', { agentId, skipLLM });

    console.log('Self-improvement cycle completed.');
    console.log('');
    if (result.compression) {
      console.log(`  Memory compression:  ${result.compression.compressedCreated} created, ${result.compression.episodicSuperseded} superseded`);
    }
    if (result.patternMining) {
      console.log(`  Pattern mining:      ${result.patternMining.patternsFound} patterns found`);
    }
    if (result.skillSynthesis) {
      console.log(`  Skill synthesis:     ${result.skillSynthesis.skillsCreated} skills created`);
    }
    if (result.processMining) {
      console.log(`  Process mining:      ${result.processMining.processesDiscovered} processes discovered`);
    }
    if (result.principleDistillation) {
      console.log(`  Principle distillation: ${result.principleDistillation.principlesCreated} principles created`);
    }
    if (result.signalEvaluation) {
      console.log(`  Signal evaluation:   ${result.signalEvaluation.signalsFound} signals found`);
    }
    if (result.digitalTwin) {
      console.log(`  Digital twin:        ${result.digitalTwin.edgesCount} causal edges (confidence: ${result.digitalTwin.confidence.toFixed(2)})`);
    }
    console.log('');
    console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s | Tokens: ${result.totalTokensUsed} | Cost: $${(result.totalCostCents / 100).toFixed(4)}`);
  } catch (err) {
    console.error('Self-improvement cycle failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
  process.exit(0);
} else if (isDaemon) {
  // Daemon mode: start services + HTTP server, no TUI
  const { startDaemon } = await import('./daemon/start.js');
  startDaemon().catch(err => {
    console.error('[daemon] Fatal error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else if (!subcommand) {
  // Default: start TUI
  startTui();
} else {
  // Unknown subcommand
  console.log(`Unknown command: ${subcommand}`);
  console.log('');
  console.log('Usage:');
  console.log('  ohwow                   Start the TUI dashboard');
  console.log('  ohwow stop              Stop the daemon');
  console.log('  ohwow status            Check daemon status');
  console.log('  ohwow logs              Tail daemon logs');
  console.log('  ohwow restart           Restart the daemon');
  console.log('  ohwow improve           Run self-improvement cycle');
  console.log('  ohwow workspace         Manage workspaces (list|current|create|use)');
  console.log('  ohwow mcp-server        Start MCP server for Claude Code');
  console.log('  ohwow setup-claude-code Enable Claude Code integration');
  console.log('');
  console.log('Global flags:');
  console.log('  --workspace=<name>      Run against a specific workspace (overrides pointer)');
  process.exit(1);
}
