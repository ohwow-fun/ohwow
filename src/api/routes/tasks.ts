/**
 * Tasks Routes
 * GET /api/tasks — List tasks
 * GET /api/tasks/:id — Get task details
 * GET /api/tasks/:id/messages — Get task conversation
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { RuntimeEngine } from '../../execution/engine.js';
import { logger } from '../../lib/logger.js';

export function createTasksRouter(db: DatabaseAdapter, engine?: RuntimeEngine | null): Router {
  const router = Router();

  // List tasks (with optional filters)
  router.get('/api/tasks', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { agentId, status, limit = '50', offset = '0' } = req.query;
      const limNum = Math.max(1, Math.min(500, parseInt(limit as string, 10) || 50));
      const offNum = Math.max(0, parseInt(offset as string, 10) || 0);

      // Count first so the client can paginate without a second round trip.
      let countQuery = db.from('agent_workforce_tasks')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId);
      if (agentId) countQuery = countQuery.eq('agent_id', agentId as string);
      if (status) countQuery = countQuery.eq('status', status as string);
      const { count: total } = await countQuery;

      let query = db.from('agent_workforce_tasks')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .range(offNum, offNum + limNum - 1);

      if (agentId) {
        query = query.eq('agent_id', agentId as string);
      }
      if (status) {
        query = query.eq('status', status as string);
      }

      const { data, error } = await query;

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.json({ data: data || [], total: total ?? 0, limit: limNum, offset: offNum });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Get single task
  router.get('/api/tasks/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('agent_workforce_tasks')
        .select('*')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .single();

      if (error || !data) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      res.json({ data });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Dispatch a new task
  router.post('/api/tasks', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { agentId, title, description } = req.body as {
        agentId?: string;
        title?: string;
        description?: string;
      };

      if (!agentId || !title) {
        res.status(400).json({ error: 'agentId and title are required' });
        return;
      }

      const taskId = crypto.randomUUID();
      const now = new Date().toISOString();

      const { error: insertErr } = await db.from('agent_workforce_tasks').insert({
        id: taskId,
        agent_id: agentId,
        workspace_id: workspaceId,
        title,
        description: description || null,
        input: JSON.stringify({ title, description }),
        status: 'pending',
        priority: 'normal',
        created_at: now,
        updated_at: now,
      });

      if (insertErr) {
        res.status(500).json({ error: insertErr.message });
        return;
      }

      // Execute async if engine is available
      if (engine) {
        engine.executeTask(agentId, taskId).catch(async (err) => {
          logger.error({ err, taskId, agentId }, '[TaskRoute] Task execution failed');
          try {
            await db.from('agent_workforce_tasks').update({
              status: 'failed',
              error_message: err instanceof Error ? err.message : 'Task execution failed unexpectedly',
              updated_at: new Date().toISOString(),
            }).eq('id', taskId);
            await db.from('agent_workforce_agents').update({
              status: 'idle',
              updated_at: new Date().toISOString(),
            }).eq('id', agentId);
          } catch { /* best effort cleanup */ }
        });
      }

      res.status(201).json({ data: { id: taskId, status: 'pending' } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Execute an existing task
  router.post('/api/tasks/:id/execute', async (req, res) => {
    try {
      if (!engine) {
        res.status(503).json({ error: 'Engine not available' });
        return;
      }

      const { workspaceId } = req;
      const { data: task, error: fetchErr } = await db.from('agent_workforce_tasks')
        .select('*')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .single();

      if (fetchErr || !task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      const row = task as Record<string, unknown>;
      const agentId = row.agent_id as string;

      // Fire-and-forget execution
      engine.executeTask(agentId, req.params.id).catch(async (err) => {
        logger.error({ err, taskId: req.params.id, agentId }, '[TaskRoute] Task execution failed');
        try {
          await db.from('agent_workforce_tasks').update({
            status: 'failed',
            error_message: err instanceof Error ? err.message : 'Task execution failed unexpectedly',
            updated_at: new Date().toISOString(),
          }).eq('id', req.params.id);
          await db.from('agent_workforce_agents').update({
            status: 'idle',
            updated_at: new Date().toISOString(),
          }).eq('id', agentId);
        } catch { /* best effort cleanup */ }
      });
      res.status(202).json({ data: { id: req.params.id, status: 'executing' } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Get task messages
  router.get('/api/tasks/:id/messages', async (req, res) => {
    try {
      const { data, error } = await db.from('agent_workforce_task_messages')
        .select('*')
        .eq('task_id', req.params.id)
        .order('created_at', { ascending: true });

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Get task trace (ReAct steps from metadata)
  router.get('/api/tasks/:id/trace', async (req, res) => {
    try {
      const { data: task } = await db.from('agent_workforce_tasks')
        .select('id, metadata')
        .eq('id', req.params.id)
        .single();

      if (!task) { res.status(404).json({ error: 'Task not found' }); return; }

      const meta = typeof (task as Record<string, unknown>).metadata === 'string'
        ? JSON.parse((task as Record<string, unknown>).metadata as string)
        : ((task as Record<string, unknown>).metadata || {});

      res.json({
        reactTrace: meta.react_trace || [],
        toolCalls: meta.tool_calls || [],
        sipocTrace: meta.sipoc_trace || null,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Get task activity feed
  router.get('/api/tasks/:id/activity', async (req, res) => {
    try {
      const { data } = await db.from('agent_workforce_activity')
        .select('*')
        .eq('task_id', req.params.id)
        .order('created_at', { ascending: true });

      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Get agent state for this task's agent
  router.get('/api/tasks/:id/state', async (req, res) => {
    try {
      const { data: task } = await db.from('agent_workforce_tasks')
        .select('agent_id')
        .eq('id', req.params.id)
        .single();

      if (!task) { res.status(404).json({ error: 'Task not found' }); return; }

      const agentId = (task as Record<string, unknown>).agent_id as string;
      const { data } = await db.from('agent_workforce_task_state')
        .select('*')
        .eq('agent_id', agentId)
        .order('updated_at', { ascending: false });

      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Get task deliverables
  router.get('/api/tasks/:id/deliverables', async (req, res) => {
    try {
      const { data } = await db.from('agent_workforce_deliverables')
        .select('*')
        .eq('task_id', req.params.id)
        .order('created_at', { ascending: true });

      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Get task replay (merged timeline)
  router.get('/api/tasks/:id/replay', async (req, res) => {
    try {
      const { data: task } = await db.from('agent_workforce_tasks')
        .select('id, title, status, output, metadata, duration_seconds, tokens_used, completed_at')
        .eq('id', req.params.id)
        .single();

      if (!task) { res.status(404).json({ error: 'Task not found' }); return; }

      const meta = typeof (task as Record<string, unknown>).metadata === 'string'
        ? JSON.parse((task as Record<string, unknown>).metadata as string)
        : ((task as Record<string, unknown>).metadata || {});

      // Build a basic timeline from available data
      const timeline = [];
      const reactTrace = meta.react_trace || [];
      for (const step of reactTrace) {
        if (step.action) {
          timeline.push({
            id: `step-${step.step || timeline.length}`,
            type: 'tool_call',
            timestamp: step.timestamp || (task as Record<string, unknown>).completed_at,
            toolName: step.action,
            toolInput: step.input,
            toolOutput: step.observation,
            toolSuccess: !step.error,
          });
        }
      }

      res.json({
        timeline,
        summary: {
          totalSteps: reactTrace.length,
          duration: (task as Record<string, unknown>).duration_seconds,
          tokensUsed: (task as Record<string, unknown>).tokens_used,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
