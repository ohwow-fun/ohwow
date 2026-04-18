/**
 * generate_pptx dispatcher: build a PowerPoint deck from a slide spec using pptxgenjs.
 */

import type { ActionDispatcher, DispatcherDeps } from '../action-dispatcher.js';
import type { ExecutionContext, ActionOutput } from '../automation-types.js';
import { resolveContextTemplate } from '../field-mapper.js';
import { logger } from '../../lib/logger.js';

export interface PptxSlideSpec {
  title?: string;
  bullets?: string[];
  notes?: string;
  layout?: 'TITLE' | 'TITLE_AND_CONTENT' | 'BLANK';
}

export interface PptxSpec {
  title?: string;
  author?: string;
  slides: PptxSlideSpec[];
  filename?: string;
  auto_save?: boolean;
}

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export const generatePptxDispatcher: ActionDispatcher = {
  actionType: 'generate_pptx',

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
    deps: DispatcherDeps,
  ): Promise<ActionOutput> {
    const slides = config.slides as PptxSlideSpec[] | undefined;
    if (!Array.isArray(slides) || slides.length === 0) {
      throw new Error('generate_pptx requires at least one slide in config.slides');
    }

    const deckTitle = config.title as string | undefined;
    const deckAuthor = config.author as string | undefined;
    const filenameTemplate = config.filename as string | undefined;
    const autoSave = config.auto_save === true;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const PptxGenJS = (await import('pptxgenjs')).default as any;
    const pptx = new PptxGenJS();

    if (deckTitle) pptx.title = deckTitle;
    if (deckAuthor) pptx.author = deckAuthor;

    const warnings: string[] = [];

    for (const slideSpec of slides) {
      const layout = slideSpec.layout || 'TITLE_AND_CONTENT';
      const slide = pptx.addSlide();

      if (slideSpec.title) {
        slide.addText(slideSpec.title, {
          x: 0.5,
          y: 0.3,
          w: 9,
          h: 1,
          fontSize: layout === 'TITLE' ? 40 : 28,
          bold: true,
        });
      }

      if (layout !== 'TITLE' && layout !== 'BLANK' && Array.isArray(slideSpec.bullets) && slideSpec.bullets.length > 0) {
        const bulletText = slideSpec.bullets.join('\n');
        slide.addText(bulletText, {
          x: 0.5,
          y: 1.5,
          w: 9,
          h: 5,
          fontSize: 18,
          bullet: true,
        });
      }

      if (slideSpec.notes) {
        slide.addNotes(slideSpec.notes);
      }
    }

    const written = await pptx.write({ outputType: 'nodebuffer' });
    let pptxBuffer: Buffer;
    if (Buffer.isBuffer(written)) {
      pptxBuffer = written;
    } else if (written instanceof Uint8Array) {
      pptxBuffer = Buffer.from(written);
    } else if (written instanceof ArrayBuffer) {
      pptxBuffer = Buffer.from(new Uint8Array(written));
    } else {
      pptxBuffer = Buffer.from(String(written), 'binary');
    }
    const pptxBase64 = pptxBuffer.toString('base64');

    logger.info(`[ActionExecutor] Generated PPTX: ${slides.length} slides, ${pptxBuffer.length} bytes`);

    const output: ActionOutput = {
      pptx_base64: pptxBase64,
      slide_count: slides.length,
      warnings,
    };

    if (autoSave) {
      const filename = filenameTemplate
        ? resolveContextTemplate(filenameTemplate, context)
        : 'deck.pptx';

      try {
        const { writeFile, mkdir } = await import('fs/promises');
        const { join } = await import('path');

        const dataDir = process.env.DATA_DIR || join(process.cwd(), 'data');
        const dir = join(dataDir, 'files', deps.workspaceId, 'general');
        await mkdir(dir, { recursive: true });

        const filePath = join(dir, `${Date.now()}-${filename}`);
        await writeFile(filePath, pptxBuffer);

        const { data: attachmentRecord } = await deps.db.from('agent_workforce_attachments')
          .insert({
            workspace_id: deps.workspaceId,
            file_name: filename,
            file_type: PPTX_MIME,
            file_size: pptxBuffer.length,
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
        output.mime_type = PPTX_MIME;
        logger.info(`[ActionExecutor] Auto-saved PPTX: ${filename} (${pptxBuffer.length} bytes)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        output.warnings = [...warnings, `Auto-save failed: ${msg}`];
      }
    }

    return output;
  },
};
