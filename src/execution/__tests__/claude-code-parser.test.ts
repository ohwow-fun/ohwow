import { describe, it, expect } from 'vitest';
import { ClaudeCodeStreamParser } from '../adapters/claude-code-parser.js';
import type { ProgressInfo } from '../adapters/claude-code-parser.js';

describe('ClaudeCodeStreamParser', () => {
  describe('parseLine', () => {
    it('parses valid JSON lines', () => {
      const parser = new ClaudeCodeStreamParser();
      const event = parser.parseLine('{"type":"system","session_id":"abc123"}');
      expect(event).toEqual({ type: 'system', session_id: 'abc123' });
    });

    it('returns null for empty lines', () => {
      const parser = new ClaudeCodeStreamParser();
      expect(parser.parseLine('')).toBeNull();
      expect(parser.parseLine('  ')).toBeNull();
      expect(parser.parseLine('\n')).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      const parser = new ClaudeCodeStreamParser();
      expect(parser.parseLine('not json')).toBeNull();
      expect(parser.parseLine('{broken')).toBeNull();
    });
  });

  describe('processEvent', () => {
    it('captures session ID from system event', () => {
      const parser = new ClaudeCodeStreamParser();
      parser.processEvent({ type: 'system', session_id: 'sess-123' });
      const result = parser.getResult();
      expect(result.sessionId).toBe('sess-123');
    });

    it('captures session ID from result event', () => {
      const parser = new ClaudeCodeStreamParser();
      parser.processEvent({
        type: 'result',
        result: {
          session_id: 'sess-456',
          total_cost_usd: 0.05,
          total_input_tokens: 1000,
          total_output_tokens: 500,
          num_turns: 3,
        },
      });
      const result = parser.getResult();
      expect(result.sessionId).toBe('sess-456');
    });

    it('accumulates text from assistant messages', () => {
      const parser = new ClaudeCodeStreamParser();
      parser.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello world' }],
          model: 'claude-sonnet-4-5-20250514',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      });
      const result = parser.getResult();
      expect(result.content).toBe('Hello world');
      expect(result.model).toBe('claude-sonnet-4-5-20250514');
    });

    it('tracks tool usage from assistant messages', () => {
      const parser = new ClaudeCodeStreamParser();
      parser.processEvent({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', id: 'call_1', input: { file_path: '/tmp/foo' } },
            { type: 'tool_use', name: 'Edit', id: 'call_2', input: {} },
          ],
          usage: { input_tokens: 200, output_tokens: 100 },
        },
      });
      const result = parser.getResult();
      expect(result.toolsUsed).toContain('Read');
      expect(result.toolsUsed).toContain('Edit');
    });

    it('deduplicates tool names in result', () => {
      const parser = new ClaudeCodeStreamParser();
      parser.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash' }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      });
      parser.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash' }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      });
      const result = parser.getResult();
      expect(result.toolsUsed).toEqual(['Bash']);
    });

    it('accumulates tokens across multiple messages', () => {
      const parser = new ClaudeCodeStreamParser();
      parser.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'step 1' }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      });
      parser.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'step 2' }],
          usage: { input_tokens: 200, output_tokens: 100 },
        },
      });
      // Before result event, tokens are accumulated
      const intermediate = parser.getResult();
      expect(intermediate.inputTokens).toBe(300);
      expect(intermediate.outputTokens).toBe(150);
    });

    it('uses result event token counts as authoritative', () => {
      const parser = new ClaudeCodeStreamParser();
      parser.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'hello' }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      });
      parser.processEvent({
        type: 'result',
        result: {
          session_id: 'sess-1',
          total_cost_usd: 0.01,
          total_input_tokens: 500,
          total_output_tokens: 250,
          num_turns: 2,
        },
      });
      const result = parser.getResult();
      expect(result.inputTokens).toBe(500);
      expect(result.outputTokens).toBe(250);
    });

    it('calculates cost in cents from USD', () => {
      const parser = new ClaudeCodeStreamParser();
      parser.processEvent({
        type: 'result',
        result: {
          session_id: 'sess-1',
          total_cost_usd: 0.035,
          total_input_tokens: 1000,
          total_output_tokens: 500,
          num_turns: 1,
        },
      });
      const result = parser.getResult();
      expect(result.totalCostUsd).toBe(0.035);
      expect(result.costCents).toBe(4); // ceil(3.5) = 4
    });

    it('tracks is_error in result', () => {
      const parser = new ClaudeCodeStreamParser();
      parser.processEvent({
        type: 'result',
        result: {
          session_id: 'sess-1',
          total_cost_usd: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
          num_turns: 0,
          is_error: true,
        },
      });
      const result = parser.getResult();
      expect(result.errors).toHaveLength(1);
    });
  });

  describe('processLine (combined)', () => {
    it('calls onProgress with token counts', () => {
      const parser = new ClaudeCodeStreamParser();
      const progressCalls: ProgressInfo[] = [];
      const onProgress = (info: ProgressInfo) => progressCalls.push(info);

      parser.processLine(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'thinking...' }],
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        }),
        onProgress,
      );

      expect(progressCalls).toHaveLength(1);
      expect(progressCalls[0].tokensUsed).toBe(150);
      expect(progressCalls[0].text).toBe('thinking...');
    });

    it('calls onProgress with tool names', () => {
      const parser = new ClaudeCodeStreamParser();
      const progressCalls: ProgressInfo[] = [];

      parser.processLine(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'Bash' }],
            usage: { input_tokens: 50, output_tokens: 25 },
          },
        }),
        (info) => progressCalls.push(info),
      );

      expect(progressCalls).toHaveLength(1);
      expect(progressCalls[0].toolName).toBe('Bash');
    });
  });

  describe('full conversation flow', () => {
    it('parses a complete multi-turn conversation', () => {
      const parser = new ClaudeCodeStreamParser();

      // System init
      parser.processLine('{"type":"system","session_id":"sess-full-test"}');

      // First turn: assistant reads a file
      parser.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5-20250514',
          content: [{ type: 'tool_use', name: 'Read', id: 'call_1', input: { file_path: '/tmp/test.ts' } }],
          usage: { input_tokens: 500, output_tokens: 100 },
        },
      }));

      // Tool result (user message)
      parser.processLine(JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call_1' }] },
      }));

      // Second turn: assistant edits and responds
      parser.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5-20250514',
          content: [
            { type: 'tool_use', name: 'Edit', id: 'call_2', input: {} },
            { type: 'text', text: 'I updated the file.' },
          ],
          usage: { input_tokens: 800, output_tokens: 200 },
        },
      }));

      // Result
      parser.processLine(JSON.stringify({
        type: 'result',
        result: {
          session_id: 'sess-full-test',
          total_cost_usd: 0.012,
          total_input_tokens: 1300,
          total_output_tokens: 300,
          num_turns: 2,
        },
      }));

      const result = parser.getResult();
      expect(result.sessionId).toBe('sess-full-test');
      expect(result.content).toBe('I updated the file.');
      expect(result.model).toBe('claude-sonnet-4-5-20250514');
      expect(result.toolsUsed).toEqual(['Read', 'Edit']);
      expect(result.inputTokens).toBe(1300);
      expect(result.outputTokens).toBe(300);
      expect(result.numTurns).toBe(2);
      expect(result.costCents).toBe(2); // ceil(1.2) = 2
      expect(result.errors).toHaveLength(0);
    });
  });
});
