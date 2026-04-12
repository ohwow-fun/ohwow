/**
 * Media Files Router
 *
 * Serves generated media files (audio, images, video, presentations) from
 * ~/.ohwow/media/<subdir>/<filename> over the loopback HTTP server so the
 * dashboard chat can render inline audio players, video tags, and image
 * previews from local runtime tool results.
 *
 * Public (no auth) because the runtime binds to 127.0.0.1 only and the
 * filenames include a timestamp slug that isn't enumerable from outside.
 * Directory traversal is guarded by whitelisting the subdir and filename
 * pattern.
 */

import { Router } from 'express';
import { createReadStream, statSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { homedir } from 'os';
import { logger } from '../../lib/logger.js';

const MEDIA_ROOT = join(homedir(), '.ohwow', 'media');

const ALLOWED_SUBDIRS = new Set(['audio', 'images', 'videos', 'presentations']);

// Simple whitelist: alphanumerics, dash, dot, underscore. No slashes, no `..`.
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

const EXT_TO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
};

export function createMediaRouter(): Router {
  const router = Router();

  router.get('/media/:subdir/:filename', (req, res) => {
    const { subdir, filename } = req.params;

    if (!ALLOWED_SUBDIRS.has(subdir)) {
      res.status(404).json({ error: 'Unknown media subdirectory' });
      return;
    }
    if (!SAFE_FILENAME.test(filename)) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    const filePath = join(MEDIA_ROOT, subdir, filename);

    // Belt-and-braces: make sure the resolved path is still under the media
    // root even after all path normalization.
    if (!filePath.startsWith(MEDIA_ROOT + '/')) {
      res.status(400).json({ error: 'Path escape detected' });
      return;
    }

    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'Media file not found' });
      return;
    }

    let stat;
    try {
      stat = statSync(filePath);
    } catch (err) {
      logger.warn({ err, filePath }, '[media] stat failed');
      res.status(500).json({ error: 'Could not read media file' });
      return;
    }
    if (!stat.isFile()) {
      res.status(404).json({ error: 'Not a file' });
      return;
    }

    const ext = extname(filename).toLowerCase();
    const contentType = EXT_TO_MIME[ext] ?? 'application/octet-stream';

    // HTTP range support so <audio> and <video> elements can seek.
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? Math.min(parseInt(match[2], 10), stat.size - 1) : stat.size - 1;
        if (start >= stat.size || end < start) {
          res.status(416).set('Content-Range', `bytes */${stat.size}`).end();
          return;
        }
        res.status(206).set({
          'Content-Type': contentType,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Cache-Control': 'private, max-age=300',
        });
        createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }

    res.status(200).set({
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=300',
      // Disposition defaults to inline so browsers render the player.
      // Add ?download=1 to force attachment.
      'Content-Disposition': req.query.download
        ? `attachment; filename="${filename}"`
        : `inline; filename="${filename}"`,
    });
    createReadStream(filePath).pipe(res);
  });

  return router;
}
