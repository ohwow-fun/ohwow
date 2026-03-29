/**
 * Shutdown Registry
 * Bridges the React world (useRuntime) and process signal handlers (render.tsx).
 * useRuntime registers its shutdown function here; render.tsx calls it on SIGINT/SIGTERM.
 */

let shutdownFn: (() => void) | null = null;

export function registerShutdown(fn: () => void): void {
  shutdownFn = fn;
}

export function runShutdown(): void {
  if (shutdownFn) {
    shutdownFn();
    shutdownFn = null;
  }
}
