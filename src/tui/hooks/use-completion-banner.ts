/**
 * Completion Banner Hook
 * Listens for task lifecycle events and surfaces a short-lived BannerState
 * that auto-dismisses after 4 seconds.
 */

import { useState, useEffect } from 'react';
import { getEventBus } from './use-event-bus.js';

export interface BannerState {
  kind: 'completed' | 'failed' | 'approval';
  title: string;
  agentName?: string;
  error?: string;
}

export function useBanner(): { banner: BannerState | null } {
  const [banner, setBanner] = useState<BannerState | null>(null);

  useEffect(() => {
    const bus = getEventBus();

    const onCompleted = () => {
      setBanner({ kind: 'completed', title: 'Task complete' });
    };

    const onFailed = (payload: { taskId: string; agentId: string; error: string }) => {
      setBanner({ kind: 'failed', title: 'Task stopped', error: payload.error });
    };

    const onApproval = (payload: {
      taskId: string;
      agentId: string;
      agentName: string;
      taskTitle: string;
    }) => {
      setBanner({
        kind: 'approval',
        title: payload.taskTitle,
        agentName: payload.agentName,
      });
    };

    bus.on('task:completed', onCompleted);
    bus.on('task:failed', onFailed);
    bus.on('task:needs_approval', onApproval);

    return () => {
      bus.off('task:completed', onCompleted);
      bus.off('task:failed', onFailed);
      bus.off('task:needs_approval', onApproval);
    };
  }, []);

  // Auto-dismiss after 4 seconds
  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 4000);
    return () => clearTimeout(t);
  }, [banner]);

  return { banner };
}
