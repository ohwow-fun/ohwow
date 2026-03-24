/**
 * TUI Entry Point
 * Renders the ink React app to the terminal.
 */

import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { runShutdown } from './hooks/shutdown-registry.js';

export function startTui(): void {
  let instance;
  try {
    instance = render(<App />);
  } catch (err) {
    console.error('[ohwow] TUI failed to render:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const { unmount, waitUntilExit } = instance;

  // Handle process signals
  const cleanup = () => {
    runShutdown();
    unmount();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  waitUntilExit().then(() => {
    process.exit(0);
  });
}
