/**
 * Machine ID
 * Returns the MAC address of the primary physical NIC as a stable machine identifier.
 * Prefers en0 (macOS), eth0/ens3 (Linux). Skips loopback and virtual interfaces.
 * Returns undefined if no suitable interface is found (e.g., inside a container).
 */

import { readFileSync } from 'fs';
import { hostname, networkInterfaces } from 'os';

export function getMachineId(): string | undefined {
  const ifaces = networkInterfaces();
  const preferred = ['en0', 'eth0', 'en1', 'ens3', 'ens0', 'enp0s3', 'eno1', 'wlan0', 'wlp2s0'];
  const candidates = [...preferred, ...Object.keys(ifaces)];
  for (const name of candidates) {
    const list = ifaces[name];
    if (!list) continue;
    const entry = list.find(i => !i.internal && i.mac && i.mac !== '00:00:00:00:00:00');
    if (entry) return entry.mac;
  }

  // Fallback: /etc/machine-id (present on systemd Linux and most containers)
  try {
    const id = readFileSync('/etc/machine-id', 'utf-8').trim();
    if (id) return id;
  } catch {
    // Not available (macOS, minimal containers)
  }

  // Last resort: hostname (least stable but better than undefined)
  const host = hostname();
  if (host) return host;

  return undefined;
}
