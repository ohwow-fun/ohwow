/**
 * Attachment Routes (Local Runtime)
 * POST   /api/attachments                  — Upload a file (multipart)
 * GET    /api/attachments                  — List attachments for an entity
 * DELETE /api/attachments/:id              — Delete an attachment
 * GET    /api/attachments/:id/download     — Download/stream a file
 * GET    /api/attachments/:id/inspect-pdf  — Inspect PDF form fields
 */

import { Router, type Request } from 'express';
import { existsSync, readFileSync } from 'fs';
import Busboy from 'busboy';
import {
  PDFDocument,
  PDFTextField,
  PDFCheckBox,
  PDFDropdown,
  PDFRadioGroup,
  PDFSignature,
} from 'pdf-lib';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { createLocalAttachmentService } from '../../services/local-attachment.service.js';

export function createAttachmentsRouter(db: DatabaseAdapter, dataDir: string): Router {
  const router = Router();

  function getService(req: Request) {
    const workspaceId = req.workspaceId || 'local';
    return createLocalAttachmentService(db, workspaceId, dataDir);
  }

  // Upload attachment (multipart/form-data)
  router.post('/api/attachments', (req, res) => {
    const service = getService(req);

    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      res.status(400).json({ error: 'Content-Type must be multipart/form-data' });
      return;
    }

    const fields: Record<string, string> = {};
    let fileBuffer: Buffer | null = null;
    let fileName = '';

    const busboy = Busboy({ headers: req.headers });

    busboy.on('field', (name: string, val: string) => {
      fields[name] = val;
    });

    busboy.on('file', (_fieldname: string, stream: NodeJS.ReadableStream, info: { filename: string }) => {
      fileName = info.filename;
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });

    busboy.on('finish', async () => {
      try {
        if (!fileBuffer || !fileName) {
          res.status(400).json({ error: 'No file provided' });
          return;
        }

        const entityType = fields.entity_type;
        const entityId = fields.entity_id;

        if (!entityType || !entityId) {
          res.status(400).json({ error: 'entity_type and entity_id are required' });
          return;
        }

        const row = await service.attachFromBuffer({
          entityType,
          entityId,
          buffer: fileBuffer,
          filename: fileName,
          uploadedBy: req.userId || null,
        });

        // Strip storage_path (filesystem info leak) and add download_url
        const { storage_path: _, ...safe } = row;
        const attachment = {
          ...safe,
          download_url: `/api/attachments/${row.id}/download`,
        };

        res.status(201).json({ attachment });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        res.status(400).json({ error: message });
      }
    });

    busboy.on('error', () => {
      res.status(500).json({ error: 'Upload stream error' });
    });

    req.pipe(busboy);
  });

  // List attachments — by entity or by file_type (browse mode)
  router.get('/api/attachments', (req, res) => {
    try {
      const service = getService(req);

      const entityType = req.query.entity_type as string;
      const entityId = req.query.entity_id as string;
      const fileType = req.query.file_type as string;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

      let rows;

      if (fileType && !entityType) {
        // Browse mode: list all attachments of a given file type
        rows = service.listByFileType(fileType, limit);
      } else if (entityType && entityId) {
        rows = service.list(entityType, entityId);
      } else {
        res.status(400).json({ error: 'Provide entity_type + entity_id, or file_type' });
        return;
      }

      const attachments = rows.map((row) => {
        const { storage_path: _, ...safe } = row;
        return { ...safe, download_url: `/api/attachments/${row.id}/download` };
      });

      res.json({ attachments });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Delete attachment
  router.delete('/api/attachments/:id', (req, res) => {
    try {
      const service = getService(req);

      service.remove(req.params.id);
      res.json({ deleted: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Delete failed';
      res.status(err instanceof Error && message.includes('not found') ? 404 : 500).json({ error: message });
    }
  });

  // Inspect PDF form fields
  router.get('/api/attachments/:id/inspect-pdf', async (req, res) => {
    try {
      const service = getService(req);

      const attachment = service.getById(req.params.id);
      if (!attachment) {
        res.status(404).json({ error: 'Attachment not found' });
        return;
      }

      if (attachment.file_type !== 'application/pdf') {
        res.status(400).json({ error: 'Attachment is not a PDF' });
        return;
      }

      if (!existsSync(attachment.storage_path)) {
        res.status(404).json({ error: 'File not found on disk' });
        return;
      }

      const buffer = readFileSync(attachment.storage_path);
      const pdfDoc = await PDFDocument.load(buffer);

      let formType: 'acroform' | 'flat' = 'flat';
      const fields: Array<{
        name: string;
        type: string;
        currentValue: string | null;
        options?: string[];
      }> = [];

      try {
        const form = pdfDoc.getForm();
        const formFields = form.getFields();

        if (formFields.length > 0) {
          formType = 'acroform';

          for (const field of formFields) {
            const name = field.getName();
            let type = 'unknown';
            let currentValue: string | null = null;
            let options: string[] | undefined;

            if (field instanceof PDFTextField) {
              type = 'text';
              try { currentValue = field.getText() || null; } catch { /* empty */ }
            } else if (field instanceof PDFCheckBox) {
              type = 'checkbox';
              try { currentValue = String(field.isChecked()); } catch { /* empty */ }
            } else if (field instanceof PDFDropdown) {
              type = 'dropdown';
              try {
                const sel = field.getSelected();
                currentValue = sel.length > 0 ? sel[0] : null;
                options = field.getOptions();
              } catch { /* empty */ }
            } else if (field instanceof PDFRadioGroup) {
              type = 'radio';
              try {
                currentValue = field.getSelected() || null;
                options = field.getOptions();
              } catch { /* empty */ }
            } else if (field instanceof PDFSignature) {
              type = 'signature';
            }

            fields.push({ name, type, currentValue, ...(options ? { options } : {}) });
          }
        }
      } catch {
        // No form in PDF
      }

      res.json({ form_type: formType, field_count: fields.length, fields });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Couldn\'t inspect PDF' });
    }
  });

  // Download/stream a file
  router.get('/api/attachments/:id/download', (req, res) => {
    try {
      const service = getService(req);

      const attachment = service.getById(req.params.id);
      if (!attachment) {
        res.status(404).json({ error: 'Attachment not found' });
        return;
      }

      if (!existsSync(attachment.storage_path)) {
        res.status(404).json({ error: 'File not found on disk' });
        return;
      }

      res.setHeader('Content-Type', attachment.file_type);
      res.setHeader('Content-Disposition', `inline; filename="${attachment.filename}"`);
      res.sendFile(attachment.storage_path);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Download failed' });
    }
  });

  // Save file from automation (JSON body with base64 data, dispatched by cloud)
  router.post('/api/automation/save-file', async (req, res) => {
    try {
      const { file_data, filename, file_type, entity_type, entity_id } = req.body as {
        file_data?: string;
        filename?: string;
        file_type?: string;
        entity_type?: string;
        entity_id?: string | null;
      };

      if (!file_data || !filename) {
        res.status(400).json({ error: 'file_data and filename are required' });
        return;
      }

      const buffer = Buffer.from(file_data, 'base64');
      const service = getService(req);

      const row = await service.attachFromBuffer({
        entityType: entity_type || 'contact',
        entityId: entity_id || 'general',
        buffer,
        filename,
        uploadedBy: req.userId || null,
      });

      res.status(201).json({
        attachment_id: row.id,
        storage_path: row.storage_path,
        filename: row.filename,
        file_type: file_type || row.file_type,
        file_size: row.file_size,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed';
      res.status(500).json({ error: message });
    }
  });

  return router;
}
