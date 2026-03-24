import { describe, it, expect, vi } from 'vitest';
import { TypedEventBus } from '../typed-event-bus.js';
import { EventEmitter } from 'events';

interface TestEvents {
  'user:created': { id: string; name: string };
  'user:deleted': { id: string };
  'ping': undefined;
}

describe('TypedEventBus', () => {
  it('emits and receives typed events', () => {
    const bus = new TypedEventBus<TestEvents>();
    const handler = vi.fn();

    bus.on('user:created', handler);
    bus.emit('user:created', { id: '1', name: 'Alice' });

    expect(handler).toHaveBeenCalledWith({ id: '1', name: 'Alice' });
  });

  it('once fires handler only once', () => {
    const bus = new TypedEventBus<TestEvents>();
    const handler = vi.fn();

    bus.once('user:deleted', handler);
    bus.emit('user:deleted', { id: '1' });
    bus.emit('user:deleted', { id: '2' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ id: '1' });
  });

  it('off removes the handler', () => {
    const bus = new TypedEventBus<TestEvents>();
    const handler = vi.fn();

    bus.on('user:created', handler);
    bus.off('user:created', handler);
    bus.emit('user:created', { id: '1', name: 'Alice' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('setMaxListeners works', () => {
    const bus = new TypedEventBus<TestEvents>();
    bus.setMaxListeners(100);
    expect(bus.getMaxListeners()).toBe(100);
  });

  it('extends EventEmitter for drop-in compatibility', () => {
    const bus = new TypedEventBus<TestEvents>();
    expect(bus).toBeInstanceOf(EventEmitter);
  });

  it('can be passed to functions accepting EventEmitter', () => {
    const bus = new TypedEventBus<TestEvents>();
    function acceptsEmitter(emitter: EventEmitter): boolean {
      return emitter instanceof EventEmitter;
    }
    expect(acceptsEmitter(bus)).toBe(true);
  });

  it('handles multiple listeners on the same event', () => {
    const bus = new TypedEventBus<TestEvents>();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on('user:created', handler1);
    bus.on('user:created', handler2);
    bus.emit('user:created', { id: '1', name: 'Bob' });

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
  });
});
