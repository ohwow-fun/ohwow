/**
 * In-daemon embedder module.
 *
 * Self-contained local inference primitive for semantic search. Not yet wired
 * into any existing code path — import `createEmbedder` to use it directly.
 */

export { createEmbedder } from './model.js';
export type {
  Embedder,
  EmbedderConfig,
  EmbedOptions,
} from './model.js';
export {
  getSharedEmbedder,
  warmSharedEmbedder,
  resetSharedEmbedderForTests,
} from './singleton.js';
