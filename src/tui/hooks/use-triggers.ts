/**
 * useTriggers Hook
 * Fetches triggers and webhook events for the Automations screen.
 */

import { useState, useEffect, useCallback } from 'react';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { LocalTrigger, LocalTriggerExecution, WebhookEvent } from '../../webhooks/ghl-types.js';
import { LocalTriggerService } from '../../triggers/local-trigger-service.js';

interface UseTriggers {
  triggers: LocalTrigger[];
  webhookEvents: WebhookEvent[];
  refresh: () => void;
  toggleEnabled: (id: string) => Promise<void>;
  deleteTrigger: (id: string) => Promise<void>;
  getExecutions: (triggerId: string) => Promise<LocalTriggerExecution[]>;
}

export function useTriggers(db: DatabaseAdapter | null): UseTriggers {
  const [triggers, setTriggers] = useState<LocalTrigger[]>([]);
  const [webhookEvents, setWebhookEvents] = useState<WebhookEvent[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => {
    setRefreshKey(k => k + 1);
  }, []);

  useEffect(() => {
    if (!db) return;

    const service = new LocalTriggerService(db);

    const fetchData = async () => {
      const triggerList = await service.list();
      setTriggers(triggerList);

      const { data } = await db.from<WebhookEvent>('webhook_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);
      if (data) {
        setWebhookEvents(data);
      }
    };

    fetchData();
    const timer = setInterval(fetchData, 5000);
    return () => clearInterval(timer);
  }, [db, refreshKey]);

  const toggleEnabled = useCallback(async (id: string) => {
    if (!db) return;
    const service = new LocalTriggerService(db);
    const trigger = triggers.find(t => t.id === id);
    if (!trigger) return;
    await service.update(id, { enabled: !trigger.enabled });
    refresh();
  }, [db, triggers, refresh]);

  const deleteTrigger = useCallback(async (id: string) => {
    if (!db) return;
    const service = new LocalTriggerService(db);
    await service.delete(id);
    refresh();
  }, [db, refresh]);

  const getExecutions = useCallback(async (triggerId: string): Promise<LocalTriggerExecution[]> => {
    if (!db) return [];
    const service = new LocalTriggerService(db);
    return service.getExecutions(triggerId);
  }, [db]);

  return { triggers, webhookEvents, refresh, toggleEnabled, deleteTrigger, getExecutions };
}
