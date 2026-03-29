import { describe, it, expect } from 'vitest';
import { TABLE_MAP } from '../message-router.js';
import type { ChannelType } from '../channel-types.js';

describe('TABLE_MAP', () => {
  const allChannels: ChannelType[] = ['tui', 'whatsapp', 'telegram', 'voice'];

  it('maps every ChannelType to a table name', () => {
    for (const channel of allChannels) {
      expect(TABLE_MAP[channel]).toBeDefined();
      expect(TABLE_MAP[channel]).toMatch(/^[a-z_]+$/);
    }
  });

  it('throws for unknown channel types at runtime', () => {
    const unknown = 'evil; DROP TABLE users' as ChannelType;
    expect(TABLE_MAP[unknown]).toBeUndefined();
  });
});
