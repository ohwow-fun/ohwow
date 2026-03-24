import https from 'https';
import { execSync } from 'child_process';
import { dirname } from 'path';
import { loadConfig, DEFAULT_DB_PATH, DEFAULT_PORT } from './config.js';
import { isDaemonRunning, stopDaemon, waitForDaemonStop } from './daemon/lifecycle.js';
import { logger } from './lib/logger.js';

const PKG = 'ohwow';

function fetchLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(
      `https://registry.npmjs.org/${PKG}/latest`,
      { timeout: 3000 },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data).version);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function isNewer(latest: string, current: string): boolean {
  const l = latest.split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

async function fetchQueueStatus(port: number): Promise<{ active: number; waiting: number } | null> {
  try {
    const res = await fetch(`http://localhost:${port}/api/daemon/queue-status`);
    if (!res.ok) return null;
    return await res.json() as { active: number; waiting: number };
  } catch {
    return null;
  }
}

async function waitForTasksDrain(port: number, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await fetchQueueStatus(port);
    if (!status || (status.active === 0 && status.waiting === 0)) return true;
    logger.info(`  Waiting for ${status.active + status.waiting} running task(s) to finish...`);
    await new Promise(r => setTimeout(r, 3000));
  }
  return false;
}

function getGlobalInstalledVersion(): string | null {
  try {
    const out = execSync(`npm list -g ${PKG} --json`, { encoding: 'utf-8', timeout: 10_000 });
    const data = JSON.parse(out);
    return data.dependencies?.[PKG]?.version ?? null;
  } catch {
    return null;
  }
}

export async function checkForUpdate(currentVersion: string): Promise<void> {
  if (
    process.argv.includes('--no-update-check') ||
    process.env.OHWOW_NO_UPDATE_CHECK === '1'
  ) {
    return;
  }
  if (!process.stdout.isTTY) return;

  const latest = await fetchLatestVersion();
  if (!latest || latest === currentVersion) return;
  if (!isNewer(latest, currentVersion)) return;

  // Check if global install is already at latest — if so, this is a local/dev build
  const globalVersion = getGlobalInstalledVersion();
  if (globalVersion && !isNewer(latest, globalVersion)) {
    logger.info(`\n  ohwow ${latest} is already installed globally.`);
    logger.info(`  You're running a local build (${currentVersion}). No update needed.\n`);
    return;
  }

  logger.info(`\n  A new version of ohwow is available (${currentVersion} → ${latest}). Installing...`);

  // Check if daemon is running and handle graceful shutdown
  let daemonWasRunning = false;
  let waitedForTasks = false;

  let port = DEFAULT_PORT;
  let dataDir = dirname(DEFAULT_DB_PATH);
  try {
    const config = loadConfig();
    port = config.port;
    dataDir = dirname(config.dbPath);
  } catch {
    // Use defaults
  }

  const daemonStatus = await isDaemonRunning(dataDir, port);
  if (daemonStatus.running) {
    daemonWasRunning = true;

    // Check for active tasks
    const queueStatus = await fetchQueueStatus(port);
    if (queueStatus && (queueStatus.active > 0 || queueStatus.waiting > 0)) {
      waitedForTasks = true;
      const drained = await waitForTasksDrain(port);
      if (!drained) {
        logger.info('  Tasks did not finish within 2 minutes. Stopping daemon anyway.');
      }
    }

    // Stop daemon gracefully
    logger.info('  Stopping daemon...');
    await stopDaemon(dataDir);
    await waitForDaemonStop(dataDir);
  }

  // Run the update
  try {
    execSync(`npm install -g ${PKG}@latest`, { stdio: 'inherit' });
  } catch {
    logger.error(
      `\n  Update did not complete. You can update manually: npm install -g ${PKG}@latest`,
    );
    return;
  }

  // Print report
  logger.info(`\n  ohwow updated to ${latest}.`);
  if (daemonWasRunning) {
    if (waitedForTasks) {
      logger.info('  Waited for running tasks to finish before stopping the daemon.');
    } else {
      logger.info('  Daemon was stopped for the update.');
    }
  }
  logger.info('\n  Run ohwow again to use the updated version.\n');

  process.exit(0);
}
