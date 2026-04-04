/**
 * Connector Registry
 * Manages registered connector factories and active connector instances.
 * Pattern mirrors ChannelRegistry from channel-registry.ts.
 */

import type { ConnectorType, ConnectorFactory, ConnectorConfig, DataSourceConnector } from './connector-types.js';

export class ConnectorRegistry {
  private factories = new Map<ConnectorType, ConnectorFactory>();
  private instances = new Map<string, DataSourceConnector>(); // keyed by config.id

  /** Register a connector factory for a given type */
  registerFactory(type: ConnectorType, factory: ConnectorFactory): void {
    this.factories.set(type, factory);
  }

  /** Create and cache a connector instance from config */
  create(config: ConnectorConfig): DataSourceConnector | undefined {
    const factory = this.factories.get(config.type);
    if (!factory) return undefined;
    const instance = factory(config);
    this.instances.set(config.id, instance);
    return instance;
  }

  /** Get an active connector instance by config ID */
  get(configId: string): DataSourceConnector | undefined {
    return this.instances.get(configId);
  }

  /** Get all registered connector types */
  getRegisteredTypes(): ConnectorType[] {
    return [...this.factories.keys()];
  }

  /** Get all active connector instances */
  getAll(): DataSourceConnector[] {
    return [...this.instances.values()];
  }

  /** Check if a factory is registered for a type */
  hasFactory(type: ConnectorType): boolean {
    return this.factories.has(type);
  }

  /** Remove a connector instance */
  remove(configId: string): boolean {
    return this.instances.delete(configId);
  }
}
