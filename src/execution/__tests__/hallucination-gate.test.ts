import { describe, it, expect } from 'vitest';
import {
  assertTaskWasGrounded,
  looksLikeToolWork,
  HallucinationDetectedError,
} from '../hallucination-gate.js';
import type { ReActStep } from '../task-completion.js';

const shortInput = 'what is 2+2?';
const workInput =
  'Run these 5 sqlite3 queries against runtime.db and write the results to a markdown file at ~/.ohwow/diary.md. Query 1: SELECT purpose, provider, model, COUNT(*) FROM llm_calls WHERE created_at > datetime("now","-24 hours") GROUP BY purpose. Query 2: SELECT status, COUNT(*) FROM agent_workforce_tasks GROUP BY status. Then compose a diary with tables and save the file. Use run_bash and local_write_file tools to execute and persist results. Do not hallucinate numbers.';

const emptyTrace: ReActStep[] = [];

const traceWithOneToolCall: ReActStep[] = [
  {
    iteration: 1,
    thought: 'I should run the query',
    actions: [{ tool: 'run_bash', inputSummary: 'sqlite3 ...' }],
    observations: [{ tool: 'run_bash', resultSummary: '42 rows', success: true }],
    durationMs: 1200,
    timestamp: new Date().toISOString(),
  },
];

describe('looksLikeToolWork', () => {
  it('returns false for short inputs regardless of keywords', () => {
    expect(looksLikeToolWork('run sqlite query')).toBe(false);
    expect(looksLikeToolWork('')).toBe(false);
    expect(looksLikeToolWork(shortInput)).toBe(false);
  });

  it('returns false for long inputs without action verbs', () => {
    const pureReasoning = 'Please philosophize about the nature of beauty and truth in the abstract. '.repeat(10);
    expect(pureReasoning.length).toBeGreaterThan(400);
    expect(looksLikeToolWork(pureReasoning)).toBe(false);
  });

  it('returns true for long work-shaped inputs', () => {
    expect(looksLikeToolWork(workInput)).toBe(true);
  });
});

describe('assertTaskWasGrounded', () => {
  it('throws when trace is empty and input looks like work', () => {
    expect(() =>
      assertTaskWasGrounded({
        reactTrace: emptyTrace,
        taskInput: workInput,
        agentConfig: {},
      }),
    ).toThrow(HallucinationDetectedError);
  });

  it('error message mentions 0 tool calls and input length', () => {
    try {
      assertTaskWasGrounded({
        reactTrace: emptyTrace,
        taskInput: workInput,
        agentConfig: {},
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HallucinationDetectedError);
      const msg = (err as Error).message;
      expect(msg).toContain('0 tool calls');
      expect(msg).toContain(String(workInput.length));
    }
  });

  it('does not throw on short chat-style input', () => {
    expect(() =>
      assertTaskWasGrounded({
        reactTrace: emptyTrace,
        taskInput: shortInput,
        agentConfig: {},
      }),
    ).not.toThrow();
  });

  it('does not throw when agent opts out via allow_text_only_tasks', () => {
    expect(() =>
      assertTaskWasGrounded({
        reactTrace: emptyTrace,
        taskInput: workInput,
        agentConfig: { allow_text_only_tasks: true },
      }),
    ).not.toThrow();
  });

  it('does not throw when the trace has at least one tool call', () => {
    expect(() =>
      assertTaskWasGrounded({
        reactTrace: traceWithOneToolCall,
        taskInput: workInput,
        agentConfig: {},
      }),
    ).not.toThrow();
  });

  it('does not throw on long reasoning prompts with no action verbs', () => {
    const pureReasoning = 'Please philosophize about the nature of beauty and truth in the abstract. '.repeat(10);
    expect(() =>
      assertTaskWasGrounded({
        reactTrace: emptyTrace,
        taskInput: pureReasoning,
        agentConfig: {},
      }),
    ).not.toThrow();
  });
});
