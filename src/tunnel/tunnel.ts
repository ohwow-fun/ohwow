/**
 * Cloudflare Tunnel Manager
 *
 * Thin wrapper around cloudflared Quick Tunnels to expose a public webhook URL.
 * Quick Tunnel URLs are ephemeral (change on restart).
 */

export interface TunnelResult {
  url: string;
  stop: () => void;
}

/**
 * Start a Cloudflare Quick Tunnel pointing to the given local port.
 * Returns the public URL and a stop function.
 *
 * Requires `cloudflared` package to be installed. Fails gracefully
 * with a descriptive error if the package is missing.
 */
export async function startTunnel(port: number): Promise<TunnelResult> {
  // Dynamic import so the package doesn't fail at require-time if cloudflared isn't installed
  const { Tunnel } = await import('cloudflared');

  const t = Tunnel.quick(`http://localhost:${port}`);

  // Wait for the URL to be assigned (emitted via 'url' event)
  const tunnelUrl = await new Promise<string>((resolve, reject) => {
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

  return {
    url: tunnelUrl,
    stop: () => {
      try {
        t.stop();
      } catch {
        // already stopped
      }
    },
  };
}
