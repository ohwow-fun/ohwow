/**
 * Sampling Bridge
 * A tiny HTTP server inside the MCP process that lets the daemon
 * request LLM completions via MCP sampling (sampling/createMessage).
 *
 * Flow: Daemon HTTP POST → this bridge → server.createMessage() → Claude Code → response back
 */

import { createServer, type Server } from 'http';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const PORT_FILE = join(homedir(), '.ohwow', 'data', 'mcp-sampling.port');

export interface SamplingRequest {
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface SamplingResponse {
  content: string;
  model: string;
  stopReason?: string;
}

/**
 * Start the sampling bridge HTTP server.
 * Returns a cleanup function to stop the server and remove the port file.
 */
export function startSamplingBridge(mcpServer: McpServer): { cleanup: () => void } {
  let httpServer: Server | null = null;

  const server = createServer(async (req, res) => {
    // Only accept POST /sampling
    if (req.method !== 'POST' || req.url !== '/sampling') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    // Read request body
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    let request: SamplingRequest;
    try {
      request = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!request.messages?.length) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'messages array is required' }));
      return;
    }

    try {
      // Convert to MCP sampling format
      const samplingMessages = request.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: { type: 'text' as const, text: m.content },
      }));

      // Call Claude Code via MCP sampling
      const result = await mcpServer.server.createMessage({
        messages: samplingMessages,
        systemPrompt: request.systemPrompt,
        maxTokens: request.maxTokens || 4096,
        temperature: request.temperature,
      });

      // Extract text content from response
      const content = Array.isArray(result.content)
        ? result.content
            .filter((c: { type: string }) => c.type === 'text')
            .map((c: { type: string; text?: string }) => (c as { text: string }).text)
            .join('')
        : typeof result.content === 'object' && 'text' in result.content
          ? (result.content as { text: string }).text
          : String(result.content);

      const response: SamplingResponse = {
        content,
        model: result.model,
        stopReason: result.stopReason ?? undefined,
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sampling failed';
      res.writeHead(500);
      res.end(JSON.stringify({ error: message }));
    }
  });

  // Listen on a random available port
  httpServer = server;
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    if (addr && typeof addr === 'object') {
      const port = addr.port;
      try {
        writeFileSync(PORT_FILE, String(port));
        process.stderr.write(`[ohwow-mcp] Sampling bridge listening on port ${port}\n`);
      } catch {
        process.stderr.write('[ohwow-mcp] Could not write sampling port file\n');
      }
    }
  });

  const cleanup = () => {
    if (httpServer) {
      httpServer.close();
      httpServer = null;
    }
    try {
      if (existsSync(PORT_FILE)) {
        unlinkSync(PORT_FILE);
      }
    } catch {
      // Best-effort cleanup
    }
  };

  return { cleanup };
}
