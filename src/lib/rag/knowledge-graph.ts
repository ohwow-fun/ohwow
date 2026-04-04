/**
 * Knowledge Graph — Entity and relationship extraction from document chunks.
 *
 * Extracts entities (people, orgs, concepts, tools, locations, events)
 * and relationships from chunked text using a local LLM. The graph
 * is used at query time to boost retrieval of related chunks.
 */

import { createHash } from 'node:crypto';
import { logger } from '../logger.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

// ============================================================================
// TYPES
// ============================================================================

export interface ExtractedEntity {
  text: string;
  type: 'person' | 'org' | 'concept' | 'tool' | 'location' | 'event';
}

export interface ExtractedRelation {
  subject: string;
  predicate: string;
  object: string;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

const VALID_ENTITY_TYPES = new Set(['person', 'org', 'concept', 'tool', 'location', 'event']);

// ============================================================================
// EXTRACTION
// ============================================================================

/**
 * Extract entities and relationships from a chunk of text using a local LLM.
 * Returns empty results on any failure (best-effort).
 */
export async function extractEntitiesAndRelations(
  chunkContent: string,
  ollamaUrl: string,
  model: string,
): Promise<ExtractionResult> {
  const empty: ExtractionResult = { entities: [], relations: [] };

  try {
    const truncated = chunkContent.slice(0, 2000);

    const response = await fetch(`${ollamaUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: `Extract entities and relationships from this text. Return ONLY valid JSON.\nFormat: { "entities": [{"text": "...", "type": "person|org|concept|tool|location|event"}], "relations": [{"subject": "...", "predicate": "...", "object": "..."}] }\n\nText: "${truncated}"`,
          },
        ],
        max_tokens: 500,
        temperature: 0,
        stream: false,
      }),
    });

    if (!response.ok) return empty;

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? '';

    // Clean markdown fences and thinking tags (same pattern as expandQuery)
    const cleaned = content
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/```json?\n?/g, '')
      .replace(/```/g, '')
      .trim();

    const parsed = JSON.parse(cleaned) as ExtractionResult;

    // Validate structure
    const entities: ExtractedEntity[] = [];
    if (Array.isArray(parsed.entities)) {
      for (const e of parsed.entities) {
        if (
          typeof e.text === 'string' && e.text.length > 0 &&
          typeof e.type === 'string' && VALID_ENTITY_TYPES.has(e.type)
        ) {
          entities.push({ text: e.text, type: e.type as ExtractedEntity['type'] });
        }
      }
    }

    const relations: ExtractedRelation[] = [];
    if (Array.isArray(parsed.relations)) {
      for (const r of parsed.relations) {
        if (
          typeof r.subject === 'string' && r.subject.length > 0 &&
          typeof r.predicate === 'string' && r.predicate.length > 0 &&
          typeof r.object === 'string' && r.object.length > 0
        ) {
          relations.push({ subject: r.subject, predicate: r.predicate, object: r.object });
        }
      }
    }

    return { entities, relations };
  } catch {
    return empty;
  }
}

// ============================================================================
// PERSISTENCE
// ============================================================================

function makeEntityId(workspaceId: string, entityText: string, entityType: string): string {
  return createHash('sha256').update(`${workspaceId}${entityText}${entityType}`).digest('hex').slice(0, 32);
}

function makeEdgeId(sourceId: string, relation: string, targetId: string, chunkId: string): string {
  return createHash('sha256').update(`${sourceId}${relation}${targetId}${chunkId}`).digest('hex').slice(0, 32);
}

/**
 * Save extracted entities and edges to the knowledge graph tables.
 * Deduplicates by ID (upsert/ignore on conflict).
 */
export async function saveGraphData(
  db: DatabaseAdapter,
  workspaceId: string,
  chunkId: string,
  extraction: ExtractionResult,
): Promise<void> {
  // Build a map of entity text → entity ID for edge lookups
  const entityIdMap = new Map<string, string>();

  // Save entities
  for (const entity of extraction.entities) {
    const id = makeEntityId(workspaceId, entity.text, entity.type);
    entityIdMap.set(entity.text, id);

    try {
      await db
        .from('knowledge_graph_entities')
        .insert({
          id,
          workspace_id: workspaceId,
          chunk_id: chunkId,
          entity_text: entity.text,
          entity_type: entity.type,
          confidence: 1.0,
        });
    } catch {
      // Duplicate — skip
    }
  }

  // Save edges
  for (const relation of extraction.relations) {
    const sourceId = entityIdMap.get(relation.subject);
    const targetId = entityIdMap.get(relation.object);

    // Both entities must exist in this extraction
    if (!sourceId || !targetId) continue;

    const edgeId = makeEdgeId(sourceId, relation.predicate, targetId, chunkId);

    try {
      await db
        .from('knowledge_graph_edges')
        .insert({
          id: edgeId,
          workspace_id: workspaceId,
          source_entity_id: sourceId,
          target_entity_id: targetId,
          relation: relation.predicate,
          source_chunk_id: chunkId,
          confidence: 1.0,
        });
    } catch {
      // Duplicate — skip
    }
  }
}

// ============================================================================
// GRAPH TRAVERSAL
// ============================================================================

/**
 * Find chunk IDs related to the given chunks via knowledge graph edges.
 * Traverses up to `maxHops` hops (default 1) from entities in the input chunks.
 * Returns discovered chunk IDs, excluding the input set.
 */
export async function getRelatedChunkIds(
  db: DatabaseAdapter,
  workspaceId: string,
  chunkIds: string[],
  maxHops: number = 1,
): Promise<string[]> {
  if (chunkIds.length === 0) return [];

  const inputSet = new Set(chunkIds);
  const discoveredChunkIds = new Set<string>();

  // Step 1: Get entities in the input chunks
  const { data: entities } = await db
    .from<{ id: string; entity_text: string }>('knowledge_graph_entities')
    .select('id, entity_text')
    .eq('workspace_id', workspaceId)
    .in('chunk_id', chunkIds);

  if (!entities || entities.length === 0) return [];

  let currentEntityIds = entities.map(e => e.id);

  for (let hop = 0; hop < maxHops; hop++) {
    if (currentEntityIds.length === 0) break;

    // Step 2: Find edges connected to these entities (both directions)
    const { data: outEdges } = await db
      .from<{ target_entity_id: string; source_chunk_id: string }>('knowledge_graph_edges')
      .select('target_entity_id, source_chunk_id')
      .eq('workspace_id', workspaceId)
      .in('source_entity_id', currentEntityIds);

    const { data: inEdges } = await db
      .from<{ source_entity_id: string; source_chunk_id: string }>('knowledge_graph_edges')
      .select('source_entity_id, source_chunk_id')
      .eq('workspace_id', workspaceId)
      .in('target_entity_id', currentEntityIds);

    const nextEntityIds = new Set<string>();
    const allEdges = [...(outEdges ?? []), ...(inEdges ?? [])];

    for (const edge of allEdges) {
      // Collect chunk IDs from edges
      if (!inputSet.has(edge.source_chunk_id)) {
        discoveredChunkIds.add(edge.source_chunk_id);
      }
      // Collect connected entity IDs for the next hop
      const connectedId = 'target_entity_id' in edge
        ? (edge as { target_entity_id: string }).target_entity_id
        : (edge as { source_entity_id: string }).source_entity_id;
      nextEntityIds.add(connectedId);
    }

    // Step 3: Look up chunks for connected entities
    const connectedEntityIds = [...nextEntityIds];
    if (connectedEntityIds.length > 0) {
      const { data: connectedEntities } = await db
        .from<{ chunk_id: string }>('knowledge_graph_entities')
        .select('chunk_id')
        .eq('workspace_id', workspaceId)
        .in('id', connectedEntityIds);

      for (const ce of connectedEntities ?? []) {
        if (!inputSet.has(ce.chunk_id)) {
          discoveredChunkIds.add(ce.chunk_id);
        }
      }
    }

    currentEntityIds = [...nextEntityIds];
  }

  return [...discoveredChunkIds];
}
