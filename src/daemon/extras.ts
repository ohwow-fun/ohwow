/**
 * Daemon optional integrations phase
 *
 * Cloudflare tunnel (phase 13) and OpenClaw MCP + A2A bridge
 * (phase 13b). Both are opt-in via config and both are best-effort —
 * failures log and move on rather than blocking boot.
 *
 * Populates ctx.tunnel so shutdown can stop the cloudflared child.
 */

import { logger } from '../lib/logger.js';
import type { DaemonContext } from './context.js';

export async function setupOptionalIntegrations(ctx: Partial<DaemonContext>): Promise<void> {
  const { config, db, bus, controlPlane, app } = ctx as DaemonContext;

  // 13. Cloudflare tunnel (if enabled)
  if (config.tunnelEnabled) {
    try {
      const { startTunnel } = await import('../tunnel/tunnel.js');
      const tunnel = await startTunnel(config.port);
      ctx.tunnel = tunnel;

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
}
