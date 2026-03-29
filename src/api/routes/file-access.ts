/**
 * File Access Routes
 * GET    /api/agents/:id/file-access         — List allowed paths
 * POST   /api/agents/:id/file-access         — Add a path
 * DELETE /api/agents/:id/file-access/:pathId  — Remove a path
 * GET    /api/filesystem/browse               — List directories for picker UI
 */

import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

const BLOCKED_PATHS = ['/etc', '/proc', '/sys', '/dev', '/root', '/var', '/boot', '/sbin', '/bin', '/usr'];

function isPathAllowed(resolved: string): boolean {
  const homeDir = os.homedir();
  // Must be within the user's home directory
  if (!resolved.startsWith(homeDir + path.sep) && resolved !== homeDir) {
    return false;
  }
  // Block sensitive subdirectories
  const relative = path.relative(homeDir, resolved);
  const parts = relative.split(path.sep);
  if (parts[0] === '.ssh' || parts[0] === '.gnupg') {
    return false;
  }
  return true;
}

function isAbsolutePathBlocked(resolved: string): boolean {
  for (const blocked of BLOCKED_PATHS) {
    if (resolved === blocked || resolved.startsWith(blocked + path.sep)) {
      return true;
    }
  }
  return false;
}

export function createFileAccessRouter(db: DatabaseAdapter): Router {
  const router = Router();

  // List allowed paths for an agent (or '__orchestrator__')
  router.get('/api/agents/:id/file-access', async (req, res) => {
    try {
      const { workspaceId } = req;
      const agentId = req.params.id;

      const { data, error } = await db.from('agent_file_access_paths')
        .select('*')
        .eq('agent_id', agentId)
        .eq('workspace_id', workspaceId)
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

  // Add an allowed path
  router.post('/api/agents/:id/file-access', async (req, res) => {
    try {
      const { workspaceId } = req;
      const agentId = req.params.id;
      const { path: dirPath, label } = req.body;

      if (!dirPath) {
        res.status(400).json({ error: 'path is required' });
        return;
      }

      // Validate the path exists and is a directory
      const resolved = path.resolve(dirPath);

      // Block sensitive system paths
      if (isAbsolutePathBlocked(resolved)) {
        res.status(403).json({ error: 'Access to system directories is not allowed' });
        return;
      }

      // Must be within user's home directory
      if (!isPathAllowed(resolved)) {
        res.status(403).json({ error: 'Path must be within your home directory' });
        return;
      }

      try {
        // Use lstat to detect symlinks
        const stat = await fs.promises.lstat(resolved);
        if (stat.isSymbolicLink()) {
          // Resolve the symlink target and re-check bounds
          const realTarget = await fs.promises.realpath(resolved);
          if (!isPathAllowed(realTarget) || isAbsolutePathBlocked(realTarget)) {
            res.status(403).json({ error: 'Symlink target is outside allowed paths' });
            return;
          }
          const targetStat = await fs.promises.stat(realTarget);
          if (!targetStat.isDirectory()) {
            res.status(400).json({ error: 'Path must be a directory' });
            return;
          }
        } else if (!stat.isDirectory()) {
          res.status(400).json({ error: 'Path must be a directory' });
          return;
        }
      } catch {
        res.status(400).json({ error: 'Directory not found' });
        return;
      }

      // Check for duplicate
      const { data: existing } = await db.from('agent_file_access_paths')
        .select('id')
        .eq('agent_id', agentId)
        .eq('path', resolved)
        .maybeSingle();

      if (existing) {
        res.status(409).json({ error: 'This directory is already in the allowlist' });
        return;
      }

      const { error } = await db.from('agent_file_access_paths').insert({
        agent_id: agentId,
        workspace_id: workspaceId,
        path: resolved,
        label: label || null,
      });

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.status(201).json({ data: { path: resolved, label: label || null } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Remove an allowed path
  router.delete('/api/agents/:id/file-access/:pathId', async (req, res) => {
    try {
      const { workspaceId } = req;
      const pathId = req.params.pathId;

      const { error } = await db.from('agent_file_access_paths')
        .delete()
        .eq('id', pathId)
        .eq('workspace_id', workspaceId);

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Browse directories for picker UI
  router.get('/api/filesystem/browse', async (req, res) => {
    try {
      const browsePath = (req.query.path as string) || os.homedir();
      const resolved = path.resolve(browsePath);

      // Restrict browsing to home directory and below
      if (isAbsolutePathBlocked(resolved) || !isPathAllowed(resolved)) {
        res.status(403).json({ error: 'Browsing is restricted to your home directory' });
        return;
      }

      try {
        const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
        const dirs = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => ({
            name: e.name,
            path: path.join(resolved, e.name),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        const parent = path.dirname(resolved);
        res.json({
          current: resolved,
          parent: parent !== resolved && isPathAllowed(parent) ? parent : null,
          directories: dirs,
        });
      } catch {
        res.status(400).json({ error: 'Cannot read directory' });
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
