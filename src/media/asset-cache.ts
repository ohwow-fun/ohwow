/**
 * Content-addressed asset cache for deterministic media generation.
 *
 * Layout: ~/.ohwow/media/cache/<modality>/<sha256>.<ext>
 *                                        + <sha256>.json (sidecar with key inputs)
 *
 * Same inputs → same hash → same file on disk. Lets the video pipeline
 * skip redundant TTS/music API calls on re-render and lets agents dedupe
 * outputs across runs.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, rename, stat, writeFile, readFile, readdir, unlink } from 'node:fs/promises';

export type CacheModality = 'voice' | 'music' | 'image' | 'video';

export interface CacheKeyInputs {
  [k: string]: unknown;
}

export interface CacheEntry {
  path: string;
  hash: string;
  cached: boolean;
}

export interface CacheGenerator {
  /** Produces the binary payload. Only called on cache miss. */
  produce: () => Promise<{ buffer: Buffer; extension: string }>;
}

function cacheRoot(): string {
  return process.env.OHWOW_MEDIA_CACHE_DIR
    ?? join(homedir(), '.ohwow', 'media', 'cache');
}

/**
 * Stable stringification: object keys sorted deterministically at every level.
 * Matches the content-hash behavior most build tools use.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    k => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k]),
  );
  return '{' + entries.join(',') + '}';
}

export function hashInputs(modality: CacheModality, inputs: CacheKeyInputs): string {
  const payload = stableStringify({ modality, inputs });
  return createHash('sha256').update(payload).digest('hex');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(path: string, buffer: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  await writeFile(tmp, buffer);
  await rename(tmp, path);
}

/**
 * Get a cache entry, producing it if missing.
 * On hit: returns the existing path without invoking the generator.
 * On miss: calls the generator, writes binary + sidecar atomically.
 */
export async function getOrCreate(
  modality: CacheModality,
  inputs: CacheKeyInputs,
  gen: CacheGenerator,
): Promise<CacheEntry> {
  const hash = hashInputs(modality, inputs);
  const modalityDir = join(cacheRoot(), modality);
  const sidecarPath = join(modalityDir, `${hash}.json`);

  const sidecarExists = await fileExists(sidecarPath);
  if (sidecarExists) {
    try {
      const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as { path?: string; extension?: string };
      const path = sidecar.path;
      if (path && await fileExists(path)) {
        return { path, hash, cached: true };
      }
    } catch {
      // corrupt sidecar: fall through and regenerate
    }
  }

  const { buffer, extension } = await gen.produce();
  const ext = extension.startsWith('.') ? extension : '.' + extension;
  const path = join(modalityDir, `${hash}${ext}`);
  await atomicWrite(path, buffer);

  const sidecar = {
    modality,
    hash,
    path,
    extension: ext,
    sizeBytes: buffer.byteLength,
    createdAt: new Date().toISOString(),
    inputs,
  };
  await atomicWrite(sidecarPath, Buffer.from(JSON.stringify(sidecar, null, 2)));

  return { path, hash, cached: false };
}

export interface CacheLsEntry {
  modality: CacheModality;
  hash: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
  inputs: CacheKeyInputs;
}

export async function list(modality?: CacheModality): Promise<CacheLsEntry[]> {
  const root = cacheRoot();
  const modalities: CacheModality[] = modality
    ? [modality]
    : (['voice', 'music', 'image', 'video'] as CacheModality[]);
  const out: CacheLsEntry[] = [];
  for (const m of modalities) {
    const dir = join(root, m);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(dir, name), 'utf8');
        const sidecar = JSON.parse(raw) as Partial<CacheLsEntry> & { inputs?: CacheKeyInputs };
        if (!sidecar.hash || !sidecar.path) continue;
        out.push({
          modality: m,
          hash: sidecar.hash,
          path: sidecar.path,
          sizeBytes: sidecar.sizeBytes ?? 0,
          createdAt: sidecar.createdAt ?? '',
          inputs: sidecar.inputs ?? {},
        });
      } catch {
        // skip unreadable sidecars
      }
    }
  }
  return out;
}

export async function prune(olderThanMs: number): Promise<number> {
  const now = Date.now();
  const entries = await list();
  let removed = 0;
  for (const entry of entries) {
    const created = entry.createdAt ? new Date(entry.createdAt).getTime() : 0;
    if (now - created < olderThanMs) continue;
    const sidecarPath = join(cacheRoot(), entry.modality, `${entry.hash}.json`);
    try {
      await unlink(entry.path);
      await unlink(sidecarPath);
      removed++;
    } catch {
      // ignore
    }
  }
  return removed;
}

/**
 * URI helpers for cache:// references embedded in VideoSpec AudioRef.src.
 */
export function cacheUri(hash: string): string {
  return `cache://${hash}`;
}

export function isCacheUri(src: string): boolean {
  return src.startsWith('cache://');
}

export function parseCacheUri(src: string): string | null {
  if (!isCacheUri(src)) return null;
  return src.slice('cache://'.length);
}

/**
 * Resolve a cache:// URI to an absolute path on disk, or null if missing.
 * Scans all modalities since the URI doesn't encode one.
 */
export async function resolveCacheUri(src: string): Promise<string | null> {
  const hash = parseCacheUri(src);
  if (!hash) return null;
  const all = await list();
  const hit = all.find(e => e.hash === hash);
  return hit?.path ?? null;
}
