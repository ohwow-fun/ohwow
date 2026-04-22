/**
 * Runtime API Middleware
 * Validates content token JWT, local session tokens, or peer tokens.
 */

import type { Request, Response, NextFunction } from 'express';
import { jwtVerify, importJWK } from 'jose';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { verifyDaemonToken } from '../daemon/token-codec.js';
import type { WorkspaceDbPool } from '../db/workspace-db-pool.js';
import type { WorkspaceRegistry } from '../daemon/workspace-registry.js';
import { logger } from '../lib/logger.js';
import { recordActivity } from '../eternal/index.js';

/**
 * Create auth middleware that validates content tokens, local session tokens,
 * or peer tokens (X-Peer-Token header for workspace-to-workspace peering).
 *
 * When `contentPublicKey` (JWK) is provided, content tokens are verified
 * with ES256 asymmetric verification (local mode with cloud-signed tokens).
 * Otherwise falls back to HS256 symmetric verification using `jwtSecret`.
 *
 * `getLocalWorkspaceId` returns the canonical workspace id the daemon is
 * currently operating under — the cloud Supabase UUID when the control
 * plane is connected, or "local" otherwise. Local session tokens
 * (including peer tokens) resolve to this id so HTTP-inserted rows
 * (contacts, tasks, activity) land in the same workspace scope the
 * orchestrator tools query, avoiding silent local-vs-cloud fragmentation.
 * It is a getter because connection state can change mid-process.
 */
export function createAuthMiddleware(
  jwtSecret: string,
  localSessionToken?: string,
  contentPublicKey?: JsonWebKey,
  db?: DatabaseAdapter,
  getLocalWorkspaceId: () => string = () => 'local',
  dbPool?: WorkspaceDbPool,
  registry?: WorkspaceRegistry,
) {
  const symmetricSecret = new TextEncoder().encode(jwtSecret);

  // Cache the imported key so we don't re-import on every request
  let cachedKey: CryptoKey | null = null;

  async function getVerificationKey(): Promise<CryptoKey | Uint8Array> {
    if (contentPublicKey) {
      if (!cachedKey) {
        cachedKey = await importJWK(contentPublicKey, 'ES256') as CryptoKey;
      }
      return cachedKey;
    }
    return symmetricSecret;
  }

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Public capability-probe endpoints — return only service reachability,
    // no workspace data. Web UI polls these on load to decide whether to
    // offer voice controls, so requiring auth just floods the console with
    // 401s while the user is still on the login screen or signed out.
    // Middleware is mounted at /api, so req.path is relative (e.g. /voice/providers).
    // req.originalUrl preserves the full path and may include a querystring.
    const fullPath = req.originalUrl.split('?')[0];
    if (fullPath === '/api/voice/providers' || fullPath === '/api/voice/health') {
      next();
      return;
    }

    // Check peer token (X-Peer-Token header for workspace-to-workspace calls)
    const peerToken = req.headers['x-peer-token'] as string | undefined;
    if (peerToken && db) {
      try {
        const { data: peer } = await db.from('workspace_peers')
          .select('id, status')
          .eq('our_token', peerToken)
          .eq('status', 'connected')
          .maybeSingle();

        if (peer) {
          const p = peer as { id: string; status: string };
          req.workspaceId = getLocalWorkspaceId();
          req.userId = `peer:${p.id}`;

          // Update last_seen_at
          await db.from('workspace_peers').update({
            last_seen_at: new Date().toISOString(),
          }).eq('id', p.id);

          next();
          return;
        }
      } catch {
        // Fall through to other auth methods
      }
    }

    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing authorization header' });
      return;
    }

    const token = authHeader.slice(7);

    // Check local session token first (fast path for web UI)
    if (localSessionToken && token === localSessionToken) {
      req.workspaceId = getLocalWorkspaceId();
      req.userId = 'local';
      if (db) {
        recordActivity(db).catch((err) =>
          logger.warn({ err }, 'eternal.record_activity.failed'),
        );
      }
      next();
      return;
    }

    // Daemon JWT fast-path: token carries workspaceName claim; inject dbPool
    // and resolve the WorkspaceContext from the registry if available.
    if (dbPool) {
      const payload = await verifyDaemonToken(token, jwtSecret);
      if (payload) {
        try {
          dbPool.get(payload.workspaceName); // verify workspace is accessible
          req.workspaceName = payload.workspaceName;
          req.dbPool = dbPool;
          req.userId = 'local';
          if (registry?.has(payload.workspaceName)) {
            req.workspaceCtx = registry.get(payload.workspaceName);
          }
          if (db) {
            recordActivity(db).catch((err) =>
              logger.warn({ err }, 'eternal.record_activity.failed'),
            );
          }
          next();
          return;
        } catch {
          res.status(401).json({ error: 'Workspace not found or inaccessible' });
          return;
        }
      }
    }

    // Fall back to cloud JWT verification
    try {
      const key = await getVerificationKey();
      const { payload } = await jwtVerify(token, key, {
        issuer: 'ohwow-cloud',
      });

      if (payload.type !== 'content') {
        res.status(401).json({ error: 'Invalid token type' });
        return;
      }

      // Attach workspace info to request
      req.workspaceId = payload.workspaceId as string;
      req.userId = payload.userId as string;

      if (db) {
        recordActivity(db).catch((err) =>
          logger.warn({ err }, 'eternal.record_activity.failed'),
        );
      }
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}
