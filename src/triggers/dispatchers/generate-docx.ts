/**
 * generate_docx dispatcher: build a Word document from a block spec using docx.
 */

import type { ActionDispatcher, DispatcherDeps } from '../action-dispatcher.js';
import type { ExecutionContext, ActionOutput } from '../automation-types.js';
import { resolveContextTemplate } from '../field-mapper.js';
import { logger } from '../../lib/logger.js';

export interface DocxRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export type DocxBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: 'paragraph'; runs: DocxRun[] }
  | { type: 'bullets'; items: string[] };

export interface DocxSpec {
  title?: string;
  author?: string;
  blocks: DocxBlock[];
  filename?: string;
  auto_save?: boolean;
}

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const generateDocxDispatcher: ActionDispatcher = {
  actionType: 'generate_docx',

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
    deps: DispatcherDeps,
  ): Promise<ActionOutput> {
    const blocks = config.blocks as DocxBlock[] | undefined;
    if (!Array.isArray(blocks) || blocks.length === 0) {
      throw new Error('generate_docx requires at least one block in config.blocks');
    }

    const docTitle = config.title as string | undefined;
    const docAuthor = config.author as string | undefined;
    const filenameTemplate = config.filename as string | undefined;
    const autoSave = config.auto_save === true;

    const docxMod = await import('docx');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const docx: any = (docxMod as any).default ?? docxMod;
    const { Document, Packer, Paragraph, HeadingLevel, TextRun } = docx;

    const headingLevelFor = (level: number): unknown => {
      switch (level) {
        case 1: return HeadingLevel.HEADING_1;
        case 2: return HeadingLevel.HEADING_2;
        case 3: return HeadingLevel.HEADING_3;
        case 4: return HeadingLevel.HEADING_4;
        case 5: return HeadingLevel.HEADING_5;
        case 6: return HeadingLevel.HEADING_6;
        default: return HeadingLevel.HEADING_1;
      }
    };

    const warnings: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const children: any[] = [];

    for (const block of blocks) {
      if (block.type === 'heading') {
        children.push(
          new Paragraph({
            heading: headingLevelFor(block.level),
            children: [new TextRun({ text: block.text })],
          }),
        );
      } else if (block.type === 'paragraph') {
        const runs = Array.isArray(block.runs) ? block.runs : [];
        children.push(
          new Paragraph({
            children: runs.map((r) =>
              new TextRun({
                text: r.text,
                bold: r.bold,
                italics: r.italic,
                underline: r.underline ? {} : undefined,
              }),
            ),
          }),
        );
      } else if (block.type === 'bullets') {
        const items = Array.isArray(block.items) ? block.items : [];
        for (const item of items) {
          children.push(
            new Paragraph({
              bullet: { level: 0 },
              children: [new TextRun({ text: item })],
            }),
          );
        }
      }
    }

    const doc = new Document({
      creator: docAuthor ?? 'ohwow',
      title: docTitle,
      sections: [{ children }],
    });

    const raw = await Packer.toBuffer(doc);
    let docxBuffer: Buffer;
    if (Buffer.isBuffer(raw)) {
      docxBuffer = raw;
    } else if (raw instanceof Uint8Array) {
      docxBuffer = Buffer.from(raw);
    } else if (raw instanceof ArrayBuffer) {
      docxBuffer = Buffer.from(new Uint8Array(raw));
    } else {
      docxBuffer = Buffer.from(raw as ArrayBuffer);
    }
    const docxBase64 = docxBuffer.toString('base64');

    logger.info(
      `[ActionExecutor] Generated DOCX: ${blocks.length} blocks, ${docxBuffer.length} bytes`,
    );

    const output: ActionOutput = {
      docx_base64: docxBase64,
      block_count: blocks.length,
      warnings,
    };

    if (autoSave) {
      const filename = filenameTemplate
        ? resolveContextTemplate(filenameTemplate, context)
        : 'document.docx';

      try {
        const { writeFile, mkdir } = await import('fs/promises');
        const { join } = await import('path');

        const dataDir = process.env.DATA_DIR || join(process.cwd(), 'data');
        const dir = join(dataDir, 'files', deps.workspaceId, 'general');
        await mkdir(dir, { recursive: true });

        const filePath = join(dir, `${Date.now()}-${filename}`);
        await writeFile(filePath, docxBuffer);

        const { data: attachmentRecord } = await deps.db.from('agent_workforce_attachments')
          .insert({
            workspace_id: deps.workspaceId,
            file_name: filename,
            file_type: DOCX_MIME,
            file_size: docxBuffer.length,
            storage_path: filePath,
            entity_type: 'contact',
            entity_id: null,
            source: 'automation',
          })
          .select('id')
          .single();

        const attachmentId = attachmentRecord ? (attachmentRecord as { id: string }).id : null;
        output.attachment_id = attachmentId;
        output.storage_path = filePath;
        output.storage_target = 'local';
        output.filename = filename;
        output.mime_type = DOCX_MIME;
        logger.info(`[ActionExecutor] Auto-saved DOCX: ${filename} (${docxBuffer.length} bytes)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        output.warnings = [...warnings, `Auto-save failed: ${msg}`];
      }
    }

    return output;
  },
};
