/**
 * Knowledge Routes
 *
 * Thin HTTP layer over agent_workforce_knowledge_documents so the web UI
 * can browse and curate the knowledge base. Ingestion (url + file upload)
 * currently lives in the orchestrator tool (addKnowledgeFromUrl /
 * uploadKnowledge) because it needs the full LocalToolContext to run
 * extraction, chunking, and embeddings. Exposing those through HTTP is
 * a follow-up; for now the UI can list, search, and delete.
 *
 * GET    /api/knowledge      — list documents (workspace-scoped, active only)
 * DELETE /api/knowledge/:id  — soft-delete (is_active = 0)
 * POST   /api/knowledge/url  — 501 with pointer to orchestrator chat
 * POST   /api/knowledge/upload — 501 with pointer to orchestrator chat
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

interface KnowledgeRow {
  id: string;
  title: string;
  filename: string | null;
  source_type: string;
  processing_status: string;
  chunk_count: number | null;
  created_at: string;
}

export function createKnowledgeRouter(db: DatabaseAdapter): Router {
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

  const notImplemented = (_req: unknown, res: { status(n: number): { json(body: unknown): void } }) => {
    res.status(501).json({
      error:
        'Knowledge ingestion is not exposed over HTTP yet. Ask the orchestrator in Chat: "add the knowledge from <URL>" or "upload the file at <path>".',
    });
  };

  router.post('/api/knowledge/url', notImplemented);
  router.post('/api/knowledge/upload', notImplemented);

  return router;
}
