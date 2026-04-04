import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RagChunk } from '../../../lib/rag/retrieval.js';

// Mock logger
vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock retrieveKnowledgeChunks
const mockRetrieveKnowledgeChunks = vi.fn<() => Promise<RagChunk[]>>();
vi.mock('../../../lib/rag/retrieval.js', () => ({
  retrieveKnowledgeChunks: (...args: unknown[]) => mockRetrieveKnowledgeChunks(...args as []),
}));

// Mock Anthropic SDK
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
    },
  };
});

import { executeResearch, type LocalKnowledgeOptions } from '../research.js';
import type { DatabaseAdapter } from '../../../db/adapter-types.js';

function makeAnthropicResponse(text: string, inputTokens = 100, outputTokens = 50) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

function makeMockDb(): DatabaseAdapter {
  return {} as DatabaseAdapter;
}

describe('executeResearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('works without localKnowledge (backward compat)', async () => {
    // Query generation response
    mockCreate.mockResolvedValueOnce(
      makeAnthropicResponse('["query one", "query two"]'),
    );
    // Web search response
    mockCreate.mockResolvedValueOnce(
      makeAnthropicResponse('Found info at https://example.com about the topic.'),
    );
    // Synthesis response
    mockCreate.mockResolvedValueOnce(
      makeAnthropicResponse('## Summary\nKey findings here.'),
    );

    const result = await executeResearch('What is AI?', 'quick', 'fake-key');

    expect(result.report).toContain('Key findings');
    expect(result.localSourceCount).toBe(0);
    expect(result.queryCount).toBe(2);
    expect(mockRetrieveKnowledgeChunks).not.toHaveBeenCalled();
  });

  it('calls retrieveKnowledgeChunks when localKnowledge is provided', async () => {
    mockRetrieveKnowledgeChunks.mockResolvedValueOnce([
      {
        id: 'chunk-1',
        documentId: 'doc-1',
        documentTitle: 'Internal AI Guide',
        content: 'AI is a field of computer science.',
        score: 0.8,
        tokenCount: 20,
      },
    ]);

    // Query generation response
    mockCreate.mockResolvedValueOnce(
      makeAnthropicResponse('["query one"]'),
    );
    // Web search response
    mockCreate.mockResolvedValueOnce(
      makeAnthropicResponse('Found info at https://example.com about AI.'),
    );
    // Synthesis response
    mockCreate.mockResolvedValueOnce(
      makeAnthropicResponse('## Summary\nCombined findings.'),
    );

    const localKnowledge: LocalKnowledgeOptions = {
      db: makeMockDb(),
      workspaceId: 'ws-1',
      ollamaUrl: 'http://localhost:11434',
      embeddingModel: 'nomic-embed-text',
    };

    const result = await executeResearch('What is AI?', 'quick', 'fake-key', null, localKnowledge);

    expect(mockRetrieveKnowledgeChunks).toHaveBeenCalledOnce();
    expect(mockRetrieveKnowledgeChunks).toHaveBeenCalledWith(
      expect.objectContaining({
        db: localKnowledge.db,
        workspaceId: 'ws-1',
        agentId: '__orchestrator__',
        query: 'What is AI?',
        tokenBudget: 4000,
        maxChunks: 5,
      }),
    );
    expect(result.localSourceCount).toBe(1);
  });

  it('includes local knowledge in the search prompt', async () => {
    mockRetrieveKnowledgeChunks.mockResolvedValueOnce([
      {
        id: 'chunk-1',
        documentId: 'doc-1',
        documentTitle: 'My Notes',
        content: 'Custom context about the topic.',
        score: 0.9,
        tokenCount: 15,
      },
    ]);

    // Query generation response
    mockCreate.mockResolvedValueOnce(
      makeAnthropicResponse('["query one"]'),
    );
    // Web search response — capture the call args
    mockCreate.mockResolvedValueOnce(
      makeAnthropicResponse('Web findings here.'),
    );
    // Synthesis response
    mockCreate.mockResolvedValueOnce(
      makeAnthropicResponse('## Report'),
    );

    const localKnowledge: LocalKnowledgeOptions = {
      db: makeMockDb(),
      workspaceId: 'ws-1',
    };

    await executeResearch('Topic X', 'quick', 'fake-key', null, localKnowledge);

    // The second call is the web search step
    const searchCall = mockCreate.mock.calls[1];
    const searchArgs = searchCall[0];

    // Check system prompt mentions local knowledge
    expect(searchArgs.system).toContain('local knowledge');

    // Check user prompt includes the local document
    const userMessage = searchArgs.messages[0].content;
    expect(userMessage).toContain('[Document: My Notes]');
    expect(userMessage).toContain('Custom context about the topic.');
    expect(userMessage).toContain('Local Knowledge');
  });

  it('sets localSourceCount in the result', async () => {
    mockRetrieveKnowledgeChunks.mockResolvedValueOnce([
      {
        id: 'c1', documentId: 'd1', documentTitle: 'Doc A',
        content: 'Content A', score: 0.7, tokenCount: 10,
      },
      {
        id: 'c2', documentId: 'd2', documentTitle: 'Doc B',
        content: 'Content B', score: 0.6, tokenCount: 10,
      },
      {
        id: 'c3', documentId: 'd3', documentTitle: 'Doc C',
        content: 'Content C', score: 0.5, tokenCount: 10,
      },
    ]);

    mockCreate.mockResolvedValueOnce(makeAnthropicResponse('["q1"]'));
    mockCreate.mockResolvedValueOnce(makeAnthropicResponse('Findings.'));
    mockCreate.mockResolvedValueOnce(makeAnthropicResponse('Report.'));

    const result = await executeResearch('query', 'quick', 'fake-key', null, {
      db: makeMockDb(),
      workspaceId: 'ws-1',
    });

    expect(result.localSourceCount).toBe(3);
  });

  it('continues gracefully when local knowledge retrieval fails', async () => {
    mockRetrieveKnowledgeChunks.mockRejectedValueOnce(new Error('DB connection failed'));

    mockCreate.mockResolvedValueOnce(makeAnthropicResponse('["q1"]'));
    mockCreate.mockResolvedValueOnce(makeAnthropicResponse('Web results at https://example.com'));
    mockCreate.mockResolvedValueOnce(makeAnthropicResponse('Report without local.'));

    const result = await executeResearch('query', 'quick', 'fake-key', null, {
      db: makeMockDb(),
      workspaceId: 'ws-1',
    });

    expect(result.localSourceCount).toBe(0);
    expect(result.report).toContain('Report without local');
  });
});
