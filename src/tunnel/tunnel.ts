/**
 * Cloudflare Tunnel Manager
 *
 * Thin wrapper around cloudflared Quick Tunnels to expose a public webhook URL.
 * Quick Tunnel URLs are ephemeral and can rotate whenever cloudflared reconnects
 * to Cloudflare's edge (network blip, process restart, etc). This module listens
 * for every `url` event from cloudflared — not just the first — and fans the
 * new URL out to subscribers so the daemon can republish it to the control
 * plane immediately. Without this the cloud would keep calling a dead hostname
 * and the runtime would appear "disconnected" until the next heartbeat.
 */

import { logger } from '../lib/logger.js';

export interface TunnelResult {
  /** Current public URL. Mutated in place whenever cloudflared emits a new `url`. */
  url: string;
  /** Subscribe to URL changes. Fires when the current URL differs from the last-seen one. */
  onUrlChange: (cb: (newUrl: string, prevUrl: string) => void) => () => void;
  /** Stop the underlying cloudflared process and release subscribers. */
  stop: () => void;
}

/**
 * Start a Cloudflare Quick Tunnel pointing to the given local port.
 * Returns the public URL, a subscription API for URL changes, and a stop function.
 *
 * Requires `cloudflared` package to be installed. Fails gracefully
 * with a descriptive error if the package is missing.
 */
export async function startTunnel(port: number): Promise<TunnelResult> {
  // Dynamic import so the package doesn't fail at require-time if cloudflared isn't installed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Tunnel } = await import('cloudflared') as any;

  const localUrl = `http://localhost:${port}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let t: any = Tunnel.quick(localUrl);

  // Wait for the first URL (initial setup fails if cloudflared can't get one).
  const firstUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Tunnel URL not received within 15 seconds'));
    }, 15_000);

    t.once('url', (url: string) => {
      clearTimeout(timeout);
      resolve(url);
    });

    t.once('error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  const result: TunnelResult = {
    url: firstUrl,
    onUrlChange: (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    stop: () => {
      stopped = true;
      subscribers.clear();
      detach();
      try {
        t?.stop?.();
      } catch {
        // already stopped
      }
    },
  };

  const subscribers = new Set<(newUrl: string, prevUrl: string) => void>();
  let stopped = false;

  const notifyUrlChange = (newUrl: string) => {
    if (!newUrl || newUrl === result.url) return;
    const prevUrl = result.url;
    result.url = newUrl;
    logger.info(`[tunnel] URL changed: ${prevUrl} -> ${newUrl}`);
    for (const cb of subscribers) {
      try {
        cb(newUrl, prevUrl);
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : err }, '[tunnel] onUrlChange subscriber threw');
      }
    }
  };

  /**
   * Attach long-lived listeners to the current cloudflared handle. We use
   * `on` (not `once`) so any subsequent URL emission after a cloudflared
   * reconnect is propagated. On 'exit' we try to spin up a fresh tunnel so
   * the runtime stays reachable without requiring a daemon restart.
   */
  const urlListener = (url: string) => notifyUrlChange(url);
  const errorListener = (err: Error) => {
    logger.warn({ err: err?.message || String(err) }, '[tunnel] cloudflared error');
  };
  const exitListener = async () => {
    if (stopped) return;
    logger.warn('[tunnel] cloudflared exited unexpectedly — restarting');
    detach();
    // Back off briefly to avoid tight restart loops when cloudflared is
    // persistently broken (auth, network outage, package missing, etc).
    await new Promise(r => setTimeout(r, 2000));
    if (stopped) return;
    try {
      t = Tunnel.quick(localUrl);
      attach();
      // Wait for the new URL (up to 15s) then publish.
      const newUrl = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('tunnel restart: url not received within 15s')), 15_000);
        t.once('url', (url: string) => { clearTimeout(timeout); resolve(url); });
        t.once('error', (err: Error) => { clearTimeout(timeout); reject(err); });
      });
      notifyUrlChange(newUrl);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, '[tunnel] restart failed');
    }
  };

  const attach = () => {
    t.on('url', urlListener);
    t.on('error', errorListener);
    t.once('exit', exitListener);
  };

  const detach = () => {
    try {
      t.off?.('url', urlListener);
      t.off?.('error', errorListener);
      t.off?.('exit', exitListener);
    } catch {
      // handle may already be invalid
    }
  };

  attach();
  return result;
}
