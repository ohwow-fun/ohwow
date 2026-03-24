/**
 * PDF Tools Routes
 * POST /api/pdf-tools/convert — Convert PDF to page images
 * POST /api/pdf-tools/detect  — Detect form fields via Ollama vision
 * POST /api/pdf-tools/generate — Generate AcroForm PDF
 */

import { Router } from 'express';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, platform } from 'os';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib';
import { isLocalhostUrl } from '../../lib/url-validation.js';
import { commandExists, popplerInstallHint } from '../../lib/platform-utils.js';

// ============================================================================
// Types (mirrored from src/lib/services/pdf-form-types.ts)
// ============================================================================

type FormFieldType = 'text' | 'checkbox' | 'dropdown' | 'date' | 'signature';

interface DetectedField {
  id: string;
  label: string;
  type: FormFieldType;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  options?: string[];
}

interface PdfPageImage {
  page: number;
  imageBase64: string;
  widthPx: number;
  heightPx: number;
}

interface PageDimension {
  width: number;
  height: number;
}

// ============================================================================
// Helpers
// ============================================================================

function ensurePoppler(): void {
  if (commandExists('pdftoppm')) return;

  const os = platform();
  if (os === 'darwin') {
    // Auto-install via Homebrew on macOS (no sudo needed)
    if (!commandExists('brew')) {
      throw new Error('PDF processing requires poppler. Install Homebrew first, then run: brew install poppler');
    }
    try {
      execFileSync('brew', ['install', 'poppler'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 });
    } catch {
      throw new Error('PDF processing requires poppler. Run: brew install poppler');
    }
  } else {
    throw new Error(`PDF processing requires poppler. Run: ${popplerInstallHint()}`);
  }
}

function getImageDimensions(base64: string): { widthPx: number; heightPx: number } {
  const buf = Buffer.from(base64, 'base64');
  if (buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { widthPx: buf.readUInt32BE(16), heightPx: buf.readUInt32BE(20) };
  }
  return { widthPx: 2550, heightPx: 3300 };
}

function convertPdfToImages(pdfBase64: string): PdfPageImage[] {
  ensurePoppler();
  const tmp = mkdtempSync(join(tmpdir(), 'pdf-form-'));
  try {
    const pdfPath = join(tmp, 'input.pdf');
    writeFileSync(pdfPath, Buffer.from(pdfBase64, 'base64'));
    execFileSync('pdftoppm', ['-png', '-r', '300', pdfPath, join(tmp, 'page')], {
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const files = readdirSync(tmp).filter((f) => f.startsWith('page') && f.endsWith('.png')).sort();
    return files.map((f, i) => {
      const imageBase64 = readFileSync(join(tmp, f)).toString('base64');
      const dims = getImageDimensions(imageBase64);
      return { page: i, imageBase64, ...dims };
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

function detectMimeType(base64: string): string {
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  if (base64.startsWith('R0lG')) return 'image/gif';
  if (base64.startsWith('UklG')) return 'image/webp';
  return 'image/png';
}

const FIELD_DETECTION_PROMPT = `You are analyzing a form image. Identify ALL fillable fields in this form page.

For each field, provide:
- label: The field label text
- type: One of "text", "checkbox", "dropdown", "date", "signature"
- x: Left edge as percentage of page width (0-100)
- y: Top edge as percentage of page height (0-100)
- width: Field width as percentage of page width (0-100)
- height: Field height as percentage of page height (0-100)
- required: Whether the field appears to be required (true/false)

Respond with a JSON array only. No explanation, no markdown fencing. Example:
[{"label":"Last Name","type":"text","x":10,"y":25,"width":30,"height":3,"required":true}]

If there are no fields on this page, respond with: []`;

async function detectFormFields(
  pageImages: PdfPageImage[],
  ollamaUrl: string,
  model: string,
): Promise<DetectedField[]> {
  const baseUrl = ollamaUrl.replace(/\/$/, '');
  const allFields: DetectedField[] = [];
  const validTypes: FormFieldType[] = ['text', 'checkbox', 'dropdown', 'date', 'signature'];

  for (const page of pageImages) {
    const mimeType = detectMimeType(page.imageBase64);
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${page.imageBase64}` } },
            { type: 'text', text: FIELD_DETECTION_PROMPT },
          ],
        }],
        max_tokens: 4096,
        temperature: 0.1,
        stream: false,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Field detection failed (${response.status}): ${text}`);
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    let content = data.choices?.[0]?.message?.content || '[]';
    if (content.startsWith('```')) {
      content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    try {
      const raw = JSON.parse(content) as Array<Record<string, unknown>>;
      if (!Array.isArray(raw)) continue;
      for (const f of raw) {
        if (f.label && typeof f.x === 'number' && typeof f.y === 'number' && typeof f.width === 'number' && typeof f.height === 'number') {
          allFields.push({
            id: randomUUID(),
            label: f.label as string,
            type: validTypes.includes(f.type as FormFieldType) ? (f.type as FormFieldType) : 'text',
            page: page.page,
            x: clamp(f.x as number, 0, 100),
            y: clamp(f.y as number, 0, 100),
            width: clamp(f.width as number, 1, 100),
            height: clamp(f.height as number, 0.5, 100),
            required: (f.required as boolean) ?? false,
            options: f.options as string[] | undefined,
          });
        }
      }
    } catch {
      // Skip malformed page
    }
  }

  return allFields;
}

async function generateAcroFormPdf(
  originalPdfBase64: string,
  fields: DetectedField[],
  pageDimensions: PageDimension[],
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(Buffer.from(originalPdfBase64, 'base64'));
  const form = pdfDoc.getForm();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();
  const nameSet = new Set<string>();

  for (const field of fields) {
    const page = pages[field.page];
    const pageDim = pageDimensions[field.page];
    if (!page || !pageDim) continue;

    const xPt = (field.x / 100) * pageDim.width;
    const widthPt = (field.width / 100) * pageDim.width;
    const heightPt = (field.height / 100) * pageDim.height;
    const yPt = pageDim.height - (field.y / 100) * pageDim.height - heightPt;

    let name = field.label.replace(/[^a-zA-Z0-9_\s]/g, '').replace(/\s+/g, '_').substring(0, 50) || 'field';
    if (nameSet.has(name)) name = `${name}_${field.id.substring(0, 8)}`;
    nameSet.add(name);

    switch (field.type) {
      case 'checkbox': {
        const cb = form.createCheckBox(name);
        cb.addToPage(page, { x: xPt, y: yPt, width: widthPt, height: heightPt });
        break;
      }
      case 'dropdown': {
        const dd = form.createDropdown(name);
        if (field.options?.length) dd.addOptions(field.options);
        dd.addToPage(page, { x: xPt, y: yPt, width: widthPt, height: heightPt });
        // Appearance is auto-generated by pdf-lib
        break;
      }
      default: {
        const tf = form.createTextField(name);
        tf.addToPage(page, { x: xPt, y: yPt, width: widthPt, height: heightPt, font, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 1 });
        const tooltip = field.type === 'date' ? `${field.label} (MM/DD/YYYY)` : field.label;
        tf.acroField.dict.set(PDFName.of('TU'), PDFString.of(tooltip));
        break;
      }
    }
  }

  return pdfDoc.save();
}

async function getPdfPageDimensions(pdfBase64: string): Promise<PageDimension[]> {
  const pdfDoc = await PDFDocument.load(Buffer.from(pdfBase64, 'base64'));
  return pdfDoc.getPages().map((p: { getWidth(): number; getHeight(): number }) => ({ width: p.getWidth(), height: p.getHeight() }));
}

// ============================================================================
// Routes
// ============================================================================

export function createPdfToolsRouter(): Router {
  const router = Router();

  // Increase body size limit for PDF uploads
  router.use('/api/pdf-tools', (req, res, next) => {
    // express.json already applied globally, but we need raw for FormData
    next();
  });

  router.post('/api/pdf-tools/convert', async (req, res) => {
    try {
      const { pdfBase64 } = req.body as { pdfBase64?: string };
      if (!pdfBase64) {
        res.status(400).json({ error: 'pdfBase64 is required' });
        return;
      }

      const pages = convertPdfToImages(pdfBase64);
      if (pages.length === 0) {
        res.status(500).json({ error: 'No pages could be extracted from the PDF' });
        return;
      }

      const pageDimensions = await getPdfPageDimensions(pdfBase64);
      res.json({ data: { pages, pageDimensions } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Conversion failed' });
    }
  });

  router.post('/api/pdf-tools/detect', async (req, res) => {
    try {
      const { pages, ollamaUrl, model } = req.body as {
        pages?: PdfPageImage[];
        ollamaUrl?: string;
        model?: string;
      };

      if (!pages?.length) {
        res.status(400).json({ error: 'No page images provided' });
        return;
      }
      if (!ollamaUrl || !model) {
        res.status(400).json({ error: 'ollamaUrl and model are required' });
        return;
      }

      // SSRF protection: only allow localhost URLs for Ollama
      if (!isLocalhostUrl(ollamaUrl)) {
        res.status(400).json({ error: 'ollamaUrl must point to a local Ollama instance (localhost)' });
        return;
      }

      const fields = await detectFormFields(pages, ollamaUrl, model);
      res.json({ data: { fields } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Detection failed' });
    }
  });

  router.post('/api/pdf-tools/generate', async (req, res) => {
    try {
      const { originalPdfBase64, fields, pageDimensions } = req.body as {
        originalPdfBase64?: string;
        fields?: DetectedField[];
        pageDimensions?: PageDimension[];
      };

      if (!originalPdfBase64) {
        res.status(400).json({ error: 'originalPdfBase64 is required' });
        return;
      }
      if (!fields?.length) {
        res.status(400).json({ error: 'At least one field is required' });
        return;
      }
      if (!pageDimensions?.length) {
        res.status(400).json({ error: 'pageDimensions are required' });
        return;
      }

      const pdfBytes = await generateAcroFormPdf(originalPdfBase64, fields, pageDimensions);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="form-fillable.pdf"');
      res.send(Buffer.from(pdfBytes));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Generation failed' });
    }
  });

  return router;
}
