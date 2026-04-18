/**
 * generate_xlsx dispatcher: build an Excel workbook from a sheet spec using exceljs.
 */

import type { ActionDispatcher, DispatcherDeps } from '../action-dispatcher.js';
import type { ExecutionContext, ActionOutput } from '../automation-types.js';
import { resolveContextTemplate } from '../field-mapper.js';
import { logger } from '../../lib/logger.js';

export type XlsxCellValue = string | number | boolean | Date | null;

export interface XlsxSheetSpec {
  name: string;
  headers?: string[];
  rows: XlsxCellValue[][];
  column_widths?: number[];
}

export interface XlsxSpec {
  title?: string;
  author?: string;
  sheets: XlsxSheetSpec[];
  filename?: string;
  auto_save?: boolean;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const generateXlsxDispatcher: ActionDispatcher = {
  actionType: 'generate_xlsx',

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
    deps: DispatcherDeps,
  ): Promise<ActionOutput> {
    const sheets = config.sheets as XlsxSheetSpec[] | undefined;
    if (!Array.isArray(sheets) || sheets.length === 0) {
      throw new Error('generate_xlsx requires at least one sheet in config.sheets');
    }

    const workbookTitle = config.title as string | undefined;
    const workbookAuthor = config.author as string | undefined;
    const filenameTemplate = config.filename as string | undefined;
    const autoSave = config.auto_save === true;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ExcelJS = (await import('exceljs')).default as any;
    const workbook = new ExcelJS.Workbook();

    workbook.creator = workbookAuthor ?? 'ohwow';
    if (workbookTitle) workbook.title = workbookTitle;

    const warnings: string[] = [];
    let totalRowCount = 0;

    for (const sheetSpec of sheets) {
      const sheet = workbook.addWorksheet(sheetSpec.name);

      if (Array.isArray(sheetSpec.headers) && sheetSpec.headers.length > 0) {
        sheet.addRow(sheetSpec.headers);
        sheet.getRow(1).font = { bold: true };
      }

      if (Array.isArray(sheetSpec.rows)) {
        for (const row of sheetSpec.rows) {
          sheet.addRow(row);
        }
        totalRowCount += sheetSpec.rows.length;
      }

      if (Array.isArray(sheetSpec.column_widths)) {
        sheetSpec.column_widths.forEach((width, i) => {
          sheet.getColumn(i + 1).width = width;
        });
      }
    }

    const raw = await workbook.xlsx.writeBuffer();
    let xlsxBuffer: Buffer;
    if (Buffer.isBuffer(raw)) {
      xlsxBuffer = raw;
    } else if (raw instanceof Uint8Array) {
      xlsxBuffer = Buffer.from(raw);
    } else if (raw instanceof ArrayBuffer) {
      xlsxBuffer = Buffer.from(new Uint8Array(raw));
    } else {
      xlsxBuffer = Buffer.from(raw as ArrayBuffer);
    }
    const xlsxBase64 = xlsxBuffer.toString('base64');

    logger.info(`[ActionExecutor] Generated XLSX: ${sheets.length} sheets, ${totalRowCount} rows, ${xlsxBuffer.length} bytes`);

    const output: ActionOutput = {
      xlsx_base64: xlsxBase64,
      sheet_count: sheets.length,
      row_count: totalRowCount,
      warnings,
    };

    if (autoSave) {
      const filename = filenameTemplate
        ? resolveContextTemplate(filenameTemplate, context)
        : 'workbook.xlsx';

      try {
        const { writeFile, mkdir } = await import('fs/promises');
        const { join } = await import('path');

        const dataDir = process.env.DATA_DIR || join(process.cwd(), 'data');
        const dir = join(dataDir, 'files', deps.workspaceId, 'general');
        await mkdir(dir, { recursive: true });

        const filePath = join(dir, `${Date.now()}-${filename}`);
        await writeFile(filePath, xlsxBuffer);

        const { data: attachmentRecord } = await deps.db.from('agent_workforce_attachments')
          .insert({
            workspace_id: deps.workspaceId,
            file_name: filename,
            file_type: XLSX_MIME,
            file_size: xlsxBuffer.length,
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
        output.mime_type = XLSX_MIME;
        logger.info(`[ActionExecutor] Auto-saved XLSX: ${filename} (${xlsxBuffer.length} bytes)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        output.warnings = [...warnings, `Auto-save failed: ${msg}`];
      }
    }

    return output;
  },
};
