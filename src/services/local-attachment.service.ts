/**
 * Local Attachment Service
 * Handles file attachments stored on disk for the TUI workspace.
 */

import { copyFileSync, writeFileSync, mkdirSync, unlinkSync, statSync, existsSync } from 'fs';
import { join, basename, extname } from 'path';
import { randomUUID } from 'crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { AttachmentRow } from '../tui/types.js';
import { workspaceId as toWorkspaceId } from '../lib/branded-types.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const ALLOWED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp',
  '.pdf',
  '.doc', '.docx',
  '.xls', '.xlsx',
  '.csv', '.txt',
]);

function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.csv': 'text/csv',
    '.txt': 'text/plain',
  };
  return map[ext] || 'application/octet-stream';
}

export interface LocalAttachmentService {
  attach: (entityType: string, entityId: string, filePath: string) => Promise<AttachmentRow>;
  attachFromBuffer: (opts: {
    entityType: string;
    entityId: string;
    buffer: Buffer;
    filename: string;
    uploadedBy?: string | null;
  }) => Promise<AttachmentRow>;
  getById: (id: string) => AttachmentRow | null;
  list: (entityType: string, entityId: string) => AttachmentRow[];
  listByFileType: (fileType: string, limit?: number) => AttachmentRow[];
  remove: (id: string) => void;
}

export function createLocalAttachmentService(
  db: DatabaseAdapter,
  workspaceId: string,
  dataDir: string,
): LocalAttachmentService {
  return {
    async attach(entityType, entityId, filePath) {
      if (!existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      const stats = statSync(filePath);
      if (stats.size > MAX_FILE_SIZE) {
        throw new Error(`File too large. Max size is ${MAX_FILE_SIZE / (1024 * 1024)} MB.`);
      }

      const ext = extname(filePath).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        throw new Error(`File type not supported. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`);
      }

      const filename = basename(filePath);
      const timestamp = Date.now();
      const destDir = join(dataDir, 'files', workspaceId, entityType, entityId);
      mkdirSync(destDir, { recursive: true });

      const destPath = join(destDir, `${timestamp}-${filename}`);
      copyFileSync(filePath, destPath);

      const id = randomUUID();
      const fileType = mimeFromExt(ext);

      // Insert into SQLite — use raw query since the adapter may not support returning
      const row: AttachmentRow = {
        id,
        workspace_id: toWorkspaceId(workspaceId),
        entity_type: entityType,
        entity_id: entityId,
        filename,
        file_type: fileType,
        file_size: stats.size,
        storage_path: destPath,
        uploaded_by: null,
        created_at: new Date().toISOString(),
      };

      // Use the adapter's insert — must await to trigger lazy execution
      const { error: insertError } = await db.from('agent_workforce_attachments').insert({
        id: row.id,
        workspace_id: row.workspace_id,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        filename: row.filename,
        file_type: row.file_type,
        file_size: row.file_size,
        storage_path: row.storage_path,
        uploaded_by: row.uploaded_by,
        created_at: row.created_at,
      });

      if (insertError) throw new Error(`Attachment insert failed: ${insertError}`);

      return row;
    },

    async attachFromBuffer({ entityType, entityId, buffer, filename, uploadedBy }) {
      if (buffer.length > MAX_FILE_SIZE) {
        throw new Error(`File too large. Max size is ${MAX_FILE_SIZE / (1024 * 1024)} MB.`);
      }

      const ext = extname(filename).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        throw new Error(`File type not supported. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`);
      }

      const safeName = basename(filename);
      const timestamp = Date.now();
      const destDir = join(dataDir, 'files', workspaceId, entityType, entityId);
      mkdirSync(destDir, { recursive: true });

      const destPath = join(destDir, `${timestamp}-${safeName}`);
      writeFileSync(destPath, buffer);

      const id = randomUUID();
      const fileType = mimeFromExt(ext);

      const row: AttachmentRow = {
        id,
        workspace_id: toWorkspaceId(workspaceId),
        entity_type: entityType,
        entity_id: entityId,
        filename: safeName,
        file_type: fileType,
        file_size: buffer.length,
        storage_path: destPath,
        uploaded_by: uploadedBy ?? null,
        created_at: new Date().toISOString(),
      };

      const { error: insertError } = await db.from('agent_workforce_attachments').insert({
        id: row.id,
        workspace_id: row.workspace_id,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        filename: row.filename,
        file_type: row.file_type,
        file_size: row.file_size,
        storage_path: row.storage_path,
        uploaded_by: row.uploaded_by,
        created_at: row.created_at,
      });

      if (insertError) throw new Error(`Attachment insert failed: ${insertError}`);

      return row;
    },

    getById(id) {
      const result = db
        .from<AttachmentRow>('agent_workforce_attachments')
        .select('*')
        .eq('id', id)
        .eq('workspace_id', workspaceId)
        .single();

      const data = (result as unknown as { data: AttachmentRow | null }).data;
      return data || null;
    },

    list(entityType, entityId) {
      const result = db
        .from<AttachmentRow>('agent_workforce_attachments')
        .select('*')
        .eq('entity_type', entityType)
        .eq('entity_id', entityId)
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false });

      const data = (result as unknown as { data: AttachmentRow[] | null }).data;
      return data ?? [];
    },

    listByFileType(fileType, limit = 50) {
      const query = db
        .from<AttachmentRow>('agent_workforce_attachments')
        .select('*')
        .eq('file_type', fileType)
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .limit(limit);

      const data = (query as unknown as { data: AttachmentRow[] | null }).data;
      return data ?? [];
    },

    remove(id) {
      // Fetch the row first — scoped to workspace
      const result = db
        .from<{ storage_path: string }>('agent_workforce_attachments')
        .select('storage_path')
        .eq('id', id)
        .eq('workspace_id', workspaceId)
        .single();

      const row = (result as unknown as { data: { storage_path: string } | null }).data;
      if (!row) throw new Error('Attachment not found.');

      // Delete the file from disk
      try {
        if (existsSync(row.storage_path)) {
          unlinkSync(row.storage_path);
        }
      } catch {
        // File may already be gone
      }

      // Delete from SQLite — scoped to workspace
      db.from('agent_workforce_attachments').delete().eq('id', id).eq('workspace_id', workspaceId);
    },
  };
}
