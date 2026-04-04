import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractEntitiesAndRelations, extractEntitiesHeuristic, saveGraphData, getRelatedChunkIds } from '../knowledge-graph.js';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ============================================================================
// extractEntitiesAndRelations
// ============================================================================

describe('extractEntitiesAndRelations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('parses valid JSON response correctly', async () => {
    const mockResponse = {
      entities: [
        { text: 'Acme Corp', type: 'org' },
        { text: 'Jane Doe', type: 'person' },
      ],
      relations: [
        { subject: 'Jane Doe', predicate: 'works_at', object: 'Acme Corp' },
      ],
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: JSON.stringify(mockResponse) } }],
      }),
    }));

    // Input must contain >= 3 heuristic entities so the LLM path is exercised
    const result = await extractEntitiesAndRelations(
      'Jane Doe works at Acme Corp in New York with John Smith',
      'http://localhost:11434',
      'qwen3:4b',
    );

    expect(result.entities).toEqual(
      expect.arrayContaining([
        { text: 'Acme Corp', type: 'org' },
        { text: 'Jane Doe', type: 'person' },
      ]),
    );
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]).toEqual({ subject: 'Jane Doe', predicate: 'works_at', object: 'Acme Corp' });
  });

  it('handles markdown-fenced JSON', async () => {
    const inner = JSON.stringify({
      entities: [{ text: 'Node.js', type: 'tool' }],
      relations: [],
    });
    const fenced = '```json\n' + inner + '\n```';

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: fenced } }],
      }),
    }));

    // Input must contain >= 3 heuristic entities so the LLM path is exercised
    const result = await extractEntitiesAndRelations(
      'Uses Node.js at Acme Corp with Jane Doe and John Smith in San Francisco',
      'http://localhost:11434',
      'qwen3:4b',
    );

    expect(result.entities).toEqual(
      expect.arrayContaining([{ text: 'Node.js', type: 'tool' }]),
    );
  });

  it('handles thinking tags in response', async () => {
    const inner = JSON.stringify({
      entities: [{ text: 'Berlin', type: 'location' }],
      relations: [],
    });
    const withThinking = '<think>Let me analyze this...</think>\n' + inner;

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: withThinking } }],
      }),
    }));

    // Input must contain >= 3 heuristic entities so the LLM path is exercised
    const result = await extractEntitiesAndRelations(
      'Meeting in Berlin with Acme Corp and Jane Doe plus John Smith',
      'http://localhost:11434',
      'qwen3:4b',
    );

    expect(result.entities).toEqual(
      expect.arrayContaining([{ text: 'Berlin', type: 'location' }]),
    );
  });

  it('returns empty on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));

    // Text with >= 3 heuristic entities so it reaches the fetch path
    const result = await extractEntitiesAndRelations(
      'Acme Corp hired Jane Doe and John Smith in New York',
      'http://localhost:11434',
      'qwen3:4b',
    );

    // Fetch fails, so we get empty (catch returns empty)
    expect(result.entities).toHaveLength(0);
    expect(result.relations).toHaveLength(0);
  });

  it('returns empty on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    const result = await extractEntitiesAndRelations(
      'Acme Corp hired Jane Doe and John Smith in New York',
      'http://localhost:11434',
      'qwen3:4b',
    );

    // Non-ok response returns empty
    expect(result.entities).toHaveLength(0);
    expect(result.relations).toHaveLength(0);
  });

  it('returns empty on malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'not valid json at all' } }],
      }),
    }));

    const result = await extractEntitiesAndRelations(
      'Acme Corp hired Jane Doe and John Smith in New York',
      'http://localhost:11434',
      'qwen3:4b',
    );

    // Malformed JSON returns empty
    expect(result.entities).toHaveLength(0);
    expect(result.relations).toHaveLength(0);
  });

  it('filters out entities with invalid types', async () => {
    const mockResponse = {
      entities: [
        { text: 'Valid', type: 'concept' },
        { text: 'Invalid', type: 'animal' },
        { text: '', type: 'person' },
      ],
      relations: [],
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: JSON.stringify(mockResponse) } }],
      }),
    }));

    // Input must contain >= 3 heuristic entities so the LLM path is exercised
    const result = await extractEntitiesAndRelations(
      'Acme Corp hired Jane Doe and John Smith in New York',
      'http://localhost:11434',
      'qwen3:4b',
    );

    // Only 'Valid' with type 'concept' survives validation; 'animal' is invalid, '' is empty
    expect(result.entities).toEqual(
      expect.arrayContaining([{ text: 'Valid', type: 'concept' }]),
    );
  });
});

// ============================================================================
// extractEntitiesHeuristic
// ============================================================================

describe('extractEntitiesHeuristic', () => {
  it('extracts capitalized multi-word phrases as concepts', () => {
    const result = extractEntitiesHeuristic('We discussed Machine Learning and Natural Language Processing today.');
    const texts = result.map(e => e.text);
    expect(texts).toContain('Machine Learning');
    expect(texts).toContain('Natural Language Processing');
    expect(result.find(e => e.text === 'Machine Learning')?.type).toBe('concept');
  });

  it('extracts CamelCase identifiers as tools', () => {
    const result = extractEntitiesHeuristic('We use TensorFlow and GraphQL in production.');
    const texts = result.map(e => e.text);
    expect(texts).toContain('TensorFlow');
    expect(texts).toContain('GraphQL');
    expect(result.find(e => e.text === 'TensorFlow')?.type).toBe('tool');
  });

  it('deduplicates entities by text (case-insensitive)', () => {
    // "Machine Learning" appears twice but should only be returned once
    const result = extractEntitiesHeuristic('Machine Learning is great. Machine Learning is powerful.');
    const mlEntities = result.filter(e => e.text === 'Machine Learning');
    expect(mlEntities).toHaveLength(1);
  });

  it('returns empty for text with no entities', () => {
    const result = extractEntitiesHeuristic('');
    expect(result).toHaveLength(0);
  });

  it('returns empty for all-lowercase text', () => {
    const result = extractEntitiesHeuristic('this is a simple sentence with no proper nouns or identifiers.');
    expect(result).toHaveLength(0);
  });
});

// ============================================================================
// extractEntitiesAndRelations — heuristic gating
// ============================================================================

describe('extractEntitiesAndRelations heuristic gating', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('skips Ollama when heuristic finds fewer than 3 entities', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    // Text with only 1 capitalized multi-word phrase — below threshold
    const result = await extractEntitiesAndRelations(
      'We talked about Machine Learning yesterday.',
      'http://localhost:11434',
      'qwen3:4b',
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.entities.length).toBeLessThan(3);
    expect(result.relations).toHaveLength(0);
  });
});

// ============================================================================
// saveGraphData
// ============================================================================

describe('saveGraphData', () => {
  function mockDb() {
    const inserted: Array<{ table: string; data: Record<string, unknown> }> = [];
    const db = {
      from: (table: string) => ({
        insert: (data: Record<string, unknown>) => {
          inserted.push({ table, data });
          return Promise.resolve({ data: null, error: null });
        },
      }),
    };
    return { db: db as unknown as import('../../../db/adapter-types.js').DatabaseAdapter, inserted };
  }

  it('creates entities and edges', async () => {
    const { db, inserted } = mockDb();

    await saveGraphData(db, 'ws1', 'chunk1', {
      entities: [
        { text: 'Alice', type: 'person' },
        { text: 'Acme', type: 'org' },
      ],
      relations: [
        { subject: 'Alice', predicate: 'works_at', object: 'Acme' },
      ],
    });

    const entityInserts = inserted.filter(i => i.table === 'knowledge_graph_entities');
    const edgeInserts = inserted.filter(i => i.table === 'knowledge_graph_edges');

    expect(entityInserts).toHaveLength(2);
    expect(edgeInserts).toHaveLength(1);
    expect(entityInserts[0].data.entity_text).toBe('Alice');
    expect(entityInserts[1].data.entity_text).toBe('Acme');
    expect(edgeInserts[0].data.relation).toBe('works_at');
  });

  it('skips edges when entity text not found in extraction', async () => {
    const { db, inserted } = mockDb();

    await saveGraphData(db, 'ws1', 'chunk1', {
      entities: [{ text: 'Alice', type: 'person' }],
      relations: [
        { subject: 'Alice', predicate: 'knows', object: 'Bob' }, // Bob not in entities
      ],
    });

    const edgeInserts = inserted.filter(i => i.table === 'knowledge_graph_edges');
    expect(edgeInserts).toHaveLength(0);
  });

  it('handles duplicate insert errors gracefully', async () => {
    const db = {
      from: () => ({
        insert: () => Promise.reject(new Error('UNIQUE constraint failed')),
      }),
    } as unknown as import('../../../db/adapter-types.js').DatabaseAdapter;

    // Should not throw
    await saveGraphData(db, 'ws1', 'chunk1', {
      entities: [{ text: 'Alice', type: 'person' }],
      relations: [],
    });
  });
});

// ============================================================================
// getRelatedChunkIds
// ============================================================================

describe('getRelatedChunkIds', () => {
  it('traverses 1 hop correctly', async () => {
    // Set up: chunk1 has entity E1, E1 is connected to E2 via an edge,
    // E2 belongs to chunk2. We expect chunk2 to be returned.

    const db = {
      from: (table: string) => {
        const builder = {
          select: () => builder,
          eq: () => builder,
          in: (_col: string, values: string[]) => {
            if (table === 'knowledge_graph_entities' && values.includes('chunk1')) {
              return {
                ...builder,
                then: (resolve: (v: unknown) => void) => resolve({
                  data: [{ id: 'E1', entity_text: 'Alice', chunk_id: 'chunk1' }],
                  error: null,
                }),
              };
            }
            if (table === 'knowledge_graph_edges') {
              // Outgoing edges from E1
              if (values.includes('E1')) {
                return {
                  ...builder,
                  then: (resolve: (v: unknown) => void) => resolve({
                    data: [{ target_entity_id: 'E2', source_chunk_id: 'chunk_edge' }],
                    error: null,
                  }),
                };
              }
            }
            if (table === 'knowledge_graph_entities' && values.includes('E2')) {
              return {
                ...builder,
                then: (resolve: (v: unknown) => void) => resolve({
                  data: [{ chunk_id: 'chunk2' }],
                  error: null,
                }),
              };
            }
            return {
              ...builder,
              then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
            };
          },
          then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
        };
        return builder;
      },
    } as unknown as import('../../../db/adapter-types.js').DatabaseAdapter;

    const related = await getRelatedChunkIds(db, 'ws1', ['chunk1'], 1);

    expect(related).toContain('chunk2');
    expect(related).toContain('chunk_edge');
    expect(related).not.toContain('chunk1');
  });

  it('returns empty for no input chunks', async () => {
    const db = {} as unknown as import('../../../db/adapter-types.js').DatabaseAdapter;
    const result = await getRelatedChunkIds(db, 'ws1', []);
    expect(result).toEqual([]);
  });

  it('returns empty when no entities found', async () => {
    const db = {
      from: () => ({
        select: function () { return this; },
        eq: function () { return this; },
        in: function () { return this; },
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      }),
    } as unknown as import('../../../db/adapter-types.js').DatabaseAdapter;

    const result = await getRelatedChunkIds(db, 'ws1', ['chunk1']);
    expect(result).toEqual([]);
  });
});
