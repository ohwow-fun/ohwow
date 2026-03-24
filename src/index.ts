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

// Re-exports for consumers
export { createSqliteAdapter } from './db/sqlite-adapter.js';
export type { SqliteAdapterOptions } from './db/sqlite-adapter.js';

await checkForUpdate(VERSION);

const subcommand = process.argv[2];
const isDaemon = process.argv.includes('--daemon') || process.env.OHWOW_HEADLESS === '1';

if (subcommand === 'logs') {
  const { dirname } = await import('path');
  const { loadConfig, DEFAULT_DB_PATH } = await import('./config.js');
  let dataDir: string;
  try {
    const config = loadConfig();
    dataDir = dirname(config.dbPath);
  } catch {
    dataDir = dirname(DEFAULT_DB_PATH);
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
  const { loadConfig, DEFAULT_DB_PATH } = await import('./config.js');
  let dataDir: string;
  try {
    const config = loadConfig();
    dataDir = dirname(config.dbPath);
  } catch {
    dataDir = dirname(DEFAULT_DB_PATH);
  }
  const { stopDaemon } = await import('./daemon/lifecycle.js');
  const stopped = await stopDaemon(dataDir);
  console.log(stopped ? 'Daemon stopped.' : 'No daemon running.');
  process.exit(0);
} else if (subcommand === 'restart') {
  const { dirname } = await import('path');
  const { loadConfig, DEFAULT_DB_PATH, DEFAULT_PORT } = await import('./config.js');
  let dataDir: string;
  let port: number;
  try {
    const config = loadConfig();
    dataDir = dirname(config.dbPath);
    port = config.port;
  } catch {
    dataDir = dirname(DEFAULT_DB_PATH);
    port = DEFAULT_PORT;
  }
  const { stopDaemon, waitForDaemonStop, startDaemonBackground, waitForDaemon } = await import('./daemon/lifecycle.js');
  const stopped = await stopDaemon(dataDir);
  if (stopped) {
    console.log('Stopping daemon...');
    await waitForDaemonStop(dataDir, 5000);
  }
  const { fileURLToPath } = await import('url');
  const entryPath = fileURLToPath(new URL('./index.js', import.meta.url));
  startDaemonBackground(entryPath, port, dataDir);
  const ready = await waitForDaemon(port, 15000);
  console.log(ready ? 'Daemon restarted.' : 'Daemon restart timed out. Check "ohwow logs" for details.');
  process.exit(0);
} else if (subcommand === 'status') {
  const { dirname } = await import('path');
  const { loadConfig, DEFAULT_DB_PATH, DEFAULT_PORT } = await import('./config.js');
  let dataDir: string;
  let port: number;
  try {
    const config = loadConfig();
    dataDir = dirname(config.dbPath);
    port = config.port;
  } catch {
    dataDir = dirname(DEFAULT_DB_PATH);
    port = DEFAULT_PORT;
  }
  const { isDaemonRunning } = await import('./daemon/lifecycle.js');
  const result = await isDaemonRunning(dataDir, port);
  if (result.running) {
    console.log(`Daemon running (PID ${result.pid}) on port ${port}`);
  } else {
    console.log('No daemon running.');
  }
  process.exit(0);
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
  console.log('  ohwow mcp-server        Start MCP server for Claude Code');
  console.log('  ohwow setup-claude-code Enable Claude Code integration');
  process.exit(1);
}
