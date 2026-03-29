/**
 * Orchestrator OCR Tool
 * Extracts text from images and PDFs using a local OCR model (DeepSeek OCR) via Ollama.
 * PDF support: converts pages to images via pdftoppm (poppler), then OCRs each page.
 */

import { writeFileSync, readFileSync, mkdtempSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, platform } from 'os';
import { execFileSync, execSync } from 'child_process';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import type { MessageContentPart } from '../../execution/model-router.js';
import { commandExists, popplerInstallHint } from '../../lib/platform-utils.js';

/** Known base64 magic-byte prefixes for supported file types. */
const IMAGE_MAGIC_PREFIXES = ['/9j/', 'iVBOR', 'R0lG', 'UklG']; // JPEG, PNG, GIF, WebP
const PDF_MAGIC_PREFIX = 'JVBERi'; // %PDF

/** Validate that a base64 input looks like real file data, not garbage or empty strings. */
function validateBase64Input(
  data: string,
  kind: 'image' | 'pdf',
): string | null {
  if (data.length < 100) {
    return `The ${kind}_base64 data is too short to be a real file (${data.length} chars). Provide actual base64-encoded file data.`;
  }

  // Strip optional data-URI prefix before checking
  const raw = data.replace(/^data:[^;]+;base64,/, '');

  // Quick base64 format check (first 100 chars should be valid base64 alphabet)
  if (!/^[A-Za-z0-9+/\n\r]+=*$/.test(raw.slice(0, 200))) {
    return `The ${kind}_base64 data doesn't look like valid base64 encoding. Provide properly base64-encoded file data.`;
  }

  if (kind === 'pdf') {
    if (!raw.startsWith(PDF_MAGIC_PREFIX)) {
      return 'The pdf_base64 data doesn\'t start with a PDF header (%PDF). Make sure you\'re providing a real PDF file encoded as base64.';
    }
  } else {
    const looksLikeImage = IMAGE_MAGIC_PREFIXES.some(p => raw.startsWith(p));
    if (!looksLikeImage) {
      return 'The image_base64 data doesn\'t match any known image format (JPEG, PNG, GIF, WebP). Make sure you\'re providing a real image file encoded as base64.';
    }
  }

  return null; // valid
}

const OUTPUT_FORMAT_PROMPTS: Record<string, string> = {
  text: 'Extract all text from this image. Return only the raw text content, preserving the reading order.',
  markdown: 'Extract all text from this image and format it as Markdown. Preserve headings, lists, tables, and structure.',
  json: 'Extract all text from this image and return it as a JSON object with fields like "title", "body", "tables" (as arrays), and "metadata" as appropriate.',
};

/** Detect image MIME type from the first bytes of base64 data. */
function detectMimeType(base64: string): string {
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  if (base64.startsWith('R0lG')) return 'image/gif';
  if (base64.startsWith('UklG')) return 'image/webp';
  return 'image/png';
}

/** Convert a PDF (base64) to an array of page images (base64 PNG). */
function pdfToImages(pdfBase64: string, maxPages?: number): string[] {
  const tmp = mkdtempSync(join(tmpdir(), 'ocr-pdf-'));
  try {
    const pdfPath = join(tmp, 'input.pdf');
    writeFileSync(pdfPath, Buffer.from(pdfBase64, 'base64'));

    const outputPrefix = join(tmp, 'page');
    const args = ['-png', '-r', '300'];
    if (maxPages) args.push('-l', String(maxPages));
    args.push(pdfPath, outputPrefix);
    execFileSync('pdftoppm', args, {
      timeout: 60_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Read generated page images, sorted by name
    const files = readdirSync(tmp)
      .filter(f => f.startsWith('page') && f.endsWith('.png'))
      .sort();

    return files.map(f => readFileSync(join(tmp, f)).toString('base64'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Ensure pdftoppm (poppler) is available, auto-installing on macOS only. */
async function ensurePoppler(): Promise<void> {
  if (commandExists('pdftoppm')) return;

  const os = platform();

  if (os === 'darwin') {
    if (!commandExists('brew')) {
      throw new Error('PDF processing requires poppler. Install Homebrew first, then run: brew install poppler');
    }
    try {
      execSync('brew install poppler', { stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 });
    } catch (err) {
      throw new Error(`Couldn't install poppler via Homebrew: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
    if (!commandExists('pdftoppm')) {
      throw new Error('Poppler was installed but pdftoppm is still not available. Check your PATH.');
    }
  } else {
    throw new Error(`PDF processing requires poppler. Run: ${popplerInstallHint()}`);
  }
}

/** OCR a single image via the model router. */
async function ocrSingleImage(
  ctx: LocalToolContext,
  imageBase64: string,
  prompt: string,
): Promise<{ content: string; inputTokens: number; outputTokens: number; model: string }> {
  const provider = await ctx.modelRouter!.getProvider('ocr');
  const mimeType = detectMimeType(imageBase64);

  const imageContent: MessageContentPart[] = [
    { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
    { type: 'text', text: prompt },
  ];

  const response = await provider.createMessage({
    messages: [{ role: 'user', content: imageContent }],
    maxTokens: 4096,
    temperature: 0.1,
  });

  return {
    content: response.content,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    model: response.model,
  };
}

/**
 * Extract text from an image or PDF using the local OCR model.
 */
export async function ocrExtractText(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const imageBase64 = input.image_base64 as string | undefined;
  const pdfBase64 = input.pdf_base64 as string | undefined;

  if (!imageBase64 && !pdfBase64) {
    return { success: false, error: 'Either image_base64 or pdf_base64 is required. This tool needs actual base64-encoded file data — don\'t call it speculatively.' };
  }

  // Validate base64 input before any file I/O
  if (pdfBase64) {
    const pdfError = validateBase64Input(pdfBase64, 'pdf');
    if (pdfError) return { success: false, error: pdfError };
  }
  if (imageBase64) {
    const imgError = validateBase64Input(imageBase64, 'image');
    if (imgError) return { success: false, error: imgError };
  }

  const outputFormat = (input.output_format as string) || 'markdown';
  const prompt = OUTPUT_FORMAT_PROMPTS[outputFormat] || OUTPUT_FORMAT_PROMPTS.markdown;

  if (!ctx.modelRouter) {
    return { success: false, error: 'Model router not available. OCR requires Ollama to be configured.' };
  }

  try {
    // PDF path: convert pages to images, OCR each
    if (pdfBase64) {
      await ensurePoppler();

      const maxPages = typeof input.max_pages === 'number' ? input.max_pages : 20;
      const pageImages = pdfToImages(pdfBase64, maxPages);

      if (pageImages.length === 0) {
        return { success: false, error: 'No pages could be extracted from the PDF' };
      }

      const results: string[] = [];
      let totalInput = 0;
      let totalOutput = 0;
      let model = '';

      for (let i = 0; i < pageImages.length; i++) {
        const pagePrompt = pageImages.length > 1
          ? `${prompt}\n\nThis is page ${i + 1} of ${pageImages.length}.`
          : prompt;

        const result = await ocrSingleImage(ctx, pageImages[i], pagePrompt);
        results.push(result.content);
        totalInput += result.inputTokens;
        totalOutput += result.outputTokens;
        model = result.model;
      }

      const separator = outputFormat === 'text' ? '\n\n' : '\n\n---\n\n';
      const combined = pageImages.length > 1
        ? results.map((r, i) => `## Page ${i + 1}\n\n${r}`).join(separator)
        : results[0];

      return {
        success: true,
        data: {
          text: combined,
          format: outputFormat,
          pages: pageImages.length,
          model,
          tokens: { input: totalInput, output: totalOutput },
        },
      };
    }

    // Image path: single image OCR
    const result = await ocrSingleImage(ctx, imageBase64!, prompt);

    return {
      success: true,
      data: {
        text: result.content,
        format: outputFormat,
        model: result.model,
        tokens: { input: result.inputTokens, output: result.outputTokens },
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'OCR extraction failed';
    return { success: false, error: message };
  }
}

// ============================================================================
// IMAGE ANALYSIS
// ============================================================================

const ANALYSIS_PROMPTS: Record<string, string> = {
  describe: 'Describe this image in detail. What do you see? Include colors, objects, people, text, layout, and any notable features.',
  objects: 'List all distinct objects, people, and elements visible in this image. Be specific about quantities and positions.',
  screenshot: 'Analyze this screenshot. Describe the application or website shown, the UI elements visible, any text content, and the current state of the interface.',
  general: 'Analyze this image and describe what you see. Provide a clear, detailed description.',
};

/**
 * Analyze an image using the local vision model (DeepSeek OCR).
 * Supports different analysis types: describe, objects, screenshot, general.
 */
export async function analyzeImage(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const imageBase64 = input.image_base64 as string | undefined;

  if (!imageBase64) {
    return { success: false, error: 'image_base64 is required. Provide actual base64-encoded image data.' };
  }

  const imgError = validateBase64Input(imageBase64, 'image');
  if (imgError) return { success: false, error: imgError };

  if (!ctx.modelRouter) {
    return { success: false, error: 'No vision-capable model available. Configure an OCR model, use a vision-capable local model, or add an Anthropic API key.' };
  }

  const analysisType = (input.analysis_type as string) || 'general';
  const customPrompt = input.prompt as string | undefined;
  const prompt = customPrompt || ANALYSIS_PROMPTS[analysisType] || ANALYSIS_PROMPTS.general;

  try {
    const provider = await ctx.modelRouter.getProvider('vision');
    const mimeType = detectMimeType(imageBase64);

    const imageContent: MessageContentPart[] = [
      { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
      { type: 'text', text: prompt },
    ];

    const response = await provider.createMessage({
      messages: [{ role: 'user', content: imageContent }],
      maxTokens: 4096,
      temperature: 0.3,
    });

    return {
      success: true,
      data: {
        analysis: response.content,
        analysis_type: analysisType,
        model: response.model,
        tokens: { input: response.inputTokens, output: response.outputTokens },
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Image analysis failed';
    return { success: false, error: message };
  }
}
