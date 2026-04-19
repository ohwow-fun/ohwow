/**
 * Daemon shutdown orchestration
 *
 * createShutdownHandler(ctx) returns the single shutdown closure wired
 * to SIGINT, SIGTERM, and POST /shutdown. The teardown sequence is
 * load-bearing: drain queue → browsers → MCP → inference → schedulers
 * → channels → peers → bus emit → control plane → server.close →
 * rawDb.close → releaseLock → exit. Reordering can leak Chromium
 * processes or truncate in-flight DB writes. A 5s fallback timeout
 * force-exits if server.close hangs.
 */

import { releaseLock } from '../lib/instance-lock.js';
import { getPidPath } from './lifecycle.js';
import { logger } from '../lib/logger.js';
import type { DaemonContext } from './context.js';

export function createShutdownHandler(ctx: DaemonContext): () => void {
  return () => {
    logger.info('\n[daemon] Shutting down...');
    ctx.warmupAbort?.abort();
    ctx.engine.drainQueue('Daemon shutting down');
    ctx.orchestrator?.closeBrowser().catch(() => {});
    // Also tear down the HTTP route's singleton browser service. The cloud
    // routes browser sessions through /browser/session/* which uses its own
    // singleton (separate from the orchestrator's), so without this call any
    // Stagehand-spawned Chromium would survive daemon restart and accumulate
    // as orphaned windows the user has to manually close.
    import('../api/routes/browser-session.js')
      .then(m => m.closeBrowserSessionService())
      .catch(() => {});
    ctx.orchestrator?.closeDesktop().catch(() => {});
    ctx.orchestrator?.closeMcp().catch(() => {});
    ctx.llamaCppManager?.stop().catch(() => {});
    ctx.mlxManager?.stop().catch(() => {});
    ctx.ollamaMonitor?.stop();
    ctx.processMonitor.stop();
    ctx.tunnel?.stop();
    ctx.scheduler?.stop();
    ctx.proactiveEngine?.stop();
    ctx.connectorSyncScheduler?.stop();
    ctx.documentWorker?.stop();
    ctx.scraplingService.stop().catch(() => {});
    ctx.voiceboxService.stop().catch(() => {});
    ctx.digitalNS.stop();
    ctx.tgClient?.disconnect();
    ctx.waClient?.disconnect();
    ctx.peerDiscovery?.stop();
    ctx.peerMonitor?.stop();
    ctx.deviceFetcher?.destroy();
    // Clean up data-locality timers
    import('../data-locality/approval.js').then(m => m.cancelAllPendingApprovals()).catch(() => {});
    import('../execution/conversation-memory-sync.js').then(m => m.cancelAllExtractionTimers()).catch(() => {});
    ctx.bus.emit('shutdown');
    ctx.controlPlane?.disconnect();
    // Unload secondary workspace contexts (closes their SQLite handles and
    // stops their schedulers). The primary workspace's rawDb is closed below
    // by rawDb.close() in the server.close callback, so we unload all
    // workspaces except the primary to avoid a double-close.
    if (ctx.registry) {
      const primaryName = ctx.workspaceName;
      const secondaries = ctx.registry.getAll().filter(w => w.workspaceName !== primaryName);
      for (const ws of secondaries) {
        void ctx.registry.unload(ws.workspaceName).catch(() => {});
      }
    }
    ctx.server.close(() => {
      ctx.rawDb.close();
      releaseLock(getPidPath(ctx.dataDir));
      logger.info('[daemon] Stopped');
      process.exit(0);
    });

    setTimeout(() => {
      releaseLock(getPidPath(ctx.dataDir));
      process.exit(1);
    }, 5000);
  };
}
