/**
 * LLM-based Reranker for RAG retrieval.
 * Uses the local Ollama model to score passage relevance more precisely
 * after initial hybrid BM25+embedding retrieval.
 */

import { logger } from '../logger.js';

export interface RerankCandidate {
  index: number;       // original position in scored array
  content: string;     // chunk text (truncated for prompt)
  originalScore: number;
}

export interface RerankResult {
  index: number;
  score: number;       // 0.0 - 1.0 normalized relevance
}

const MAX_PASSAGE_LENGTH = 500;

/**
 * Rerank candidates using local Ollama LLM.
 * Sends a single batch prompt asking the model to rate each passage.
 * Returns scores normalized to 0-1. Falls back to original scores on failure.
 */
export async function rerankWithLLM(
  query: string,
  candidates: RerankCandidate[],
  ollamaUrl: string,
  model: string,
): Promise<RerankResult[]> {
  if (candidates.length === 0) {
    return [];
  }

  const fallback: RerankResult[] = candidates.map((c) => ({
    index: c.index,
    score: c.originalScore,
  }));

  try {
    // Build numbered passage list, truncating each to MAX_PASSAGE_LENGTH chars
    const passages = candidates
      .map((c, i) => {
        const truncated = c.content.length > MAX_PASSAGE_LENGTH
          ? c.content.slice(0, MAX_PASSAGE_LENGTH) + '...'
          : c.content;
        return `Passage ${i + 1}: "${truncated}"`;
      })
      .join('\n\n');

    const prompt = `Rate the relevance of each passage to the query. Return ONLY a JSON array of scores from 0 to 10.

Query: "${query}"

${passages}

Scores (JSON array of numbers, one per passage):`;

    const response = await fetch(`${ollamaUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0,
        stream: false,
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, '[Reranker] Non-ok response from Ollama, using original scores');
      return fallback;
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? '';

    // Parse JSON array from response (tolerant of markdown fences and thinking tags)
    const cleaned = content
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/```json?\n?/g, '')
      .replace(/```/g, '')
      .trim();

    const scores: unknown = JSON.parse(cleaned);

    if (!Array.isArray(scores) || scores.length !== candidates.length) {
      logger.warn({ scoreCount: Array.isArray(scores) ? scores.length : 0, candidateCount: candidates.length },
        '[Reranker] Score count mismatch, using original scores');
      return fallback;
    }

    // Validate all entries are numbers
    for (const s of scores) {
      if (typeof s !== 'number' || isNaN(s)) {
        logger.warn('[Reranker] Non-numeric score in response, using original scores');
        return fallback;
      }
    }

    // Normalize 0-10 scores to 0-1
    return candidates.map((c, i) => ({
      index: c.index,
      score: Math.max(0, Math.min(1, (scores[i] as number) / 10)),
    }));
  } catch (err) {
    logger.warn({ err }, '[Reranker] Reranking failed, using original scores');
    return fallback;
  }
}
