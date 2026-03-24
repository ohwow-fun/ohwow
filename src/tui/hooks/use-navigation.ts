/**
 * useNavigation Hook
 * Tab switching, detail drill-in, and back stack.
 */

import { useState, useCallback } from 'react';
import { Screen } from '../types.js';

interface NavigationState {
  screen: Screen;
  detailId: string | null;
  isDetail: boolean;
  goToTab: (screen: Screen) => void;
  goTo: (screen: Screen, id?: string) => void;
  goBack: () => void;
}

export function useNavigation(): NavigationState {
  const [screen, setScreen] = useState<Screen>(Screen.Chat);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [, setBackStack] = useState<Screen[]>([]);

  const isDetail = [Screen.AgentDetail, Screen.TaskDetail, Screen.TaskDispatch, Screen.AgentCreate, Screen.A2AConnections, Screen.A2ASetup, Screen.AutomationDetail, Screen.AutomationCreate, Screen.WhatsApp, Screen.WhatsAppSetup, Screen.Notifications, Screen.LocalModelSetup, Screen.TunnelSetup, Screen.LicenseKeySetup, Screen.GhlWebhook, Screen.ContactDetail, Screen.Schedules, Screen.Workflows, Screen.ModelManager, Screen.McpServers, Screen.McpServerSetup].includes(screen);

  const goToTab = useCallback((target: Screen) => {
    setScreen(target);
    setDetailId(null);
    setBackStack([]);
  }, []);

  const goTo = useCallback((target: Screen, id?: string) => {
    setBackStack(prev => [...prev, screen]);
    setScreen(target);
    setDetailId(id ?? null);
  }, [screen]);

  const goBack = useCallback(() => {
    setBackStack(prev => {
      const next = [...prev];
      const last = next.pop();
      if (last) {
        setScreen(last);
        setDetailId(null);
      } else {
        // Empty back stack → return to chat home
        setScreen(Screen.Chat);
        setDetailId(null);
      }
      return next;
    });
  }, []);

  return {
    screen,
    detailId,
    isDetail,
    goToTab,
    goTo,
    goBack,
  };
}
