/**
 * Peer Routes
 *
 * Workspace-to-workspace peering API.
 * Most routes require session auth. The pairing endpoint is semi-public
 * (no auth required for the initial handshake).
 */

import { Router } from 'express';
import crypto from 'crypto';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import {
  healthCheck,
  listPeerAgents,
  parsePeerRow,
} from '../../peers/peer-client.js';
import { detectDevice, getMemoryTier } from '../../lib/device-info.js';
import { getMachineId } from '../../lib/machine-id.js';
import { isPrivateOrLocalIP } from '../../lib/url-validation.js';

/**
 * Public peer routes (no auth required).
 * Must be mounted BEFORE the auth middleware.
 */
export function createPeerPublicRouter(db: DatabaseAdapter): Router {
  const router = Router();

  // Receive a pairing request from another workspace
  router.post('/api/peers/pair', async (req, res) => {
    // Only allow pairing from local/private network IPs
    const clientIp = req.ip || req.socket.remoteAddress;
    if (!isPrivateOrLocalIP(clientIp)) {
      res.status(403).json({ error: 'Pairing is only allowed from local network' });
      return;
    }

    try {
      const { name, callbackUrl, token, deviceCapabilities, machineId: peerMachineId } = req.body as {
        name?: string;
        callbackUrl?: string;
        token?: string;
        deviceCapabilities?: {
          totalMemoryGb?: number;
          cpuCores?: number;
          memoryTier?: string;
          isAppleSilicon?: boolean;
          hasNvidiaGpu?: boolean;
          gpuName?: string;
          localModels?: string[];
          deviceRole?: string;
        };
        machineId?: string;
      };

      if (!name || !callbackUrl || !token) {
        res.status(400).json({ error: 'name, callbackUrl, and token are required' });
        return;
      }

      // Normalize the callback URL (strip trailing slash)
      const baseUrl = callbackUrl.replace(/\/+$/, '');

      // Check for existing peer with same base_url
      const { data: existing } = await db.from('workspace_peers')
        .select('*')
        .eq('base_url', baseUrl)
        .maybeSingle();

      const ourToken = crypto.randomUUID();
      const now = new Date().toISOString();

      // Collect our own device capabilities for the response
      const device = detectDevice();
      const ourCapabilities = {
        totalMemoryGb: device.totalMemoryGB,
        cpuCores: device.cpuCores,
        memoryTier: getMemoryTier(device),
        isAppleSilicon: device.isAppleSilicon,
        hasNvidiaGpu: device.hasNvidiaGpu,
        gpuName: device.gpuName,
        localModels: [] as string[],
        deviceRole: 'hybrid',
      };

      // Build capability fields for DB storage
      const capabilityFields: Record<string, unknown> = {};
      if (deviceCapabilities) {
        if (deviceCapabilities.totalMemoryGb != null) capabilityFields.total_memory_gb = deviceCapabilities.totalMemoryGb;
        if (deviceCapabilities.cpuCores != null) capabilityFields.cpu_cores = deviceCapabilities.cpuCores;
        if (deviceCapabilities.memoryTier) capabilityFields.memory_tier = deviceCapabilities.memoryTier;
        if (deviceCapabilities.isAppleSilicon != null) capabilityFields.is_apple_silicon = deviceCapabilities.isAppleSilicon ? 1 : 0;
        if (deviceCapabilities.hasNvidiaGpu != null) capabilityFields.has_nvidia_gpu = deviceCapabilities.hasNvidiaGpu ? 1 : 0;
        if (deviceCapabilities.gpuName) capabilityFields.gpu_name = deviceCapabilities.gpuName;
        if (deviceCapabilities.localModels) capabilityFields.local_models = JSON.stringify(deviceCapabilities.localModels);
        if (deviceCapabilities.deviceRole) capabilityFields.device_role = deviceCapabilities.deviceRole;
      }
      if (peerMachineId) capabilityFields.machine_id = peerMachineId;

      if (existing) {
        const peer = existing as Record<string, unknown>;
        // Update existing peer
        await db.from('workspace_peers').update({
          name,
          peer_token: token,
          our_token: ourToken,
          status: 'connected',
          last_seen_at: now,
          updated_at: now,
          ...capabilityFields,
        }).eq('id', peer.id as string);

        // Get runtime name from settings
        const { data: nameSetting } = await db.from('runtime_settings')
          .select('value')
          .eq('key', 'workspace_name')
          .maybeSingle();
        const ourName = (nameSetting as { value: string } | null)?.value || 'Workspace';

        res.json({
          name: ourName,
          peerToken: ourToken,
          capabilities: { tasks: true, agents: true, orchestrator: true, activity: true },
          deviceCapabilities: ourCapabilities,
          machineId: getMachineId(),
        });
        return;
      }

      // Create new peer
      const id = crypto.randomUUID();
      await db.from('workspace_peers').insert({
        id,
        name,
        base_url: baseUrl,
        peer_token: token,
        our_token: ourToken,
        status: 'connected',
        capabilities: JSON.stringify({ tasks: true, agents: true, orchestrator: true, activity: true }),
        last_seen_at: now,
        created_at: now,
        updated_at: now,
        ...capabilityFields,
      });

      // Get our workspace name
      const { data: nameSetting } = await db.from('runtime_settings')
        .select('value')
        .eq('key', 'workspace_name')
        .maybeSingle();
      const ourName = (nameSetting as { value: string } | null)?.value || 'Workspace';

      res.json({
        name: ourName,
        peerToken: ourToken,
        capabilities: { tasks: true, agents: true, orchestrator: true, activity: true },
        deviceCapabilities: ourCapabilities,
        machineId: getMachineId(),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}

/**
 * Authenticated peer routes (session token required).
 * Mounted after the auth middleware.
 */
export function createPeersRouter(
  db: DatabaseAdapter,
  deps?: {
    messageRouter?: import('../../integrations/message-router.js').MessageRouter;
    rawDb?: import('better-sqlite3').Database;
  },
): Router {
  const router = Router();

  // List all peers
  router.get('/api/peers', async (_req, res) => {
    try {
      const { data, error } = await db.from('workspace_peers')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      const peers = ((data || []) as Array<Record<string, unknown>>).map(parsePeerRow);
      res.json({ data: peers });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Initiate pairing with a target workspace
  router.post('/api/peers', async (req, res) => {
    try {
      const { url: targetUrl, name: customName } = req.body as { url?: string; name?: string };

      if (!targetUrl) {
        res.status(400).json({ error: 'url is required' });
        return;
      }

      const baseUrl = targetUrl.replace(/\/+$/, '');

      // Check for existing peer with same base_url
      const { data: existing } = await db.from('workspace_peers')
        .select('*')
        .eq('base_url', baseUrl)
        .maybeSingle();

      // Generate our token for the peer to use when calling us
      const ourToken = crypto.randomUUID();
      const now = new Date().toISOString();

      // Get our workspace name
      const { data: nameSetting } = await db.from('runtime_settings')
        .select('value')
        .eq('key', 'workspace_name')
        .maybeSingle();
      const ourName = (nameSetting as { value: string } | null)?.value || 'Workspace';

      // Get our own address for the callback
      const { data: portSetting } = await db.from('runtime_settings')
        .select('value')
        .eq('key', 'port')
        .maybeSingle();
      const port = (portSetting as { value: string } | null)?.value || '7700';
      const callbackUrl = `http://localhost:${port}`;

      // Detect our device capabilities to send to the peer
      const device = detectDevice();
      const ourCapabilities = {
        totalMemoryGb: device.totalMemoryGB,
        cpuCores: device.cpuCores,
        memoryTier: getMemoryTier(device),
        isAppleSilicon: device.isAppleSilicon,
        hasNvidiaGpu: device.hasNvidiaGpu,
        gpuName: device.gpuName,
        localModels: [] as string[],
        deviceRole: 'hybrid',
      };

      // Send pairing request to the target
      let pairResponse: Response;
      try {
        pairResponse = await fetch(`${baseUrl}/api/peers/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: ourName,
            callbackUrl,
            token: ourToken,
            deviceCapabilities: ourCapabilities,
            machineId: getMachineId(),
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        res.status(503).json({ error: "Couldn't reach the peer. Check the URL." });
        return;
      }

      if (pairResponse.status === 403) {
        res.status(403).json({ error: 'Connection declined by the peer.' });
        return;
      }

      if (!pairResponse.ok) {
        const text = await pairResponse.text().catch(() => '');
        res.status(502).json({ error: `Peer returned ${pairResponse.status}: ${text}` });
        return;
      }

      const result = (await pairResponse.json()) as {
        name: string;
        peerToken: string;
        capabilities: Record<string, unknown>;
        deviceCapabilities?: {
          totalMemoryGb?: number;
          cpuCores?: number;
          memoryTier?: string;
          isAppleSilicon?: boolean;
          hasNvidiaGpu?: boolean;
          gpuName?: string;
          localModels?: string[];
          deviceRole?: string;
        };
        machineId?: string;
      };

      // Build peer capability fields for DB storage
      const peerCapFields: Record<string, unknown> = {};
      if (result.deviceCapabilities) {
        const dc = result.deviceCapabilities;
        if (dc.totalMemoryGb != null) peerCapFields.total_memory_gb = dc.totalMemoryGb;
        if (dc.cpuCores != null) peerCapFields.cpu_cores = dc.cpuCores;
        if (dc.memoryTier) peerCapFields.memory_tier = dc.memoryTier;
        if (dc.isAppleSilicon != null) peerCapFields.is_apple_silicon = dc.isAppleSilicon ? 1 : 0;
        if (dc.hasNvidiaGpu != null) peerCapFields.has_nvidia_gpu = dc.hasNvidiaGpu ? 1 : 0;
        if (dc.gpuName) peerCapFields.gpu_name = dc.gpuName;
        if (dc.localModels) peerCapFields.local_models = JSON.stringify(dc.localModels);
        if (dc.deviceRole) peerCapFields.device_role = dc.deviceRole;
      }
      if (result.machineId) peerCapFields.machine_id = result.machineId;

      if (existing) {
        const peer = existing as Record<string, unknown>;
        // Update existing peer
        await db.from('workspace_peers').update({
          name: customName || result.name,
          peer_token: result.peerToken,
          our_token: ourToken,
          status: 'connected',
          capabilities: JSON.stringify(result.capabilities || {}),
          last_seen_at: now,
          updated_at: now,
          ...peerCapFields,
        }).eq('id', peer.id as string);

        const updated = parsePeerRow({
          ...peer,
          name: customName || result.name,
          peer_token: result.peerToken,
          our_token: ourToken,
          status: 'connected',
          capabilities: JSON.stringify(result.capabilities || {}),
          last_seen_at: now,
          updated_at: now,
        });

        res.json({ peer: updated });
        return;
      }

      // Create new peer record
      const id = crypto.randomUUID();
      await db.from('workspace_peers').insert({
        id,
        name: customName || result.name,
        base_url: baseUrl,
        peer_token: result.peerToken,
        our_token: ourToken,
        status: 'connected',
        capabilities: JSON.stringify(result.capabilities || {}),
        last_seen_at: now,
        created_at: now,
        updated_at: now,
        ...peerCapFields,
      });

      const { data: created } = await db.from('workspace_peers')
        .select('*')
        .eq('id', id)
        .single();

      res.status(201).json({ peer: parsePeerRow(created as Record<string, unknown>) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Delete a peer
  router.delete('/api/peers/:id', async (req, res) => {
    try {
      const { error } = await db.from('workspace_peers')
        .delete()
        .eq('id', req.params.id);

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.json({ data: { id: req.params.id } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Health check a peer
  router.post('/api/peers/:id/test', async (req, res) => {
    try {
      const { data: row } = await db.from('workspace_peers')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();

      if (!row) {
        res.status(404).json({ error: 'Peer not found' });
        return;
      }

      const peer = parsePeerRow(row as Record<string, unknown>);
      const result = await healthCheck(peer, db);

      res.json({ data: result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Delegate a task to a peer's agent
  router.post('/api/peers/:id/delegate', async (req, res) => {
    try {
      const { agent_id, input, project_id } = req.body as {
        agent_id?: string;
        input?: string;
        project_id?: string;
      };

      if (!agent_id || !input) {
        res.status(400).json({ error: 'agent_id and input are required' });
        return;
      }

      const { data: row } = await db.from('workspace_peers')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();

      if (!row) {
        res.status(404).json({ error: 'Peer not found' });
        return;
      }

      const peer = parsePeerRow(row as Record<string, unknown>);

      if (peer.status !== 'connected') {
        res.status(400).json({ error: 'Peer is not connected' });
        return;
      }

      // Import dynamically to avoid circular deps
      const { delegateTask } = await import('../../peers/peer-client.js');
      const result = await delegateTask(peer, agent_id, input, project_id);

      res.json({ data: result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Rotate tokens for a peer
  router.post('/api/peers/:id/rotate-token', async (req, res) => {
    try {
      const { data: row } = await db.from('workspace_peers')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();

      if (!row) {
        res.status(404).json({ error: 'Peer not found' });
        return;
      }

      const peer = parsePeerRow(row as Record<string, unknown>);

      if (peer.status !== 'connected') {
        res.status(400).json({ error: 'Peer must be connected to rotate tokens' });
        return;
      }

      // Generate new tokens and re-pair with the peer
      const newOurToken = crypto.randomUUID();
      const now = new Date().toISOString();

      // Get our workspace name
      const { data: nameSetting } = await db.from('runtime_settings')
        .select('value')
        .eq('key', 'workspace_name')
        .maybeSingle();
      const ourName = (nameSetting as { value: string } | null)?.value || 'Workspace';

      // Get our callback URL
      const { data: portSetting } = await db.from('runtime_settings')
        .select('value')
        .eq('key', 'port')
        .maybeSingle();
      const port = (portSetting as { value: string } | null)?.value || '7700';
      const callbackUrl = `http://localhost:${port}`;

      // Re-pair with the peer
      let pairResponse: Response;
      try {
        pairResponse = await fetch(`${peer.base_url}/api/peers/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: ourName,
            callbackUrl,
            token: newOurToken,
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        res.status(503).json({ error: "Couldn't reach the peer for token rotation." });
        return;
      }

      if (!pairResponse.ok) {
        res.status(502).json({ error: `Peer returned ${pairResponse.status} during rotation` });
        return;
      }

      const result = (await pairResponse.json()) as {
        name: string;
        peerToken: string;
        capabilities: Record<string, unknown>;
      };

      // Update local record with new tokens
      await db.from('workspace_peers').update({
        peer_token: result.peerToken,
        our_token: newOurToken,
        updated_at: now,
      }).eq('id', peer.id);

      res.json({ data: { rotated: true } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // List agents on a peer
  router.get('/api/peers/:id/agents', async (req, res) => {
    try {
      const { data: row } = await db.from('workspace_peers')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();

      if (!row) {
        res.status(404).json({ error: 'Peer not found' });
        return;
      }

      const peer = parsePeerRow(row as Record<string, unknown>);
      const agents = await listPeerAgents(peer);

      res.json({ agents });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Relay a message from a peer device's messaging channel to our orchestrator
  router.post('/api/peers/relay-message', async (req, res) => {
    if (!deps?.messageRouter) {
      res.status(503).json({ error: 'Orchestrator not available on this device' });
      return;
    }

    const { channel, chatId, connectionId, sender, text } = req.body as {
      channel?: string;
      chatId?: string;
      connectionId?: string;
      sender?: string;
      text?: string;
    };

    if (!channel || !chatId || !sender || !text) {
      res.status(400).json({ error: 'Missing required fields: channel, chatId, sender, text' });
      return;
    }

    try {
      deps.messageRouter.handleIncomingMessage(
        {
          channel: channel as import('../../integrations/channel-types.js').ChannelType,
          chatId,
          connectionId,
        },
        sender,
        text,
      );

      // The message is queued for async processing
      res.json({ relayed: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Fetch messages since a given timestamp (for cross-device sync)
  router.get('/api/peers/messages', async (req, res) => {
    const since = req.query.since as string;
    if (!since || !deps?.rawDb) {
      res.status(400).json({ error: 'since parameter and rawDb are required' });
      return;
    }

    try {
      const wa = deps.rawDb.prepare(
        'SELECT * FROM whatsapp_chat_messages WHERE created_at > ? ORDER BY created_at ASC LIMIT 200',
      ).all(since);
      const tg = deps.rawDb.prepare(
        'SELECT * FROM telegram_chat_messages WHERE created_at > ? ORDER BY created_at ASC LIMIT 200',
      ).all(since);
      res.json({ whatsapp: wa, telegram: tg });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Export WhatsApp auth state for failover transfer (peer-token gated)
  router.get('/api/peers/auth-state/:connectionId', async (req, res) => {
    if (!deps?.rawDb) {
      res.status(503).json({ error: 'Auth state transfer not available' });
      return;
    }

    const { connectionId } = req.params;
    try {
      const { exportAuthState } = await import('../../whatsapp/auth-state.js');
      const authState = exportAuthState(deps.rawDb, connectionId);
      if (!authState) {
        res.status(404).json({ error: 'No auth state found for this connection' });
        return;
      }
      res.json({ connectionId, authState });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Import WhatsApp auth state for failover (peer-token gated)
  router.post('/api/peers/auth-state/:connectionId', async (req, res) => {
    if (!deps?.rawDb) {
      res.status(503).json({ error: 'Auth state transfer not available' });
      return;
    }

    const { connectionId } = req.params;
    const { authState } = req.body as { authState?: string };

    if (!authState) {
      res.status(400).json({ error: 'authState is required' });
      return;
    }

    try {
      const { importAuthState } = await import('../../whatsapp/auth-state.js');
      importAuthState(deps.rawDb, connectionId, authState);
      res.json({ imported: true, connectionId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
