/**
 * Daemon Entry Point
 * Starts all services (DB, engine, HTTP server, WhatsApp, scheduler, etc.)
 * as a standalone daemon process. No TUI rendering.
 *
 * Usage:
 *   ohwow --daemon    # Foreground daemon (for systemd/launchd/Docker)
 *   Auto-started by TUI when no daemon is detected
 */

import { randomUUID } from 'crypto';
import { resolveActiveWorkspace } from '../config.js';
import { WhatsAppClient } from '../whatsapp/client.js';
import { DocumentWorker } from '../execution/workers/document-worker.js';
import { releaseLock } from '../lib/instance-lock.js';
import type { LocalScheduler } from '../scheduling/local-scheduler.js';
import type { ConnectorSyncScheduler } from '../scheduling/connector-sync-scheduler.js';
import type { ProactiveEngine } from '../planning/proactive-engine.js';
import { getPidPath } from './lifecycle.js';
import { migrateLegacyDataDirIfNeeded } from './migrate-legacy.js';
import { VERSION } from '../version.js';
import type { TunnelResult } from '../tunnel/tunnel.js';
import { logger } from '../lib/logger.js';
import { createEmptyContext, type DaemonContext } from './context.js';
import { initDaemon, createServices, createEngine } from './init.js';
import { setupInference } from './inference.js';
import { connectCloudAndConsolidate, startCloudPolling } from './cloud.js';
import { setupOrchestration } from './orchestration.js';
import { setupHttpServer } from './http.js';
import { initializeMessagingChannels } from './channels.js';
import { initializeScheduling } from './scheduling.js';

export interface DaemonHandle {
  shutdown: () => void;
  port: number;
  sessionToken: string;
}

/**
 * Start the daemon: initialize all services, start HTTP + WS server.
 * Writes PID and session token files for client discovery.
 */
export async function startDaemon(): Promise<DaemonHandle> {
  // 0. One-shot legacy data dir migration. Must run before loadConfig() so
  // the resolver returns the post-migration paths. Throws if a stray daemon
  // is still alive on the legacy PID file.
  migrateLegacyDataDirIfNeeded();

  const ctx = createEmptyContext() as DaemonContext;
  await initDaemon(ctx);

  const { config, dataDir, pidPath, rawDb, db, bus, sessionToken, startTime } = ctx;

  const isWorker = config.deviceRole === 'worker';
  // Coordinator role: orchestrator + scheduler + messaging, no local task execution.
  // Task execution filtering happens in the engine, not during daemon init.
  const _isCoordinator = config.deviceRole === 'coordinator';

  const inferenceState = await setupInference(ctx);
  const { modelRouter, mlxManager, llamaCppManager, ollamaMonitor, processMonitor, warmupAbort } = ctx;

  createServices(ctx);
  const { scraplingService, voiceboxService } = ctx;

  // 7. Connect to cloud + consolidate workspace identity
  await connectCloudAndConsolidate(ctx);
  const controlPlane = ctx.controlPlane;
  const workspaceId = ctx.workspaceId!;
  const activeWsName = resolveActiveWorkspace().name;

  // 7.5 Detect Claude Code CLI availability
  if (config.claudeCodeCliAutodetect) {
    try {
      const { detectClaudeCode } = await import('../execution/adapters/claude-code-detection.js');
      const ccStatus = await detectClaudeCode(config.claudeCodeCliPath || undefined);
      if (ccStatus.available) {
        logger.info({ version: ccStatus.version, path: ccStatus.binaryPath }, '[daemon] Claude Code CLI detected');
      }
    } catch (err) {
      logger.debug({ err }, '[daemon] Claude Code CLI detection failed (non-fatal)');
    }
  }

  createEngine(ctx);
  const engine = ctx.engine!;

  // 9. Start polling (connected tier only)
  startCloudPolling(ctx);

  // 10. Initialize channel registry + orchestrator + digital body
  await setupOrchestration(ctx, inferenceState);
  const { channelRegistry, connectorRegistry, triggerEvaluator, orchestrator, digitalBody, digitalNS, messageRouter, deviceFetcher } = ctx;

  // 11. Start Express server + WebSocket + register daemon status endpoints
  let scheduler: LocalScheduler | null = null;
  let connectorSyncScheduler: ConnectorSyncScheduler | null = null;
  let proactiveEngine: ProactiveEngine | null = null;
  await setupHttpServer(ctx, inferenceState);
  const { app, server } = ctx;

  // 12. Initialize messaging channels (WhatsApp + Telegram auto-connect)
  await initializeMessagingChannels(ctx);
  const { waClient, tgClient } = ctx;

  // 12a. Scheduling + self-bench (primary only)
  await initializeScheduling(ctx);
  scheduler = ctx.scheduler ?? null;
  proactiveEngine = ctx.proactiveEngine ?? null;
  connectorSyncScheduler = ctx.connectorSyncScheduler ?? null;

  // 12a2. Document processing worker (runs on all devices)
  const documentWorker = new DocumentWorker(db, bus, {
    ollamaUrl: config.ollamaUrl,
    embeddingModel: config.embeddingModel || undefined,
    ollamaModel: config.ollamaModel || undefined,
  });
  documentWorker.start();

  // 12b. Start peer discovery + monitoring (all devices including workers)
  let peerDiscovery: import('../peers/discovery.js').PeerDiscovery | null = null;
  let peerMonitor: import('../peers/peer-monitor.js').PeerMonitor | null = null;
  {
    try {
      const { PeerDiscovery } = await import('../peers/discovery.js');
      const { PeerMonitor } = await import('../peers/peer-monitor.js');
      const { getMachineId } = await import('../lib/machine-id.js');
      const { detectDevice, getMemoryTier } = await import('../lib/device-info.js');

      const device = detectDevice();
      const memoryTier = getMemoryTier(device);

      // Get workspace name for mDNS advertisement
      const { data: nameSetting } = await db.from('runtime_settings')
        .select('value').eq('key', 'workspace_name').maybeSingle();
      const wsName = (nameSetting as { value: string } | null)?.value || 'workspace';

      peerDiscovery = new PeerDiscovery({
        onPeerFound: (peer) => {
          logger.info(`[daemon] Discovered peer: ${peer.name} at ${peer.url}`);
          bus.emit('peer:discovered', peer);
        },
        onPeerLost: (peer) => {
          logger.info(`[daemon] Lost peer: ${peer.name}`);
          bus.emit('peer:lost', peer);
        },
      });

      // Advertise and browse after server is listening
      const machineId = getMachineId() || 'unknown';
      // Build messaging channels string for peer discovery
      const messagingChannels = channelRegistry.getConnectedTypes().join(',');

      // Collect owned connection IDs for mesh ownership tracking
      const ownedConnectionIds: string[] = [];
      const waConns = rawDb.prepare(
        'SELECT id FROM whatsapp_connections WHERE workspace_id = ?',
      ).all(workspaceId) as { id: string }[];
      for (const c of waConns) ownedConnectionIds.push(c.id);
      const tgConns = rawDb.prepare(
        'SELECT id FROM telegram_connections WHERE workspace_id = ?',
      ).all(workspaceId) as { id: string }[];
      for (const c of tgConns) ownedConnectionIds.push(c.id);

      peerDiscovery.advertise(config.port, {
        name: wsName,
        deviceId: machineId,
        memoryTier,
        version: VERSION,
        deviceRole: config.deviceRole,
        workspaceGroup: config.workspaceGroup,
        messagingChannels,
        ownedConnectionIds: ownedConnectionIds.join(','),
      });
      peerDiscovery.browse();

      // Auto-pair with discovered peers
      bus.on('peer:discovered', async (peer: import('../peers/discovery.js').DiscoveredPeer) => {
        try {
          // Check if already paired (by base_url or deviceId)
          const { data: existing } = await db.from('workspace_peers')
            .select('id, status')
            .eq('base_url', peer.url)
            .maybeSingle();

          if (existing) {
            const row = existing as Record<string, unknown>;
            if (row.status === 'connected') {
              logger.debug(`[daemon] Peer already paired: ${peer.name}`);
              return;
            }
          }

          // Auto-pair via POST to the peer's /api/peers/pair
          const { data: pairNameSetting } = await db.from('runtime_settings')
            .select('value').eq('key', 'workspace_name').maybeSingle();
          const ourName = (pairNameSetting as { value: string } | null)?.value || 'workspace';
          const ourToken = randomUUID();

          const deviceInfo = detectDevice();
          const pairRes = await fetch(`${peer.url}/api/peers/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: ourName,
              callbackUrl: `http://localhost:${config.port}`,
              token: ourToken,
              deviceCapabilities: {
                totalMemoryGb: deviceInfo.totalMemoryGB,
                cpuCores: deviceInfo.cpuCores,
                memoryTier: getMemoryTier(deviceInfo),
                isAppleSilicon: deviceInfo.isAppleSilicon,
                hasNvidiaGpu: deviceInfo.hasNvidiaGpu,
                gpuName: deviceInfo.gpuName,
                deviceRole: config.deviceRole,
              },
              machineId,
            }),
            signal: AbortSignal.timeout(10_000),
          });

          if (!pairRes.ok) {
            logger.warn(`[daemon] Auto-pair with ${peer.name} failed: ${pairRes.status}`);
            return;
          }

          const result = (await pairRes.json()) as {
            name: string;
            peerToken: string;
            deviceCapabilities?: Record<string, unknown>;
            machineId?: string;
          };

          // Build capability fields from response
          const capFields: Record<string, unknown> = {};
          if (result.deviceCapabilities) {
            const dc = result.deviceCapabilities;
            if (dc.totalMemoryGb != null) capFields.total_memory_gb = dc.totalMemoryGb;
            if (dc.cpuCores != null) capFields.cpu_cores = dc.cpuCores;
            if (dc.memoryTier) capFields.memory_tier = dc.memoryTier;
            if (dc.isAppleSilicon != null) capFields.is_apple_silicon = dc.isAppleSilicon ? 1 : 0;
            if (dc.hasNvidiaGpu != null) capFields.has_nvidia_gpu = dc.hasNvidiaGpu ? 1 : 0;
            if (dc.gpuName) capFields.gpu_name = dc.gpuName;
            if (dc.localModels) capFields.local_models = JSON.stringify(dc.localModels);
            if (dc.deviceRole) capFields.device_role = dc.deviceRole;
          }
          if (result.machineId) capFields.machine_id = result.machineId;

          const now = new Date().toISOString();

          if (existing) {
            await db.from('workspace_peers').update({
              name: result.name,
              peer_token: result.peerToken,
              our_token: ourToken,
              status: 'connected',
              last_seen_at: now,
              updated_at: now,
              ...capFields,
            }).eq('id', (existing as Record<string, unknown>).id as string);
          } else {
            await db.from('workspace_peers').insert({
              id: randomUUID(),
              name: result.name,
              base_url: peer.url,
              peer_token: result.peerToken,
              our_token: ourToken,
              status: 'connected',
              capabilities: JSON.stringify({ tasks: true, agents: true, orchestrator: true, activity: true }),
              last_seen_at: now,
              created_at: now,
              updated_at: now,
              ...capFields,
            });
          }

          logger.info(`[daemon] Auto-paired with ${result.name} at ${peer.url}`);
        } catch (err) {
          logger.warn(`[daemon] Auto-pair failed for ${peer.name}: ${err instanceof Error ? err.message : err}`);
        }
      });

      // Update peer status when lost
      bus.on('peer:lost', async (peer: import('../peers/discovery.js').DiscoveredPeer) => {
        try {
          await db.from('workspace_peers')
            .update({ status: 'error', updated_at: new Date().toISOString() })
            .eq('base_url', peer.url);
        } catch (err) {
          logger.debug(`[daemon] Peer status update failed: ${err instanceof Error ? err.message : err}`);
        }
      });

      // Activate MeshCoordinator for leader election + connection ownership
      const { MeshCoordinator } = await import('../peers/mesh-coordinator.js');
      const meshCoordinator = new MeshCoordinator(machineId);

      // Register our own connections
      meshCoordinator.registerOwnedConnections(machineId, ownedConnectionIds);

      // Start automatic health checks (with mesh coordinator for failover)
      peerMonitor = new PeerMonitor(db, bus, meshCoordinator);
      peerMonitor.start();

      // Wire failover: when a peer with connections goes offline, try to take over
      bus.on('peer:failover', async (event: { peerId: string; machineId: string; connectionIds: string[] }) => {
        const { fetchAndImportAuthState } = await import('../whatsapp/auth-state.js');
        const { acquireConnectionLock } = await import('../whatsapp/auth-state.js');
        const { createChannelMessageHandler } = await import('../integrations/relay-handler.js');
        const waMessageHandler = createChannelMessageHandler('whatsapp', messageRouter, db);

        for (const connId of event.connectionIds) {
          try {
            // Try to acquire the lock (it should be expired since the peer is dead)
            const lockAcquired = acquireConnectionLock(rawDb, connId, machineId);
            if (!lockAcquired) {
              logger.info({ connectionId: connId }, '[daemon] Failover: connection lock held by another device');
              continue;
            }

            // Try to fetch auth state from the dead peer (best effort)
            const { data: peerRow } = await db.from('workspace_peers').select('*').eq('id', event.peerId).single();
            if (peerRow) {
              const peer = peerRow as Record<string, unknown>;
              const imported = await fetchAndImportAuthState(
                rawDb, peer.base_url as string, peer.our_token as string, connId,
              );
              if (!imported) {
                logger.warn({ connectionId: connId }, '[daemon] Failover: could not import auth state from dead peer');
                continue;
              }
            }

            // Create a new WhatsApp client and connect
            const client = WhatsAppClient.forConnection(rawDb, workspaceId, bus, connId);
            channelRegistry.register(client);
            client.setMessageHandler(waMessageHandler);
            await client.connect();
            logger.info({ connectionId: connId }, '[daemon] Failover: successfully took over connection');
          } catch (err) {
            logger.warn({ connectionId: connId, err }, '[daemon] Failover: failed to take over connection');
          }
        }
      });

      // Wire TaskDistributor for automatic overflow to peers
      const { TaskDistributor } = await import('../peers/task-distributor.js');
      const taskDistributor = new TaskDistributor(db, bus);
      engine.setTaskDistributor(taskDistributor);
      logger.info('[daemon] TaskDistributor enabled for peer overflow');

      // Update mesh state when peers change
      const updateMeshState = async () => {
        const { data: peers } = await db.from('workspace_peers')
          .select('id, name, machine_id, status')
          .eq('status', 'connected');

        meshCoordinator.updatePeers(
          ((peers || []) as Record<string, unknown>[]).map(p => ({
            id: p.id as string,
            name: p.name as string,
            machineId: (p.machine_id as string) || '',
            status: p.status as string,
          }))
        );
        meshCoordinator.logState();

        // Guard singleton services: stop scheduler/proactive on non-primary
        if (!meshCoordinator.isPrimary) {
          if (scheduler?.isRunning) {
            scheduler.stop();
            logger.info('[daemon] Scheduler stopped (not primary)');
          }
          if (proactiveEngine?.isRunning) {
            proactiveEngine.stop();
            logger.info('[daemon] Proactive engine stopped (not primary)');
          }
        } else {
          // Re-start singletons if we became primary
          if (scheduler && !scheduler.isRunning) {
            scheduler.start().catch((err: unknown) => {
              logger.warn(`[daemon] Scheduler restart failed: ${err instanceof Error ? err.message : err}`);
            });
            logger.info('[daemon] Scheduler restarted (became primary)');
          }
          if (proactiveEngine && !proactiveEngine.isRunning) {
            proactiveEngine.start().catch((err: unknown) => {
              logger.warn(`[daemon] Proactive engine restart failed: ${err instanceof Error ? err.message : err}`);
            });
            logger.info('[daemon] Proactive engine restarted (became primary)');
          }
        }
      };

      bus.on('peer:discovered', () => setTimeout(updateMeshState, 2000));
      bus.on('peer:lost', () => setTimeout(updateMeshState, 1000));

      // Start cross-device message history sync
      const { MessageSync } = await import('../peers/message-sync.js');
      const messageSync = new MessageSync(db, rawDb);
      messageSync.start();

      // Add to shutdown cleanup
      bus.once('shutdown', () => messageSync.stop());
    } catch (err) {
      logger.warn(`[daemon] Peer discovery failed to start: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 13. Cloudflare tunnel (if enabled)
  let tunnel: TunnelResult | null = null;
  if (config.tunnelEnabled) {
    try {
      const { startTunnel } = await import('../tunnel/tunnel.js');
      tunnel = await startTunnel(config.port);

      const { data: existing } = await db.from('runtime_settings')
        .select('key').eq('key', 'tunnel_url').maybeSingle();
      if (existing) {
        await db.from('runtime_settings')
          .update({ value: tunnel.url, updated_at: new Date().toISOString() })
          .eq('key', 'tunnel_url');
      } else {
        await db.from('runtime_settings')
          .insert({ key: 'tunnel_url', value: tunnel.url });
      }

      logger.info(`[daemon] Tunnel: ${tunnel.url}`);
      bus.emit('tunnel:url', tunnel.url);

      if (controlPlane) {
        controlPlane.setTunnelUrl(tunnel.url);
        controlPlane.sendHeartbeatNow().catch(() => {});
      }

      // React to every subsequent URL rotation: update runtime_settings,
      // notify the bus, and push a fresh heartbeat to the control plane so
      // the cloud never keeps calling a dead cloudflared hostname. Without
      // this the runtime appears "disconnected" until the regular 15s
      // heartbeat cycle catches up.
      tunnel.onUrlChange(async (newUrl) => {
        logger.info(`[daemon] Tunnel URL rotated -> ${newUrl}`);
        try {
          await db.from('runtime_settings')
            .update({ value: newUrl, updated_at: new Date().toISOString() })
            .eq('key', 'tunnel_url');
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : err }, '[daemon] persist rotated tunnel URL failed');
        }
        bus.emit('tunnel:url', newUrl);
        if (controlPlane) {
          controlPlane.setTunnelUrl(newUrl);
          controlPlane.sendHeartbeatNow().catch((err) => {
            logger.warn({ err: err instanceof Error ? err.message : err }, '[daemon] immediate heartbeat after tunnel rotation failed');
          });
        }
      });
    } catch (err) {
      logger.warn(`[daemon] Tunnel failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 13b. OpenClaw integration (if enabled)
  if (config.openclaw?.enabled && config.openclaw.binaryPath) {
    try {
      const { buildMcpServerConfig } = await import('../integrations/openclaw/mcp-bridge.js');
      const { registerOpenClawA2ARoutes } = await import('../integrations/openclaw/a2a-bridge.js');

      const openclawMcpConfig = buildMcpServerConfig(config.openclaw);
      config.mcpServers = [...config.mcpServers, openclawMcpConfig];

      registerOpenClawA2ARoutes(app, config.openclaw, config.localUrl);
      logger.info('[daemon] OpenClaw integration enabled');
    } catch (err) {
      logger.warn({ err }, '[daemon] OpenClaw integration setup failed (non-fatal)');
    }
  }

  logger.info('[daemon] Ready');

  // 14. Shutdown handler (defined before route so it can be referenced)
  const shutdown = () => {
    logger.info('\n[daemon] Shutting down...');
    warmupAbort?.abort();
    engine.drainQueue('Daemon shutting down');
    orchestrator?.closeBrowser().catch(() => {});
    // Also tear down the HTTP route's singleton browser service. The cloud
    // routes browser sessions through /browser/session/* which uses its own
    // singleton (separate from the orchestrator's), so without this call any
    // Stagehand-spawned Chromium would survive daemon restart and accumulate
    // as orphaned windows the user has to manually close.
    import('../api/routes/browser-session.js')
      .then(m => m.closeBrowserSessionService())
      .catch(() => {});
    orchestrator?.closeDesktop().catch(() => {});
    orchestrator?.closeMcp().catch(() => {});
    llamaCppManager?.stop().catch(() => {});
    mlxManager?.stop().catch(() => {});
    ollamaMonitor?.stop();
    processMonitor.stop();
    tunnel?.stop();
    scheduler?.stop();
    proactiveEngine?.stop();
    connectorSyncScheduler?.stop();
    documentWorker.stop();
    scraplingService.stop().catch(() => {});
    voiceboxService.stop().catch(() => {});
    digitalNS.stop();
    tgClient?.disconnect();
    waClient?.disconnect();
    peerDiscovery?.stop();
    peerMonitor?.stop();
    deviceFetcher?.destroy();
    // Clean up data-locality timers
    import('../data-locality/approval.js').then(m => m.cancelAllPendingApprovals()).catch(() => {});
    import('../execution/conversation-memory-sync.js').then(m => m.cancelAllExtractionTimers()).catch(() => {});
    bus.emit('shutdown');
    controlPlane?.disconnect();
    server.close(() => {
      rawDb.close();
      releaseLock(getPidPath(dataDir));
      logger.info('[daemon] Stopped');
      process.exit(0);
    });

    setTimeout(() => {
      releaseLock(getPidPath(dataDir));
      process.exit(1);
    }, 5000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // HTTP shutdown endpoint for cross-platform graceful stop (Windows lacks SIGTERM)
  app.post('/shutdown', (_req, res) => {
    res.json({ status: 'shutting_down' });
    shutdown();
  });

  return { shutdown, port: config.port, sessionToken };
}
