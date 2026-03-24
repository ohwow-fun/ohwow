/**
 * useWebSocket Hook
 * Subscribes to WebSocket events and triggers refetches.
 */

import { useEffect, useRef, useState } from 'react';
import { onWsEvent, connectWebSocket } from '../api/ws';

/**
 * Listen for specific WebSocket events and return a tick counter
 * that increments on each matching event. Use as a dependency for useApi.
 */
export function useWsRefresh(eventNames: string[]): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    connectWebSocket();
    return onWsEvent((event) => {
      if (eventNames.includes(event)) {
        setTick(t => t + 1);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventNames.join(',')]);

  return tick;
}

/**
 * Listen for any WebSocket event and call a handler.
 */
export function useWsListener(handler: (event: string, data: unknown) => void) {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    connectWebSocket();
    return onWsEvent((event, data) => {
      handlerRef.current(event, data);
    });
  }, []);
}
