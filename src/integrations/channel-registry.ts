/**
 * Channel Registry
 * Supports multiple channel instances per type (e.g. two WhatsApp numbers).
 *
 * Primary store: Map<connectionId, MessagingChannel>
 * Type index:    Map<ChannelType, Set<connectionId>>
 *
 * Backward compat: get(type) returns the first (or default) instance.
 * Singleton channels (TUI, voice) have no identity and are keyed by type.
 */

import type { ChannelType, MessagingChannel } from './channel-types.js';

export class ChannelRegistry {
  /** Primary store keyed by connectionId (or type for singleton channels) */
  private channels = new Map<string, MessagingChannel>();
  /** Type → set of keys in the primary store */
  private typeIndex = new Map<ChannelType, Set<string>>();

  /**
   * Register a channel instance.
   * Multi-instance channels must have an `identity` with a connectionId.
   * Singleton channels (no identity) are keyed by their type string.
   */
  register(channel: MessagingChannel): void {
    const key = this.keyFor(channel);
    this.channels.set(key, channel);
    let set = this.typeIndex.get(channel.type);
    if (!set) {
      set = new Set();
      this.typeIndex.set(channel.type, set);
    }
    set.add(key);
  }

  /**
   * Get the default (or only) channel for a type.
   * For multi-instance types, returns the one marked isDefault, or the first registered.
   */
  get(type: ChannelType): MessagingChannel | undefined {
    const keys = this.typeIndex.get(type);
    if (!keys || keys.size === 0) return undefined;

    // For singleton channels (keyed by type string), fast path
    if (keys.size === 1) {
      const [key] = keys;
      return this.channels.get(key);
    }

    // Multi-instance: prefer the default
    for (const key of keys) {
      const ch = this.channels.get(key);
      if (ch?.identity?.isDefault) return ch;
    }

    // No explicit default: return first
    const [firstKey] = keys;
    return this.channels.get(firstKey);
  }

  /**
   * Get a specific channel instance by connectionId.
   */
  getByConnectionId(connectionId: string): MessagingChannel | undefined {
    return this.channels.get(connectionId);
  }

  /**
   * Get all channel instances of a given type.
   */
  getAllOfType(type: ChannelType): MessagingChannel[] {
    const keys = this.typeIndex.get(type);
    if (!keys) return [];
    const result: MessagingChannel[] = [];
    for (const key of keys) {
      const ch = this.channels.get(key);
      if (ch) result.push(ch);
    }
    return result;
  }

  /**
   * Get all registered channels (all types, all instances).
   */
  getAll(): MessagingChannel[] {
    return [...this.channels.values()];
  }

  /**
   * Get channel types that have at least one connected instance.
   */
  getConnectedTypes(): ChannelType[] {
    const types: ChannelType[] = [];
    for (const [type, keys] of this.typeIndex) {
      for (const key of keys) {
        const ch = this.channels.get(key);
        if (ch?.getStatus().connected) {
          types.push(type);
          break; // one connected instance is enough
        }
      }
    }
    return types;
  }

  /**
   * Unregister a channel by type (removes default/only instance).
   * For multi-instance types, removes all instances.
   */
  unregister(type: ChannelType): boolean {
    const keys = this.typeIndex.get(type);
    if (!keys || keys.size === 0) return false;
    for (const key of keys) {
      this.channels.delete(key);
    }
    this.typeIndex.delete(type);
    return true;
  }

  /**
   * Unregister a specific channel instance by connectionId.
   */
  unregisterByConnectionId(connectionId: string): boolean {
    const ch = this.channels.get(connectionId);
    if (!ch) return false;
    this.channels.delete(connectionId);
    const keys = this.typeIndex.get(ch.type);
    if (keys) {
      keys.delete(connectionId);
      if (keys.size === 0) this.typeIndex.delete(ch.type);
    }
    return true;
  }

  /**
   * Select an outbound channel instance for sending, using a routing strategy.
   *
   * Strategies:
   * - "default": the connection marked isDefault (or first registered)
   * - "by-label": match by connection label (e.g. "Sales")
   * - "round-robin": distribute evenly across connected instances
   */
  selectOutbound(
    type: ChannelType,
    strategy: 'default' | 'by-label' | 'round-robin' = 'default',
    context?: { label?: string },
  ): MessagingChannel | undefined {
    const instances = this.getAllOfType(type).filter((ch) => ch.getStatus().connected);
    if (instances.length === 0) return undefined;

    switch (strategy) {
      case 'by-label': {
        if (!context?.label) return this.get(type);
        const lower = context.label.toLowerCase();
        return instances.find((ch) => ch.identity?.label?.toLowerCase() === lower) ?? this.get(type);
      }
      case 'round-robin': {
        const idx = this.roundRobinCounter;
        this.roundRobinCounter = (this.roundRobinCounter + 1) % instances.length;
        return instances[idx % instances.length];
      }
      case 'default':
      default:
        return this.get(type);
    }
  }

  /** Round-robin counter for outbound distribution */
  private roundRobinCounter = 0;

  /** Derive the map key for a channel */
  private keyFor(channel: MessagingChannel): string {
    return channel.identity?.connectionId ?? channel.type;
  }
}
