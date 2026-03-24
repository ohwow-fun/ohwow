/**
 * Typed Event Bus
 *
 * Extends EventEmitter with compile-time type safety for event names
 * and payload types. Drop-in replacement for EventEmitter — existing
 * code that accepts EventEmitter will work unchanged.
 */

import { EventEmitter } from 'events';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export class TypedEventBus<TEventMap extends {}> extends EventEmitter {
  override emit<K extends keyof TEventMap & string>(event: K, payload: TEventMap[K]): boolean;
  override emit(event: string, ...args: unknown[]): boolean;
  override emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof TEventMap & string>(event: K, handler: (payload: TEventMap[K]) => void): this;
  override on(event: string, handler: (...args: unknown[]) => void): this;
  override on(event: string, handler: (...args: unknown[]) => void): this {
    return super.on(event, handler);
  }

  override off<K extends keyof TEventMap & string>(event: K, handler: (payload: TEventMap[K]) => void): this;
  override off(event: string, handler: (...args: unknown[]) => void): this;
  override off(event: string, handler: (...args: unknown[]) => void): this {
    return super.off(event, handler);
  }

  override once<K extends keyof TEventMap & string>(event: K, handler: (payload: TEventMap[K]) => void): this;
  override once(event: string, handler: (...args: unknown[]) => void): this;
  override once(event: string, handler: (...args: unknown[]) => void): this {
    return super.once(event, handler);
  }
}
