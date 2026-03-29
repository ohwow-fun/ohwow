/**
 * Runtime API Middleware
 * Validates content token JWT, local session tokens, or peer tokens.
 */

import type { Request, Response, NextFunction } from 'express';
import { jwtVerify, importJWK } from 'jose';
import type { DatabaseAdapter } from '../db/adapter-types.js';

/**
 * Create auth middleware that validates content tokens, local session tokens,
 * or peer tokens (X-Peer-Token header for workspace-to-workspace peering).
 *
 * When `contentPublicKey` (JWK) is provided, content tokens are verified
 * with ES256 asymmetric verification (local mode with cloud-signed tokens).
 * Otherwise falls back to HS256 symmetric verification using `jwtSecret`.
 */
export function createAuthMiddleware(
  jwtSecret: string,
  localSessionToken?: string,
  contentPublicKey?: JsonWebKey,
  db?: DatabaseAdapter,
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
          req.workspaceId = 'local';
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
      req.workspaceId = 'local';
      req.userId = 'local';
      next();
      return;
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

      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}
