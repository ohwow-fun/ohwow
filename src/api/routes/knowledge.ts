/**
 * Knowledge Routes
 *
 * Thin HTTP layer over agent_workforce_knowledge_documents so the web UI
 * can browse and curate the knowledge base, plus ingest documents via
 * URL or file upload. Ingestion writes the row + enqueues a
 * document_processing_queue job — the DocumentWorker handles extraction,
 * chunking, and embeddings in the background (same path the orchestrator
 * tool takes for large files).
 *
 * GET    /api/knowledge        — list documents (workspace-scoped, active only)
 * DELETE /api/knowledge/:id    — soft-delete (is_active = 0)
 * POST   /api/knowledge/url    — ingest a URL (fetch, strip HTML, enqueue)
 * POST   /api/knowledge/upload — ingest a file (multipart, enqueue)
 */

import { Router, type Request } from 'express';
import { writeFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Busboy from 'busboy';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';

interface KnowledgeRow {
  id: string;
  title: string;
  filename: string | null;
  source_type: string;
  processing_status: string;
  chunk_count: number | null;
  created_at: string;
}

const ALLOWED_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.png', '.jpg', '.jpeg', '.webp', '.json', '.html', '.xml',
]);
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Very light HTML → text. Good enough for ingestion previews; the
 * document worker doesn't re-extract URL docs (it trusts compiled_text),
 * so we just need clean-ish UTF-8.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function enqueueJob(
  db: DatabaseAdapter,
  workspaceId: string,
  documentId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const jobId = createHash('sha256').update(`${Date.now()}-${documentId}`).digest('hex').slice(0, 32);
  await db.from('document_processing_queue').insert({
    id: jobId,
    workspace_id: workspaceId,
    document_id: documentId,
    status: 'pending',
    payload: JSON.stringify(payload),
  });
}

export function createKnowledgeRouter(db: DatabaseAdapter, dataDir?: string): Router {
  const router = Router();

  router.get('/api/knowledge', async (req, res) => {
    try {
      const { data, error } = await db
        .from<KnowledgeRow>('agent_workforce_knowledge_documents')
        .select('id, title, filename, source_type, processing_status, chunk_count, created_at')
        .eq('workspace_id', req.workspaceId)
        .eq('is_active', 1)
        .order('created_at', { ascending: false });

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      const docs = (data || []).map((row) => ({
        id: row.id,
        title: row.title,
        type: row.source_type === 'url' ? 'url' : 'file',
        status: row.processing_status,
        chunk_count: row.chunk_count ?? 0,
        created_at: row.created_at,
      }));

      res.json({ data: docs });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.delete('/api/knowledge/:id', async (req, res) => {
    try {
      const { error } = await db
        .from('agent_workforce_knowledge_documents')
        .update({ is_active: 0, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .eq('workspace_id', req.workspaceId);

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.json({ data: { id: req.params.id } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/api/knowledge/url', async (req, res) => {
    try {
      const url = String((req.body?.url ?? '')).trim();
      if (!url || !/^https?:\/\//i.test(url)) {
        res.status(400).json({ error: 'A valid http(s) URL is required.' });
        return;
      }

      let resp: Response;
      try {
        resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      } catch (err) {
        res.status(502).json({ error: `Couldn't reach ${url}. ${err instanceof Error ? err.message : ''}`.trim() });
        return;
      }

      if (!resp.ok) {
        res.status(502).json({ error: `Fetched ${url} but got HTTP ${resp.status}.` });
        return;
      }

      const contentType = resp.headers.get('content-type') || '';
      const raw = await resp.text();
      const text = contentType.includes('html') ? stripHtml(raw) : raw.trim();

      if (!text || text.length < 20) {
        res.status(422).json({ error: 'No readable text at that URL.' });
        return;
      }

      const title = String(req.body?.title ?? '').trim() ||
        (stripHtml(raw.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '').slice(0, 200) || url);
      const docId = createHash('sha256').update(`${Date.now()}-${url}`).digest('hex').slice(0, 32);
      const now = new Date().toISOString();

      const { error: insertErr } = await db
        .from('agent_workforce_knowledge_documents')
        .insert({
          id: docId,
          workspace_id: req.workspaceId,
          title,
          filename: url,
          file_type: '.html',
          file_size: text.length,
          storage_path: `url://${url}`,
          source_type: 'url',
          source_url: url,
          processing_status: 'processing',
          compiled_text: text,
          created_at: now,
          updated_at: now,
        });

      if (insertErr) {
        res.status(500).json({ error: insertErr.message });
        return;
      }

      await enqueueJob(db, req.workspaceId, docId, { source_type: 'url', url });

      res.json({ data: { id: docId, title, status: 'processing' } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/api/knowledge/upload', (req: Request, res) => {
    if (!dataDir) {
      res.status(503).json({ error: 'Uploads are disabled — the runtime has no configured data directory.' });
      return;
    }

    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      res.status(400).json({ error: 'Content-Type must be multipart/form-data.' });
      return;
    }

    const fields: Record<string, string> = {};
    const files: Array<{ name: string; buffer: Buffer }> = [];
    let tooLarge = false;
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_BYTES } });

    busboy.on('field', (name, val) => { fields[name] = val; });

    busboy.on('file', (_fieldname, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('limit', () => { tooLarge = true; stream.resume(); });
      stream.on('end', () => {
        if (!tooLarge) files.push({ name: info.filename, buffer: Buffer.concat(chunks) });
      });
    });

    busboy.on('finish', async () => {
      try {
        if (tooLarge) {
          res.status(413).json({ error: `File exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit.` });
          return;
        }
        if (files.length === 0) {
          res.status(400).json({ error: 'No file uploaded.' });
          return;
        }

        const workspaceId = req.workspaceId;
        const knowledgeDir = join(dataDir, 'knowledge');
        await mkdir(knowledgeDir, { recursive: true });

        const created: Array<{ id: string; title: string }> = [];

        for (const file of files) {
          const ext = extname(file.name).toLowerCase();
          if (!ALLOWED_EXTENSIONS.has(ext)) {
            logger.warn({ filename: file.name, ext }, '[knowledge] Skipping unsupported file type');
            continue;
          }

          const docId = randomUUID().replace(/-/g, '');
          const storagePath = join(knowledgeDir, `${docId}${ext}`);
          await writeFile(storagePath, file.buffer);

          const title = fields.title?.trim() || file.name.replace(/\.[^.]+$/, '');
          const now = new Date().toISOString();

          const { error: insertErr } = await db
            .from('agent_workforce_knowledge_documents')
            .insert({
              id: docId,
              workspace_id: workspaceId,
              title,
              filename: file.name,
              file_type: ext,
              file_size: file.buffer.length,
              storage_path: `local://${storagePath}`,
              source_type: 'upload',
              processing_status: 'processing',
              created_at: now,
              updated_at: now,
            });

          if (insertErr) {
            logger.error({ err: insertErr, filename: file.name }, '[knowledge] Insert failed');
            continue;
          }

          await enqueueJob(db, workspaceId, docId, { source_type: 'upload', file_path: storagePath });
          created.push({ id: docId, title });
        }

        if (created.length === 0) {
          res.status(400).json({ error: 'No supported files uploaded.' });
          return;
        }

        res.json({ data: { uploaded: created } });
      } catch (err) {
        logger.error({ err }, '[knowledge] Upload handler failed');
        res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
      }
    });

    req.pipe(busboy);
  });

  return router;
}
