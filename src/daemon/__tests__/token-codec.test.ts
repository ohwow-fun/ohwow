import { describe, it, expect } from 'vitest';
import { signDaemonToken, verifyDaemonToken } from '../token-codec.js';

const SIGNING_KEY = 'test-jwt-secret-for-token-codec';

describe('signDaemonToken', () => {
  it('produces a non-empty string', async () => {
    const token = await signDaemonToken('default', SIGNING_KEY);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  it('produces a three-part JWT string', async () => {
    const token = await signDaemonToken('default', SIGNING_KEY);
    expect(token.split('.').length).toBe(3);
  });
});

describe('verifyDaemonToken', () => {
  it('returns { workspaceName } for a valid token', async () => {
    const token = await signDaemonToken('default', SIGNING_KEY);
    const payload = await verifyDaemonToken(token, SIGNING_KEY);
    expect(payload).toEqual({ workspaceName: 'default' });
  });

  it('returns null for a valid token verified with wrong secret', async () => {
    const token = await signDaemonToken('default', SIGNING_KEY);
    const payload = await verifyDaemonToken(token, 'wrong-secret');
    expect(payload).toBeNull();
  });

  it('returns null for a non-JWT string', async () => {
    const payload = await verifyDaemonToken('not-a-jwt', SIGNING_KEY);
    expect(payload).toBeNull();
  });

  it('returns null for an empty string', async () => {
    const payload = await verifyDaemonToken('', SIGNING_KEY);
    expect(payload).toBeNull();
  });

  it('returns correct workspaceName for a different workspace', async () => {
    const token = await signDaemonToken('avenued', SIGNING_KEY);
    const payload = await verifyDaemonToken(token, SIGNING_KEY);
    expect(payload).toEqual({ workspaceName: 'avenued' });
  });

  it('does not confuse tokens from different workspaces', async () => {
    const defaultToken = await signDaemonToken('default', SIGNING_KEY);
    const avenued = await verifyDaemonToken(defaultToken, SIGNING_KEY);
    expect(avenued?.workspaceName).toBe('default');

    const avenueToken = await signDaemonToken('avenued', SIGNING_KEY);
    const def = await verifyDaemonToken(avenueToken, SIGNING_KEY);
    expect(def?.workspaceName).toBe('avenued');
  });
});
