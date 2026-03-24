import { useCallback } from 'react';
import { useWsListener } from './useWebSocket';
import { toast } from '../components/Toast';

/**
 * Listen for WebSocket events and show toast notifications.
 */
export function useEventToasts() {
  useWsListener(useCallback((event: string, data: unknown) => {
    const d = data as Record<string, string>;
    switch (event) {
      case 'task:completed':
        toast('success', `Task completed${d?.taskId ? ` (${d.taskId.slice(0, 8)})` : ''}`);
        break;
      case 'task:failed':
        toast('error', `Task failed: ${d?.error || 'Unknown error'}`);
        break;
      case 'cloud:connected':
        toast('info', 'Connected to cloud');
        break;
      case 'cloud:disconnected':
        toast('error', `Disconnected: ${d?.reason || 'Unknown'}`);
        break;
      case 'credits:exhausted':
        toast('info', 'Cloud credits exhausted. Tasks are running on your local model.');
        break;
    }
  }, []));
}
