import { describe, it, expect } from 'vitest';
import { ConnectorRegistry } from '../connector-registry.js';
import type { ConnectorType, ConnectorConfig, DataSourceConnector, ConnectorDocument } from '../connector-types.js';

function mockConfig(overrides?: Partial<ConnectorConfig>): ConnectorConfig {
  return {
    id: 'test-config-1',
    type: 'github' as ConnectorType,
    name: 'Test GitHub',
    settings: { repo: 'owner/repo' },
    syncIntervalMinutes: 30,
    pruneIntervalDays: 30,
    enabled: true,
    ...overrides,
  };
}

function mockConnector(type: ConnectorType = 'github', name = 'Mock'): DataSourceConnector {
  return {
    type,
    name,
    async *load(): AsyncGenerator<ConnectorDocument> {
      yield { id: '1', title: 'Doc 1', content: 'Content 1' };
    },
    async testConnection() {
      return { ok: true };
    },
  };
}

describe('ConnectorRegistry', () => {
  it('registerFactory adds a factory, hasFactory returns true', () => {
    const reg = new ConnectorRegistry();
    reg.registerFactory('github', () => mockConnector());
    expect(reg.hasFactory('github')).toBe(true);
    expect(reg.hasFactory('notion')).toBe(false);
  });

  it('create uses registered factory and caches instance', () => {
    const reg = new ConnectorRegistry();
    const connector = mockConnector();
    reg.registerFactory('github', () => connector);

    const config = mockConfig();
    const created = reg.create(config);

    expect(created).toBe(connector);
    expect(reg.get(config.id)).toBe(connector);
  });

  it('create returns undefined for unregistered type', () => {
    const reg = new ConnectorRegistry();
    const config = mockConfig({ type: 'notion' });
    expect(reg.create(config)).toBeUndefined();
  });

  it('get returns undefined for unknown configId', () => {
    const reg = new ConnectorRegistry();
    expect(reg.get('nonexistent')).toBeUndefined();
  });

  it('getRegisteredTypes returns all factory types', () => {
    const reg = new ConnectorRegistry();
    reg.registerFactory('github', () => mockConnector('github'));
    reg.registerFactory('local-files', () => mockConnector('local-files'));

    const types = reg.getRegisteredTypes();
    expect(types).toContain('github');
    expect(types).toContain('local-files');
    expect(types.length).toBe(2);
  });

  it('getAll returns all active instances', () => {
    const reg = new ConnectorRegistry();
    reg.registerFactory('github', () => mockConnector('github'));
    reg.registerFactory('local-files', () => mockConnector('local-files'));

    reg.create(mockConfig({ id: 'c1', type: 'github' }));
    reg.create(mockConfig({ id: 'c2', type: 'local-files' }));

    expect(reg.getAll().length).toBe(2);
  });

  it('remove deletes an instance', () => {
    const reg = new ConnectorRegistry();
    reg.registerFactory('github', () => mockConnector());
    reg.create(mockConfig({ id: 'c1' }));

    expect(reg.get('c1')).toBeDefined();
    expect(reg.remove('c1')).toBe(true);
    expect(reg.get('c1')).toBeUndefined();
  });

  it('remove returns false for unknown configId', () => {
    const reg = new ConnectorRegistry();
    expect(reg.remove('nonexistent')).toBe(false);
  });

  it('connector load yields documents', async () => {
    const reg = new ConnectorRegistry();
    reg.registerFactory('github', () => mockConnector());
    const connector = reg.create(mockConfig())!;

    const docs: ConnectorDocument[] = [];
    for await (const doc of connector.load()) {
      docs.push(doc);
    }

    expect(docs.length).toBe(1);
    expect(docs[0].title).toBe('Doc 1');
  });
});
