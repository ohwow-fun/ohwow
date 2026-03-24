import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateLicenseKey } from '../validate-license.js';

// Mock os.hostname to return a stable value
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    hostname: () => 'test-machine.local',
    networkInterfaces: () => ({
      en0: [{ internal: false, mac: 'aa:bb:cc:dd:ee:ff', address: '192.168.1.1', family: 'IPv4', netmask: '255.255.255.0', cidr: '192.168.1.1/24' }],
    }),
  };
});

const CLOUD_URL = 'https://cloud.test';

function mockFetchResponse(status: number, body: unknown, ok?: boolean) {
  return vi.fn().mockResolvedValue({
    ok: ok ?? (status >= 200 && status < 300),
    status,
    json: () => Promise.resolve(body),
  });
}

const validResponse = {
  sessionToken: 'tok-123',
  workspaceId: 'ws-1',
  deviceId: 'dev-1',
  agents: [{ id: 'a1', name: 'Bot', role: 'Helper', department: 'Ops' }],
  businessContext: { businessName: 'Acme', businessType: 'saas' },
};

describe('validateLicenseKey', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('successful validation returns workspaceId, businessContext, agents, sessionToken', async () => {
    globalThis.fetch = mockFetchResponse(200, validResponse);
    const result = await validateLicenseKey('key-123', CLOUD_URL);
    expect(result.workspaceId).toBe('ws-1');
    expect(result.businessContext.businessName).toBe('Acme');
    expect(result.agents).toHaveLength(1);
    expect(result.sessionToken).toBe('tok-123');
  });

  it('HTTP 401 throws with error message from body', async () => {
    globalThis.fetch = mockFetchResponse(401, { error: 'Invalid license key' });
    await expect(validateLicenseKey('bad-key', CLOUD_URL)).rejects.toThrow('Invalid license key');
  });

  it('HTTP 409 with same hostname auto-retries with force: true', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () => Promise.resolve({
          currentDevice: { hostname: 'test-machine.local' },
          warning: 'Already connected',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(validResponse),
      });
    globalThis.fetch = fetchMock;
    const result = await validateLicenseKey('key-123', CLOUD_URL);
    expect(result.workspaceId).toBe('ws-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Second call should include force: true
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.force).toBe(true);
  });

  it('HTTP 409 with different hostname throws descriptive error', async () => {
    globalThis.fetch = mockFetchResponse(409, {
      currentDevice: { hostname: 'other-machine.local' },
    });
    await expect(validateLicenseKey('key-123', CLOUD_URL)).rejects.toThrow(
      'Your license is active on "other-machine.local"',
    );
  });

  it('HTTP 409 retry success returns valid result', async () => {
    // Same hostname with Bonjour suffix variation (normalizeHostname strips -N and .local)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () => Promise.resolve({
          currentDevice: { hostname: 'test-machine-2.local' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(validResponse),
      });
    globalThis.fetch = fetchMock;
    const result = await validateLicenseKey('key-123', CLOUD_URL);
    expect(result.workspaceId).toBe('ws-1');
  });

  it('network error throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network failure'));
    await expect(validateLicenseKey('key-123', CLOUD_URL)).rejects.toThrow('Network failure');
  });

  it('HTTP error with detail field includes detail in message', async () => {
    globalThis.fetch = mockFetchResponse(403, { error: 'Forbidden', detail: 'License expired' });
    await expect(validateLicenseKey('key-123', CLOUD_URL)).rejects.toThrow('Forbidden: License expired');
  });

  it('HTTP 409 with no hostname throws generic message', async () => {
    globalThis.fetch = mockFetchResponse(409, { currentDevice: {} });
    await expect(validateLicenseKey('key-123', CLOUD_URL)).rejects.toThrow(
      'Your license is active on another device',
    );
  });
});
