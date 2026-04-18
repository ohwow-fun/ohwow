/**
 * In-daemon embedder: local semantic-search inference primitive.
 *
 * Wraps @huggingface/transformers (TransformersJS) to embed text via an ONNX
 * model that runs entirely in Node. No Python dependency, no network calls
 * after the first cold load (which auto-downloads weights to the HF cache).
 *
 * Default model: onnx-community/Qwen3-Embedding-0.6B-ONNX (1024-dim, q8).
 * Mirrors the last-token pooling + L2-normalize semantics used by the Modal
 * reference implementation at experiments/embeddings/modal_embeddings.py.
 *
 * Not yet wired into any code path. Import via `createEmbedder`.
 */

import {
  AutoTokenizer,
  AutoModel,
  type PreTrainedTokenizer,
  type PreTrainedModel,
  type Tensor,
} from '@huggingface/transformers';
import { logger } from '../lib/logger.js';

const DEFAULT_MODEL_ID = 'onnx-community/Qwen3-Embedding-0.6B-ONNX';
const DEFAULT_DTYPE: 'fp32' | 'fp16' | 'q8' = 'q8';
const DEFAULT_MAX_LEN = 512;

export interface EmbedOptions {
  /** Treat inputs as retrieval queries (enables asymmetric-model behavior). */
  isQuery?: boolean;
  /** Qwen3-style task instruction for queries. Ignored when isQuery is false. */
  instruction?: string | null;
}

export interface Embedder {
  /** Resolves when weights are loaded. First call triggers the download. */
  ready(): Promise<void>;
  /** Returns one Float32Array per input text, each of length `dim`. */
  embed(texts: string[], opts?: EmbedOptions): Promise<Float32Array[]>;
  readonly modelId: string;
  readonly dim: number;
}

export interface EmbedderConfig {
  /** HF repo id. Defaults to onnx-community/Qwen3-Embedding-0.6B-ONNX. */
  modelId?: string;
  /** Override the on-disk HF cache. Defaults to ~/.cache/huggingface. */
  cacheDir?: string;
  /** ONNX dtype. Qwen3-Embedding-0.6B-ONNX supports fp32, fp16, q8. */
  dtype?: 'fp32' | 'fp16' | 'q8';
  /** Max sequence length (truncation). Defaults to 512. */
  maxLength?: number;
}

class QwenLikeEmbedder implements Embedder {
  readonly modelId: string;
  dim = 0;

  private readonly cacheDir: string | undefined;
  private readonly dtype: 'fp32' | 'fp16' | 'q8';
  private readonly maxLength: number;

  private tokenizer: PreTrainedTokenizer | null = null;
  private model: PreTrainedModel | null = null;
  private loadPromise: Promise<void> | null = null;

  constructor(config: EmbedderConfig) {
    this.modelId = config.modelId ?? DEFAULT_MODEL_ID;
    this.cacheDir = config.cacheDir;
    this.dtype = config.dtype ?? DEFAULT_DTYPE;
    this.maxLength = config.maxLength ?? DEFAULT_MAX_LEN;
  }

  ready(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.load();
    }
    return this.loadPromise;
  }

  private async load(): Promise<void> {
    const startedAt = Date.now();
    const tokenizerOpts: Record<string, unknown> = {};
    const modelOpts: Record<string, unknown> = { dtype: this.dtype };
    if (this.cacheDir) {
      tokenizerOpts.cache_dir = this.cacheDir;
      modelOpts.cache_dir = this.cacheDir;
    }

    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(this.modelId, tokenizerOpts),
      AutoModel.from_pretrained(this.modelId, modelOpts),
    ]);

    // Qwen3-Embedding uses last-token pooling with LEFT padding.
    // Force left padding on the tokenizer regardless of repo defaults.
    (tokenizer as unknown as { padding_side: string }).padding_side = 'left';

    this.tokenizer = tokenizer;
    this.model = model;

    // Probe the output dimension with a trivial forward pass so callers don't
    // have to run one first just to learn the vector shape.
    const probe = await this.embed(['probe']);
    this.dim = probe[0]?.length ?? 0;

    logger.info(
      {
        modelId: this.modelId,
        dtype: this.dtype,
        dim: this.dim,
        loadSeconds: ((Date.now() - startedAt) / 1000).toFixed(2),
      },
      'embedder loaded',
    );
  }

  async embed(texts: string[], opts: EmbedOptions = {}): Promise<Float32Array[]> {
    if (!this.tokenizer || !this.model) {
      await this.ready();
    }
    if (!this.tokenizer || !this.model) {
      throw new Error('embedder not initialized');
    }
    if (texts.length === 0) return [];

    const prepared =
      opts.isQuery && opts.instruction
        ? texts.map((t) => `Instruct: ${opts.instruction}\nQuery: ${t}`)
        : texts.slice();

    const tokenized = this.tokenizer(prepared, {
      padding: true,
      truncation: true,
      max_length: this.maxLength,
    }) as unknown as { input_ids: Tensor; attention_mask: Tensor };

    const output = (await this.model(tokenized)) as { last_hidden_state: Tensor };
    const hidden = output.last_hidden_state;

    return poolLastTokenAndNormalize(hidden, tokenized.attention_mask);
  }
}

/**
 * Last-token pooling with left padding + L2 normalize.
 * For each row, the embedding vector is the hidden state at the position of
 * the last attended token (i.e. the last `1` in the attention mask).
 */
function poolLastTokenAndNormalize(
  hidden: Tensor,
  attentionMask: Tensor,
): Float32Array[] {
  const dims = hidden.dims as number[];
  if (dims.length !== 3) {
    throw new Error(`unexpected last_hidden_state dims: ${JSON.stringify(dims)}`);
  }
  const [batch, seqLen, hiddenDim] = dims;
  const hiddenData = hidden.data as Float32Array;
  const maskDims = attentionMask.dims as number[];
  const maskData = attentionMask.data as BigInt64Array | Int32Array | Float32Array;
  if (maskDims.length !== 2 || maskDims[0] !== batch || maskDims[1] !== seqLen) {
    throw new Error(
      `mask/hidden shape mismatch: hidden=${JSON.stringify(dims)} mask=${JSON.stringify(maskDims)}`,
    );
  }

  const out: Float32Array[] = new Array(batch);
  for (let row = 0; row < batch; row += 1) {
    // Find last attended token position.
    let lastPos = -1;
    for (let col = seqLen - 1; col >= 0; col -= 1) {
      const v = maskData[row * seqLen + col];
      const num = typeof v === 'bigint' ? Number(v) : v;
      if (num > 0) {
        lastPos = col;
        break;
      }
    }
    if (lastPos < 0) lastPos = seqLen - 1;

    const vec = new Float32Array(hiddenDim);
    const base = (row * seqLen + lastPos) * hiddenDim;
    for (let d = 0; d < hiddenDim; d += 1) {
      vec[d] = hiddenData[base + d];
    }

    // L2 normalize in place.
    let sumSq = 0;
    for (let d = 0; d < hiddenDim; d += 1) {
      sumSq += vec[d] * vec[d];
    }
    const norm = Math.sqrt(sumSq) || 1;
    for (let d = 0; d < hiddenDim; d += 1) {
      vec[d] /= norm;
    }

    out[row] = vec;
  }
  return out;
}

/**
 * Factory: returns an Embedder without loading weights. Call `ready()` to
 * trigger the cold-load (auto-downloads from HF on first use).
 */
export function createEmbedder(config: EmbedderConfig = {}): Embedder {
  return new QwenLikeEmbedder(config);
}
