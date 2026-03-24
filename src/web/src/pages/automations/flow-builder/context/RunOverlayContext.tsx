import { createContext, useContext } from 'react';
import type { AutomationRun, AutomationStepResult } from '../../types';

interface RunOverlayContextValue {
  overlayRun: AutomationRun | null;
  getStepResult: (stepId: string) => AutomationStepResult | undefined;
}

const RunOverlayContext = createContext<RunOverlayContextValue>({
  overlayRun: null,
  getStepResult: () => undefined,
});

export const RunOverlayProvider = RunOverlayContext.Provider;

export function useRunOverlay() {
  return useContext(RunOverlayContext);
}
