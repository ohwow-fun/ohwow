/**
 * End-to-end test for the office document primitives (PPTX / XLSX / DOCX).
 *
 * Builds one of each in-memory via the real dispatchers, writes the buffers to
 * a temp directory, checks ZIP magic + format-specific OOXML parts, and — if
 * LibreOffice is installed locally — converts each file to PDF via `soffice
 * --headless` and asserts the PDF is well-formed.
 *
 * When `soffice` / `libreoffice` is not on PATH and not at any of the standard
 * install locations, the convert step is skipped with a console.info marker so
 * the test still exercises the generators and passes on CI / dev boxes without
 * LibreOffice.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { generatePptxDispatcher } from '../dispatchers/generate-pptx.js';
import { generateXlsxDispatcher } from '../dispatchers/generate-xlsx.js';
import { generateDocxDispatcher } from '../dispatchers/generate-docx.js';
import type { DispatcherDeps } from '../action-dispatcher.js';
import type { LocalTrigger } from '../../webhooks/ghl-types.js';

const deps = {} as DispatcherDeps;
const trigger = { id: 'test-trigger', name: 'test' } as LocalTrigger;

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04
const PDF_MAGIC = Buffer.from('%PDF');

function findSoffice(): string | null {
  const candidates = [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/opt/homebrew/bin/soffice',
    '/usr/local/bin/soffice',
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  const r = spawnSync('sh', ['-c', 'command -v soffice || command -v libreoffice'], {
    encoding: 'utf8',
  });
  const out = (r.stdout || '').trim();
  return out || null;
}

describe('generate-office-e2e', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ohwow-office-e2e-'));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it(
    'produces valid PPTX + XLSX + DOCX; converts to PDF via LibreOffice when available',
    { timeout: 90_000 },
    async () => {
      // ---- PPTX ----
      const pptxConfig = {
        title: 'E2E Deck',
        author: 'ohwow-e2e',
        slides: [
          { title: 'Overview', bullets: ['first point', 'second point'] },
          { title: 'Next steps', bullets: ['ship it'] },
        ],
        auto_save: false,
      };
      const pptxOut = await generatePptxDispatcher.execute(pptxConfig, {}, deps, trigger);
      expect(pptxOut.slide_count).toBe(2);
      const pptxBuffer = Buffer.from(pptxOut.pptx_base64 as string, 'base64');
      const pptxPath = join(tmp, 'deck.pptx');
      writeFileSync(pptxPath, pptxBuffer);
      expect(pptxBuffer.length).toBeGreaterThan(0);
      expect(pptxBuffer.subarray(0, 4).equals(ZIP_MAGIC)).toBe(true);
      expect(pptxBuffer.includes(Buffer.from('ppt/presentation.xml'))).toBe(true);

      // ---- XLSX ----
      const xlsxConfig = {
        title: 'E2E Workbook',
        author: 'ohwow-e2e',
        sheets: [
          {
            name: 'Sheet1',
            headers: ['name', 'count'],
            rows: [
              ['alpha', 1],
              ['beta', 2],
            ],
          },
        ],
        auto_save: false,
      };
      const xlsxOut = await generateXlsxDispatcher.execute(xlsxConfig, {}, deps, trigger);
      expect(xlsxOut.sheet_count).toBe(1);
      expect(xlsxOut.row_count).toBe(2);
      const xlsxBuffer = Buffer.from(xlsxOut.xlsx_base64 as string, 'base64');
      const xlsxPath = join(tmp, 'book.xlsx');
      writeFileSync(xlsxPath, xlsxBuffer);
      expect(xlsxBuffer.length).toBeGreaterThan(0);
      expect(xlsxBuffer.subarray(0, 4).equals(ZIP_MAGIC)).toBe(true);
      expect(xlsxBuffer.includes(Buffer.from('xl/workbook.xml'))).toBe(true);

      // ---- DOCX ----
      const docxConfig = {
        title: 'E2E Document',
        author: 'ohwow-e2e',
        blocks: [
          { type: 'heading', level: 1, text: 'End-to-end coverage' },
          {
            type: 'paragraph',
            runs: [
              { text: 'This doc was produced by ' },
              { text: 'generateDocxDispatcher', bold: true },
              { text: ' during the e2e suite.' },
            ],
          },
          { type: 'bullets', items: ['ZIP magic verified', 'word/document.xml present'] },
        ],
        auto_save: false,
      };
      const docxOut = await generateDocxDispatcher.execute(docxConfig, {}, deps, trigger);
      expect(docxOut.block_count).toBe(3);
      const docxBuffer = Buffer.from(docxOut.docx_base64 as string, 'base64');
      const docxPath = join(tmp, 'doc.docx');
      writeFileSync(docxPath, docxBuffer);
      expect(docxBuffer.length).toBeGreaterThan(0);
      expect(docxBuffer.subarray(0, 4).equals(ZIP_MAGIC)).toBe(true);
      expect(docxBuffer.includes(Buffer.from('word/document.xml'))).toBe(true);

      // ---- Optional: LibreOffice PDF conversion ----
      const soffice = findSoffice();
      if (!soffice) {
        // eslint-disable-next-line no-console
        console.info('[e2e] soffice not available, skipping LibreOffice convert step');
        return;
      }

      for (const src of [pptxPath, xlsxPath, docxPath]) {
        const result = spawnSync(
          soffice,
          ['--headless', '--convert-to', 'pdf', '--outdir', tmp, src],
          { timeout: 60_000, encoding: 'utf8' },
        );
        expect(result.status).toBe(0);

        const pdfPath = src.replace(/\.(pptx|xlsx|docx)$/i, '.pdf');
        expect(existsSync(pdfPath)).toBe(true);

        const pdfBuffer = readFileSync(pdfPath);
        expect(pdfBuffer.length).toBeGreaterThan(0);
        expect(pdfBuffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
      }
    },
  );
});
