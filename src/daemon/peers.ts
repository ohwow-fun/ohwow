/**
 * Daemon peer discovery + document worker phase
 *
 * DocumentWorker runs on every device (workers included) and pulls
 * pending document jobs from the bus for embedding + extraction.
 *
 * Peer discovery / PeerMonitor / mDNS auto-pairing / MeshCoordinator /
 * TaskDistributor / MessageSync all run here — they're the multidevice
 * mesh layer that lets two daemons on the same LAN find each other,
 * pair, and share work. Every subsystem is best-effort: a failure in
 * one import doesn't block the rest of the boot.
 *
 * Populates ctx.documentWorker, ctx.peerDiscovery, ctx.peerMonitor so
 * shutdown can tear them down in order.
 */

import { randomUUID } from 'crypto';
import { DocumentWorker } from '../execution/workers/document-worker.js';
import { WhatsAppClient } from '../whatsapp/client.js';
import { VERSION } from '../version.js';
import { logger } from '../lib/logger.js';
import type { DaemonContext } from './context.js';

export async function initializePeersAndDocuments(ctx: Partial<DaemonContext>): Promise<void> {
  const { config, db, rawDb, bus, engine, workspaceId, channelRegistry, messageRouter } = ctx as DaemonContext;

  // 12a2. Document processing worker (runs on all devices)
  const documentWorker = new DocumentWorker(db, bus, {
    ollamaUrl: config.ollamaUrl,
    embeddingModel: config.embeddingModel || undefined,
    ollamaModel: config.ollamaModel || undefined,
  });
  documentWorker.start();
  ctx.documentWorker = documentWorker;

  // 12b. Start peer discovery + monitoring (all devices including workers)
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

    const peerDiscovery = new PeerDiscovery({
      onPeerFound: (peer) => {
        logger.info(`[daemon] Discovered peer: ${peer.name} at ${peer.url}`);
        bus.emit('peer:discovered', peer);
      },
      onPeerLost: (peer) => {
        logger.info(`[daemon] Lost peer: ${peer.name}`);
        bus.emit('peer:lost', peer);
      },
    });
    ctx.peerDiscovery = peerDiscovery;

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
    const peerMonitor = new PeerMonitor(db, bus, meshCoordinator);
    peerMonitor.start();
    ctx.peerMonitor = peerMonitor;

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
        if (ctx.scheduler?.isRunning) {
          ctx.scheduler.stop();
          logger.info('[daemon] Scheduler stopped (not primary)');
        }
        if (ctx.proactiveEngine?.isRunning) {
          ctx.proactiveEngine.stop();
          logger.info('[daemon] Proactive engine stopped (not primary)');
        }
      } else {
        // Re-start singletons if we became primary
        if (ctx.scheduler && !ctx.scheduler.isRunning) {
          ctx.scheduler.start().catch((err: unknown) => {
            logger.warn(`[daemon] Scheduler restart failed: ${err instanceof Error ? err.message : err}`);
          });
          logger.info('[daemon] Scheduler restarted (became primary)');
        }
        if (ctx.proactiveEngine && !ctx.proactiveEngine.isRunning) {
          ctx.proactiveEngine.start().catch((err: unknown) => {
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
