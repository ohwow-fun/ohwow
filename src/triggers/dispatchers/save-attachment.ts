/**
 * save_attachment dispatcher: save a base64 file to local storage.
 */

import type { ActionDispatcher, DispatcherDeps } from '../action-dispatcher.js';
import type { ExecutionContext, ActionOutput } from '../automation-types.js';
import { resolveContextValue } from '../action-utils.js';
import { resolveContextTemplate } from '../field-mapper.js';
import { logger } from '../../lib/logger.js';

export const saveAttachmentDispatcher: ActionDispatcher = {
  actionType: 'save_attachment',

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
    deps: DispatcherDeps,
  ): Promise<ActionOutput> {
    const dataPath = config.data_path as string;
    const filenameTemplate = config.filename_template as string;
    const fileType = (config.file_type as string) || 'application/pdf';
    const entityType = (config.entity_type as string) || 'contact';
    const entityIdPath = config.entity_id_path as string | undefined;

    if (!dataPath) throw new Error('save_attachment requires data_path');
    if (!filenameTemplate) throw new Error('save_attachment requires filename_template');

    const base64Data = resolveContextValue(dataPath, context);
    if (!base64Data || typeof base64Data !== 'string') {
      throw new Error(`No data found at path: ${dataPath}`);
    }

    const filename = resolveContextTemplate(filenameTemplate, context);

    let entityId: string | null = null;
    if (entityIdPath) {
      const resolved = resolveContextValue(entityIdPath, context);
      if (resolved && typeof resolved === 'string') entityId = resolved;
    }

    const { writeFile, mkdir } = await import('fs/promises');
    const { join } = await import('path');

    const dataDir = process.env.DATA_DIR || join(process.cwd(), 'data');
    const dir = join(dataDir, 'files', deps.workspaceId, entityType, entityId || 'general');
    await mkdir(dir, { recursive: true });

    const filePath = join(dir, `${Date.now()}-${filename}`);
    const buffer = Buffer.from(base64Data, 'base64');
    await writeFile(filePath, buffer);

    const { data: attachmentRecord } = await deps.db.from('agent_workforce_attachments')
      .insert({
        workspace_id: deps.workspaceId,
        file_name: filename,
        file_type: fileType,
        file_size: buffer.length,
        storage_path: filePath,
        entity_type: entityType,
        entity_id: entityId,
        source: 'automation',
      })
      .select('id')
      .single();

    const attachmentId = attachmentRecord ? (attachmentRecord as { id: string }).id : null;
    logger.info(`[ActionExecutor] Saved attachment: ${filename} (${buffer.length} bytes)`);
    return { attachment_id: attachmentId, storage_path: filePath, filename };
  },
};
