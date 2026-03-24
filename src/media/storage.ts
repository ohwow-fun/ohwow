/**
 * Media File Storage
 *
 * Saves generated media files (images, video, audio) to the local
 * filesystem at ~/.ohwow/media/. Follows the pattern from
 * execution/browser/screenshot-storage.ts.
 */

import { writeFile, mkdir, readdir, stat, unlink } from 'fs/promises';
import { join, extname } from 'path';
import { homedir } from 'os';

export type MediaType = 'image' | 'video' | 'audio' | 'presentation';

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
  'application/pdf': '.pdf',
  'text/html': '.html',
};

export interface MediaFileMetadata {
  path: string;
  type: MediaType;
  mimeType: string;
  filename: string;
  createdAt: string;
  sizeBytes: number;
}

function getMediaDir(): string {
  return join(homedir(), '.ohwow', 'media');
}

function subdirForType(type: MediaType): string {
  switch (type) {
    case 'image': return 'images';
    case 'video': return 'videos';
    case 'audio': return 'audio';
    case 'presentation': return 'presentations';
  }
}

function inferMediaType(mimeType: string): MediaType {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'text/html' || mimeType === 'application/pdf') return 'presentation';
  return 'image'; // fallback
}

/**
 * Save base64-encoded media data to disk.
 * Returns the absolute file path and metadata.
 */
export async function saveMediaFile(
  base64Data: string,
  mimeType: string,
  prefix?: string,
): Promise<MediaFileMetadata> {
  const type = inferMediaType(mimeType);
  const dir = join(getMediaDir(), subdirForType(type));
  await mkdir(dir, { recursive: true });

  const ext = MIME_TO_EXT[mimeType] ?? `.${mimeType.split('/')[1] ?? 'bin'}`;
  const slug = prefix ? `${prefix}-` : '';
  const filename = `${slug}${Date.now()}${ext}`;
  const filePath = join(dir, filename);

  const buffer = Buffer.from(base64Data, 'base64');
  await writeFile(filePath, buffer);

  return {
    path: filePath,
    type,
    mimeType,
    filename,
    createdAt: new Date().toISOString(),
    sizeBytes: buffer.length,
  };
}

/**
 * Save media from a URL by downloading it first.
 */
export async function saveMediaFromUrl(
  url: string,
  mimeType: string,
  prefix?: string,
): Promise<MediaFileMetadata> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Couldn't download media from ${url}: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const base64 = buffer.toString('base64');

  // Use content-type from response if available, fallback to provided mimeType
  const contentType = response.headers.get('content-type')?.split(';')[0] ?? mimeType;
  return saveMediaFile(base64, contentType, prefix);
}

/**
 * Save raw buffer data to disk.
 */
export async function saveMediaBuffer(
  buffer: Buffer,
  mimeType: string,
  prefix?: string,
): Promise<MediaFileMetadata> {
  const type = inferMediaType(mimeType);
  const dir = join(getMediaDir(), subdirForType(type));
  await mkdir(dir, { recursive: true });

  const ext = MIME_TO_EXT[mimeType] ?? `.${mimeType.split('/')[1] ?? 'bin'}`;
  const slug = prefix ? `${prefix}-` : '';
  const filename = `${slug}${Date.now()}${ext}`;
  const filePath = join(dir, filename);

  await writeFile(filePath, buffer);

  return {
    path: filePath,
    type,
    mimeType,
    filename,
    createdAt: new Date().toISOString(),
    sizeBytes: buffer.length,
  };
}

/**
 * List saved media files, optionally filtered by type.
 */
export async function listMediaFiles(type?: MediaType): Promise<MediaFileMetadata[]> {
  const baseDir = getMediaDir();
  const subdirs = type ? [subdirForType(type)] : ['images', 'videos', 'audio', 'presentations'];
  const files: MediaFileMetadata[] = [];

  for (const subdir of subdirs) {
    const dir = join(baseDir, subdir);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // Directory doesn't exist yet
    }

    for (const entry of entries) {
      const filePath = join(dir, entry);
      try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) continue;

        const ext = extname(entry).toLowerCase();
        const mimeType = Object.entries(MIME_TO_EXT).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
        const mediaType = inferMediaType(mimeType);

        files.push({
          path: filePath,
          type: mediaType,
          mimeType,
          filename: entry,
          createdAt: fileStat.birthtime.toISOString(),
          sizeBytes: fileStat.size,
        });
      } catch {
        // Skip unreadable files
      }
    }
  }

  // Sort newest first
  files.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return files;
}

/**
 * Delete a media file by path.
 */
export async function deleteMediaFile(filePath: string): Promise<void> {
  // Safety: only delete files under ~/.ohwow/media/
  const mediaDir = getMediaDir();
  if (!filePath.startsWith(mediaDir)) {
    throw new Error('Can only delete files in the media directory');
  }
  await unlink(filePath);
}
