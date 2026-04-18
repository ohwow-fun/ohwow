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
      case 'budget:warning':
        toast('info', `Budget at ${d?.pct || '?'}% capacity`);
        break;
      case 'budget:exceeded':
        toast('error', `Budget exceeded: ${d?.reason || 'Limit reached'}`);
        break;
      // Gap 13 — per-workspace autonomous LLM daily cap. Every payload
      // carries a `summary` string built by budget-notifications.ts, so
      // the toast renders verbatim. Severity maps to the band.
      case 'budget:llm-warn':
        toast('info', d?.summary || "Today's autonomous LLM spend is approaching the cap.");
        break;
      case 'budget:llm-degrade':
        toast('info', d?.summary || 'Autonomous LLM work is routing to a cheaper model for the rest of the day.');
        break;
      case 'budget:llm-pause':
        toast('error', d?.summary || 'Autonomous LLM work is paused for today. Raise the cap or wait for the day to roll over.');
        break;
      case 'budget:llm-halt':
        toast('error', d?.summary || 'Autonomous LLM work is halted for today. Raise the cap to resume.');
        break;
      case 'model:switch-started':
        toast('info', `Switching model to ${d?.model || 'new model'}...`);
        break;
      case 'model:switch-complete':
        toast('success', `Now using ${d?.model || 'model'} via ${d?.provider || 'local'}`);
        break;
      case 'model:switch-failed':
        toast('error', `Model switch failed: ${d?.reason || 'Unknown error'}`);
        break;
      case 'inference:capabilities-changed': {
        const caps = data as Record<string, unknown>;
        if (caps?.turboQuantActive) {
          toast('info', `TurboQuant ${caps.turboQuantBits}-bit active via ${caps.provider}`);
        }
        break;
      }
    }
  }, []));
}
