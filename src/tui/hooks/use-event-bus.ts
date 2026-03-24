/**
 * Event Bus Hook
 * Bridges imperative runtime events (EventEmitter) into React re-renders.
 * Singleton EventEmitter shared across the runtime and TUI.
 */

import { useState, useEffect, useRef } from 'react';
import { TypedEventBus } from '../../lib/typed-event-bus.js';
import type { RuntimeEventName, RuntimeEvents } from '../types.js';

/** Singleton event bus for the runtime */
let globalBus: TypedEventBus<RuntimeEvents> | null = null;

export function getEventBus(): TypedEventBus<RuntimeEvents> {
  if (!globalBus) {
    globalBus = new TypedEventBus<RuntimeEvents>();
    globalBus.setMaxListeners(50);
  }
  return globalBus;
}

/**
 * Subscribe to a runtime event. Returns the latest event payload
 * and triggers a re-render on each emission.
 */
export function useEvent<K extends RuntimeEventName>(
  eventName: K,
): RuntimeEvents[K] | null {
  const [data, setData] = useState<RuntimeEvents[K] | null>(null);
  const busRef = useRef(getEventBus());

  useEffect(() => {
    const bus = busRef.current;
    const handler = (payload: RuntimeEvents[K]) => {
      setData(payload);
    };
    bus.on(eventName, handler);
    return () => {
      bus.off(eventName, handler);
    };
  }, [eventName]);

  return data;
}

/**
 * Get a refresh trigger that increments whenever any of the
 * specified events fire. Useful for re-fetching data.
 */
export function useEventRefresh(events: RuntimeEventName[]): number {
  const [tick, setTick] = useState(0);
  const busRef = useRef(getEventBus());

  useEffect(() => {
    const bus = busRef.current;
    const handler = () => setTick(t => t + 1);
    for (const evt of events) {
      bus.on(evt, handler);
    }
    return () => {
      for (const evt of events) {
        bus.off(evt, handler);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.join(',')]);

  return tick;
}
