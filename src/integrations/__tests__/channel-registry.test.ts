import { describe, it, expect } from 'vitest';
import { ChannelRegistry } from '../channel-registry.js';
import type { ChannelType, MessagingChannel, ConnectionIdentity } from '../channel-types.js';

function mockChannel(type: ChannelType, connected = true): MessagingChannel {
  return {
    type,
    sendResponse: async () => true,
    getStatus: () => ({ connected }),
    excludedTools: () => [],
  };
}

function mockMultiChannel(
  type: ChannelType,
  identity: ConnectionIdentity,
  connected = true,
): MessagingChannel {
  return {
    type,
    identity,
    sendResponse: async () => true,
    getStatus: () => ({ connected }),
    excludedTools: () => [],
  };
}

describe('ChannelRegistry', () => {
  // ---- Backward-compatible single-instance behavior ----

  it('register adds a channel, get retrieves it by type', () => {
    const reg = new ChannelRegistry();
    const ch = mockChannel('whatsapp');
    reg.register(ch);
    expect(reg.get('whatsapp')).toBe(ch);
  });

  it('get returns undefined for unregistered type', () => {
    const reg = new ChannelRegistry();
    expect(reg.get('telegram')).toBeUndefined();
  });

  it('getAll returns all registered channels', () => {
    const reg = new ChannelRegistry();
    reg.register(mockChannel('whatsapp'));
    reg.register(mockChannel('telegram'));
    expect(reg.getAll()).toHaveLength(2);
  });

  it('getConnectedTypes filters to only connected channels', () => {
    const reg = new ChannelRegistry();
    reg.register(mockChannel('whatsapp', true));
    reg.register(mockChannel('telegram', false));
    expect(reg.getConnectedTypes()).toEqual(['whatsapp']);
  });

  it('getConnectedTypes returns empty array when no channels connected', () => {
    const reg = new ChannelRegistry();
    reg.register(mockChannel('whatsapp', false));
    expect(reg.getConnectedTypes()).toEqual([]);
  });

  it('unregister removes a channel and returns true', () => {
    const reg = new ChannelRegistry();
    reg.register(mockChannel('whatsapp'));
    expect(reg.unregister('whatsapp')).toBe(true);
    expect(reg.get('whatsapp')).toBeUndefined();
  });

  it('unregister returns false for non-existent channel', () => {
    const reg = new ChannelRegistry();
    expect(reg.unregister('voice')).toBe(false);
  });

  it('handles registering multiple channels of different types', () => {
    const reg = new ChannelRegistry();
    reg.register(mockChannel('whatsapp'));
    reg.register(mockChannel('telegram'));
    reg.register(mockChannel('voice'));
    expect(reg.getAll()).toHaveLength(3);
    expect(reg.get('whatsapp')?.type).toBe('whatsapp');
    expect(reg.get('telegram')?.type).toBe('telegram');
    expect(reg.get('voice')?.type).toBe('voice');
  });

  // ---- Multi-instance behavior ----

  it('registers multiple instances of the same type with different connectionIds', () => {
    const reg = new ChannelRegistry();
    const wa1 = mockMultiChannel('whatsapp', { connectionId: 'wa-1', label: 'Sales' });
    const wa2 = mockMultiChannel('whatsapp', { connectionId: 'wa-2', label: 'Support' });
    reg.register(wa1);
    reg.register(wa2);

    expect(reg.getAll()).toHaveLength(2);
    expect(reg.getAllOfType('whatsapp')).toHaveLength(2);
  });

  it('getByConnectionId returns exact instance', () => {
    const reg = new ChannelRegistry();
    const wa1 = mockMultiChannel('whatsapp', { connectionId: 'wa-1' });
    const wa2 = mockMultiChannel('whatsapp', { connectionId: 'wa-2' });
    reg.register(wa1);
    reg.register(wa2);

    expect(reg.getByConnectionId('wa-1')).toBe(wa1);
    expect(reg.getByConnectionId('wa-2')).toBe(wa2);
    expect(reg.getByConnectionId('wa-3')).toBeUndefined();
  });

  it('get(type) returns the default instance when one is marked isDefault', () => {
    const reg = new ChannelRegistry();
    const wa1 = mockMultiChannel('whatsapp', { connectionId: 'wa-1' });
    const wa2 = mockMultiChannel('whatsapp', { connectionId: 'wa-2', isDefault: true });
    reg.register(wa1);
    reg.register(wa2);

    expect(reg.get('whatsapp')).toBe(wa2);
  });

  it('get(type) returns first registered when no default is set', () => {
    const reg = new ChannelRegistry();
    const wa1 = mockMultiChannel('whatsapp', { connectionId: 'wa-1' });
    const wa2 = mockMultiChannel('whatsapp', { connectionId: 'wa-2' });
    reg.register(wa1);
    reg.register(wa2);

    expect(reg.get('whatsapp')).toBe(wa1);
  });

  it('getAllOfType returns empty array for unregistered type', () => {
    const reg = new ChannelRegistry();
    expect(reg.getAllOfType('voice')).toEqual([]);
  });

  it('getConnectedTypes lists type if any instance is connected', () => {
    const reg = new ChannelRegistry();
    reg.register(mockMultiChannel('whatsapp', { connectionId: 'wa-1' }, false));
    reg.register(mockMultiChannel('whatsapp', { connectionId: 'wa-2' }, true));
    expect(reg.getConnectedTypes()).toEqual(['whatsapp']);
  });

  it('unregisterByConnectionId removes only the specified instance', () => {
    const reg = new ChannelRegistry();
    const wa1 = mockMultiChannel('whatsapp', { connectionId: 'wa-1' });
    const wa2 = mockMultiChannel('whatsapp', { connectionId: 'wa-2' });
    reg.register(wa1);
    reg.register(wa2);

    expect(reg.unregisterByConnectionId('wa-1')).toBe(true);
    expect(reg.getByConnectionId('wa-1')).toBeUndefined();
    expect(reg.getByConnectionId('wa-2')).toBe(wa2);
    expect(reg.getAllOfType('whatsapp')).toHaveLength(1);
  });

  it('unregisterByConnectionId returns false for unknown id', () => {
    const reg = new ChannelRegistry();
    expect(reg.unregisterByConnectionId('nope')).toBe(false);
  });

  it('unregister(type) removes all instances of that type', () => {
    const reg = new ChannelRegistry();
    reg.register(mockMultiChannel('whatsapp', { connectionId: 'wa-1' }));
    reg.register(mockMultiChannel('whatsapp', { connectionId: 'wa-2' }));
    reg.register(mockChannel('telegram'));

    expect(reg.unregister('whatsapp')).toBe(true);
    expect(reg.getAllOfType('whatsapp')).toHaveLength(0);
    expect(reg.get('telegram')?.type).toBe('telegram');
  });

  it('mixes singleton and multi-instance channels', () => {
    const reg = new ChannelRegistry();
    reg.register(mockChannel('tui'));
    reg.register(mockMultiChannel('whatsapp', { connectionId: 'wa-1' }));
    reg.register(mockMultiChannel('whatsapp', { connectionId: 'wa-2' }));
    reg.register(mockChannel('voice'));

    expect(reg.getAll()).toHaveLength(4);
    expect(reg.get('tui')?.type).toBe('tui');
    expect(reg.getAllOfType('whatsapp')).toHaveLength(2);
    expect(reg.get('voice')?.type).toBe('voice');
  });

  // ---- Outbound selection strategies ----

  it('selectOutbound returns undefined when no connected instances', () => {
    const reg = new ChannelRegistry();
    reg.register(mockMultiChannel('whatsapp', { connectionId: 'wa-1' }, false));
    expect(reg.selectOutbound('whatsapp')).toBeUndefined();
  });

  it('selectOutbound default returns the default instance', () => {
    const reg = new ChannelRegistry();
    const wa1 = mockMultiChannel('whatsapp', { connectionId: 'wa-1' });
    const wa2 = mockMultiChannel('whatsapp', { connectionId: 'wa-2', isDefault: true });
    reg.register(wa1);
    reg.register(wa2);
    expect(reg.selectOutbound('whatsapp', 'default')).toBe(wa2);
  });

  it('selectOutbound by-label finds matching label', () => {
    const reg = new ChannelRegistry();
    const wa1 = mockMultiChannel('whatsapp', { connectionId: 'wa-1', label: 'Sales' });
    const wa2 = mockMultiChannel('whatsapp', { connectionId: 'wa-2', label: 'Support' });
    reg.register(wa1);
    reg.register(wa2);
    expect(reg.selectOutbound('whatsapp', 'by-label', { label: 'support' })).toBe(wa2);
  });

  it('selectOutbound by-label falls back to default when no match', () => {
    const reg = new ChannelRegistry();
    reg.register(mockMultiChannel('whatsapp', { connectionId: 'wa-1', label: 'Sales' }));
    const result = reg.selectOutbound('whatsapp', 'by-label', { label: 'HR' });
    expect(result).toBeDefined();
    expect(result?.type).toBe('whatsapp');
  });

  it('selectOutbound round-robin cycles through instances', () => {
    const reg = new ChannelRegistry();
    const wa1 = mockMultiChannel('whatsapp', { connectionId: 'wa-1' });
    const wa2 = mockMultiChannel('whatsapp', { connectionId: 'wa-2' });
    reg.register(wa1);
    reg.register(wa2);

    const first = reg.selectOutbound('whatsapp', 'round-robin');
    const second = reg.selectOutbound('whatsapp', 'round-robin');
    const third = reg.selectOutbound('whatsapp', 'round-robin');

    expect(first).not.toBe(second);
    expect(third).toBe(first); // cycles back
  });
});
