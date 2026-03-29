#!/usr/bin/env node
try {
  await import('../dist/index.js');
} catch (err) {
  console.error('ohwow failed to start:', err.message || err);
  process.exit(1);
}
