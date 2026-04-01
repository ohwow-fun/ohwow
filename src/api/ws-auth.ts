/**
 * WebSocket Authentication Helper
 * Validates tokens for WebSocket connections, supporting both:
 * - Local session tokens (string equality, fast path)
 * - Cloud content tokens (ES256 JWT verification via jose)
 *
 * Used by /ws/terminal (and can be retrofitted to /ws, /ws/voice).
 */

import { jwtVerify, importJWK } from 'jose';

export interface WsAuthResult {
  workspaceId: string;
  userId: string;
}

export interface WsAuthDeps {
  /** Local daemon session token (string equality check). */
  sessionToken: string;
  /** Cloud-signed ES256 public key (JWK) for content token verification. */
  cloudPublicKey?: JsonWebKey;
}

let cachedKey: CryptoKey | null = null;

/**
 * Create a reusable token verifier for WebSocket connections.
 * Returns a function that takes a raw token string and resolves
 * to { workspaceId, userId } or null on failure.
 */
export function createWsAuthVerifier(deps: WsAuthDeps) {
  const { sessionToken, cloudPublicKey } = deps;

  // Reset cached key when deps change (e.g., key rotation on reconnect)
  cachedKey = null;

  return async (token: string): Promise<WsAuthResult | null> => {
    // Fast path: local session token
    if (token === sessionToken) {
      return { workspaceId: 'local', userId: 'local' };
    }

    // Cloud content token (ES256 JWT)
    if (!cloudPublicKey) return null;

    try {
      if (!cachedKey) {
        cachedKey = await importJWK(cloudPublicKey, 'ES256') as CryptoKey;
      }

      const { payload } = await jwtVerify(token, cachedKey, {
        issuer: 'ohwow-cloud',
      });

      if (payload.type !== 'content') return null;

      return {
        workspaceId: payload.workspaceId as string,
        userId: payload.userId as string,
      };
    } catch {
      return null;
    }
  };
}
