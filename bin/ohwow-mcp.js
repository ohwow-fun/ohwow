#!/usr/bin/env node
try {
  const { startMcpServer } = await import('../dist/mcp-server/index.js');
  await startMcpServer();
} catch (err) {
  process.stderr.write(`ohwow-mcp failed to start: ${err.message || err}\n`);
  process.exit(1);
}
