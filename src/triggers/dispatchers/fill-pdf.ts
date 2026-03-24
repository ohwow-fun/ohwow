/**
 * fill_pdf dispatcher: fill a PDF template with data using pdf-lib.
 */

import type { ActionDispatcher, DispatcherDeps } from '../action-dispatcher.js';
import type { ExecutionContext, ActionOutput } from '../automation-types.js';
import { resolveContextTemplate } from '../field-mapper.js';
import { logger } from '../../lib/logger.js';

export const fillPdfDispatcher: ActionDispatcher = {
  actionType: 'fill_pdf',

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
    deps: DispatcherDeps,
  ): Promise<ActionOutput> {
    const templateAttachmentId = config.template_attachment_id as string;
    const manualFieldMapping = config.manual_field_mapping as Record<string, string> | undefined;
    const aiAutoMap = config.ai_auto_map !== false;
    const flatten = config.flatten !== false;

    if (!templateAttachmentId) {
      throw new Error('fill_pdf requires template_attachment_id');
    }

    const { data: attachment } = await deps.db.from('agent_workforce_attachments')
      .select('storage_path, file_name')
      .eq('id', templateAttachmentId)
      .single();

    if (!attachment) {
      throw new Error(`Template attachment not found: ${templateAttachmentId}`);
    }

    const { storage_path } = attachment as { storage_path: string; file_name: string };

    const { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup } = await import('pdf-lib');
    const { readFile } = await import('fs/promises');

    const pdfBuffer = await readFile(storage_path);
    const pdfDoc = await PDFDocument.load(pdfBuffer);

    const form = pdfDoc.getForm();
    const fields = form.getFields();

    if (fields.length === 0) {
      throw new Error('PDF template has no fillable form fields');
    }

    const fieldInfos = fields.map((f: { getName(): string }) => {
      const name = f.getName();
      let type = 'unknown';
      if (f instanceof PDFTextField) type = 'text';
      else if (f instanceof PDFCheckBox) type = 'checkbox';
      else if (f instanceof PDFDropdown) type = 'dropdown';
      else if (f instanceof PDFRadioGroup) type = 'radio';
      return { name, type };
    });

    const resolvedFields: Record<string, string> = {};
    if (manualFieldMapping) {
      for (const [pdfFieldName, valueTemplate] of Object.entries(manualFieldMapping)) {
        resolvedFields[pdfFieldName] = resolveContextTemplate(valueTemplate, context);
      }
    }

    const unmappedFields = fieldInfos.filter((f) => !(f.name in resolvedFields));

    if (aiAutoMap && unmappedFields.length > 0) {
      try {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const anthropic = new Anthropic();

        const fieldDesc = unmappedFields.map((f) => `"${f.name}" (${f.type})`).join('\n');
        const contextSummary: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(context)) {
          contextSummary[key] = value;
        }

        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          temperature: 0,
          messages: [{
            role: 'user',
            content: `Map PDF form fields to data values. Return ONLY a JSON object like {"field_name": "value"}.\n\nPDF fields:\n${fieldDesc}\n\nAvailable data:\n${JSON.stringify(contextSummary, null, 2)}`,
          }],
        });

        const textBlock = response.content.find((b: { type: string }) => b.type === 'text') as { text: string } | undefined;
        if (textBlock) {
          let jsonStr = textBlock.text.trim();
          const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (jsonMatch) jsonStr = jsonMatch[1].trim();

          const aiMapping = JSON.parse(jsonStr) as Record<string, string>;
          for (const [fieldName, value] of Object.entries(aiMapping)) {
            if (!(fieldName in resolvedFields)) {
              resolvedFields[fieldName] = String(value);
            }
          }
        }
      } catch (err) {
        logger.warn(`[ActionExecutor] AI PDF mapping failed, using manual mappings only: ${err}`);
      }
    }

    let fieldsFilled = 0;
    const warnings: string[] = [];

    for (const [name, value] of Object.entries(resolvedFields)) {
      try {
        const field = form.getField(name);
        if (field instanceof PDFTextField) {
          field.setText(String(value));
          fieldsFilled++;
        } else if (field instanceof PDFCheckBox) {
          if (value === 'true' || value === '1' || value === 'yes') field.check();
          else field.uncheck();
          fieldsFilled++;
        } else if (field instanceof PDFDropdown) {
          field.select(String(value));
          fieldsFilled++;
        } else if (field instanceof PDFRadioGroup) {
          field.select(String(value));
          fieldsFilled++;
        }
      } catch (err) {
        warnings.push(`Couldn't fill "${name}": ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }

    if (flatten) form.flatten();

    const filledBytes = await pdfDoc.save();
    const filledBase64 = Buffer.from(filledBytes).toString('base64');

    logger.info(`[ActionExecutor] Filled PDF: ${fieldsFilled} fields`);

    const output: Record<string, unknown> = {
      filled_pdf_base64: filledBase64,
      fields_filled: fieldsFilled,
      warnings,
    };

    if (config.auto_save === true) {
      const filenameTemplate = (config.save_filename_template as string) || '';
      const filename = filenameTemplate
        ? resolveContextTemplate(filenameTemplate, context)
        : 'filled-pdf.pdf';

      try {
        const { writeFile, mkdir } = await import('fs/promises');
        const { join } = await import('path');

        const dataDir = process.env.DATA_DIR || join(process.cwd(), 'data');
        const dir = join(dataDir, 'files', deps.workspaceId, 'general');
        await mkdir(dir, { recursive: true });

        const filePath = join(dir, `${Date.now()}-${filename}`);
        const buffer = Buffer.from(filledBase64, 'base64');
        await writeFile(filePath, buffer);

        const { data: attachmentRecord } = await deps.db.from('agent_workforce_attachments')
          .insert({
            workspace_id: deps.workspaceId,
            file_name: filename,
            file_type: 'application/pdf',
            file_size: buffer.length,
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
        logger.info(`[ActionExecutor] Auto-saved filled PDF: ${filename} (${buffer.length} bytes)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        output.warnings = [...warnings, `Auto-save failed: ${msg}`];
      }
    }

    return output;
  },
};
