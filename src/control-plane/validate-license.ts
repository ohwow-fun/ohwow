/**
 * Lightweight license key validation.
 * Calls POST /api/local-runtime/connect to validate a license key and return
 * business context + agents, without starting polling/heartbeats.
 * Used during onboarding before the full runtime starts.
 */

import { hostname, networkInterfaces } from 'os';
import type { ConnectResponse, AgentConfigPayload } from './types.js';
import { VERSION } from '../version.js';
import { logger } from '../lib/logger.js';

export interface LicenseValidationResult {
  workspaceId: string;
  businessContext: {
    businessName: string;
    businessType: string;
    businessDescription?: string;
  };
  agents: AgentConfigPayload[];
  sessionToken: string;
}

/**
 * Return the MAC address of the primary physical NIC as a stable machine identifier.
 * Prefers en0 (macOS), eth0/ens3 (Linux). Skips loopback and virtual interfaces.
 * Returns undefined if no suitable interface is found (e.g., inside a container).
 */
function getMachineId(): string | undefined {
  const ifaces = networkInterfaces();
  const preferred = ['en0', 'eth0', 'en1', 'ens3', 'ens0'];
  const candidates = [...preferred, ...Object.keys(ifaces)];
  for (const name of candidates) {
    const list = ifaces[name];
    if (!list) continue;
    const entry = list.find(i => !i.internal && i.mac && i.mac !== '00:00:00:00:00:00');
    if (entry) return entry.mac;
  }
  return undefined;
}

/**
 * Normalize a hostname for same-machine comparison.
 * Strips the mDNS .local suffix and the macOS Bonjour auto-increment suffix (-N)
 * so that "Jesuss-MacBook-Air-2.local" and "Jesuss-MacBook-Air-3.local" are equal.
 */
function normalizeHostname(h: string): string {
  return h
    .replace(/\.local$/, '')   // strip Bonjour mDNS domain
    .replace(/-\d+$/, '');     // strip trailing auto-increment counter
}

/**
 * Validate a license key against the cloud and return business data + agents.
 * Throws on invalid key or network error.
 */
export async function validateLicenseKey(
  licenseKey: string,
  cloudUrl: string,
): Promise<LicenseValidationResult> {
  const response = await fetch(`${cloudUrl}/api/local-runtime/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      licenseKey,
      runtimeVersion: VERSION,
      hostname: hostname(),
      osPlatform: process.platform,
      nodeVersion: process.version,
      localUrl: '',
      machineId: getMachineId(),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    if (response.status === 409) {
      const conflict = await response.json().catch(() => null) as {
        currentDevice?: { hostname?: string | null };
        warning?: string;
      } | null;
      const otherHost = conflict?.currentDevice?.hostname;

      // Same hostname → old session from this machine didn't clean up (crash, network switch).
      // Auto-force reconnect instead of blocking the user.
      if (otherHost && normalizeHostname(otherHost) === normalizeHostname(hostname())) {
        const retryResponse = await fetch(`${cloudUrl}/api/local-runtime/connect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            licenseKey,
            runtimeVersion: VERSION,
            hostname: hostname(),
            osPlatform: process.platform,
            nodeVersion: process.version,
            localUrl: '',
            machineId: getMachineId(),
            force: true,
            acknowledgeMemoryLoss: true,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (retryResponse.ok) {
          const retryData = await retryResponse.json() as ConnectResponse;
          return {
            workspaceId: retryData.workspaceId,
            businessContext: retryData.businessContext,
            agents: retryData.agents,
            sessionToken: retryData.sessionToken,
          };
        }
        // If force retry also fails, fall through to generic error
      }

      const hint = otherHost
        ? `Your license is active on "${otherHost}". Stop it there first, then try again.`
        : 'Your license is active on another device. Stop it there first, then try again.';
      throw new Error(hint);
    }

    const body = await response.json().catch(() => ({ error: 'Unknown error' }));
    const msg = (body as Record<string, string>).error || `HTTP ${response.status}`;
    const detail = (body as Record<string, string>).detail;
    const fullMsg = detail ? `${msg}: ${detail}` : msg;
    logger.error('[validateLicenseKey] %d %s', response.status, fullMsg);
    throw new Error(fullMsg);
  }

  const data = (await response.json()) as ConnectResponse;

  return {
    workspaceId: data.workspaceId,
    businessContext: data.businessContext,
    agents: data.agents,
    sessionToken: data.sessionToken,
  };
}
