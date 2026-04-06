/**
 * Media Tools — slide generation, music generation, video generation, and other media helpers.
 */

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { saveMediaBuffer } from '../../media/storage.js';
import { LocalBrowserService } from '../../execution/browser/local-browser.service.js';
import { LyriaOpenRouterBridge } from '../../media/lyria-openrouter-bridge.js';
import { KokoroBridge } from '../../media/kokoro-mcp-bridge.js';
import { logger } from '../../lib/logger.js';

const SLIDE_STYLES: Record<string, { bg: string; text: string; accent: string; font: string }> = {
  modern: { bg: '#1a1a2e', text: '#eaeaea', accent: '#e94560', font: "'Inter', system-ui, sans-serif" },
  minimal: { bg: '#ffffff', text: '#222222', accent: '#0066ff', font: "'Helvetica Neue', Arial, sans-serif" },
  corporate: { bg: '#f0f4f8', text: '#1a365d', accent: '#2b6cb0', font: "'Georgia', serif" },
  creative: { bg: '#fef3c7', text: '#1c1917', accent: '#d97706', font: "'Courier New', monospace" },
};

function buildSlidesHtml(topic: string, slideCount: number, style: string): string {
  const theme = SLIDE_STYLES[style] || SLIDE_STYLES.modern;
  const slides: string[] = [];

  for (let i = 1; i <= slideCount; i++) {
    const isTitle = i === 1;
    const isEnd = i === slideCount;
    slides.push(`
    <section class="slide" id="slide-${i}">
      <div class="slide-content">
        ${isTitle ? `<h1 class="slide-title">${escapeHtml(topic)}</h1><p class="slide-subtitle">Slide ${i} of ${slideCount}</p>` : ''}
        ${isEnd ? '<h2 class="slide-heading">Thank You</h2><p class="slide-body">Questions?</p>' : ''}
        ${!isTitle && !isEnd ? `<h2 class="slide-heading">[Slide ${i} Title]</h2><ul class="slide-body"><li>[Point 1]</li><li>[Point 2]</li><li>[Point 3]</li></ul>` : ''}
        <div class="image-placeholder" data-prompt="[Image description for slide ${i}: visual related to ${escapeHtml(topic)}]">
          <span>Image Placeholder</span>
        </div>
      </div>
    </section>`);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(topic)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; font-family: ${theme.font}; background: ${theme.bg}; color: ${theme.text}; }
  .slide { display: none; width: 100vw; height: 100vh; align-items: center; justify-content: center; padding: 4rem; }
  .slide.active { display: flex; }
  .slide-content { max-width: 900px; width: 100%; text-align: center; }
  .slide-title { font-size: 3rem; margin-bottom: 1rem; color: ${theme.accent}; }
  .slide-subtitle { font-size: 1.4rem; opacity: 0.7; }
  .slide-heading { font-size: 2.2rem; margin-bottom: 1.5rem; color: ${theme.accent}; }
  .slide-body { font-size: 1.3rem; line-height: 1.8; text-align: left; }
  .slide-body li { margin-bottom: 0.5rem; margin-left: 1.5rem; }
  .image-placeholder { margin-top: 2rem; border: 2px dashed ${theme.accent}40; border-radius: 12px; padding: 2rem; opacity: 0.5; font-size: 0.9rem; }
  .nav-hint { position: fixed; bottom: 1rem; right: 1rem; opacity: 0.4; font-size: 0.8rem; }
  .slide-counter { position: fixed; bottom: 1rem; left: 1rem; opacity: 0.4; font-size: 0.8rem; }
</style>
</head>
<body>
${slides.join('\n')}
<div class="nav-hint">Arrow keys or click to navigate</div>
<div class="slide-counter" id="counter"></div>
<script>
  let current = 0;
  const slides = document.querySelectorAll('.slide');
  const counter = document.getElementById('counter');
  function show(i) {
    slides.forEach(s => s.classList.remove('active'));
    current = Math.max(0, Math.min(i, slides.length - 1));
    slides[current].classList.add('active');
    counter.textContent = (current + 1) + ' / ' + slides.length;
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') show(current + 1);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') show(current - 1);
  });
  document.addEventListener('click', () => show(current + 1));
  show(0);
</script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function generateSlides(
  _ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const topic = input.topic as string | undefined;
  if (!topic) {
    return { success: false, error: 'topic is required' };
  }

  const slideCount = Math.min(Math.max(Number(input.slide_count) || 8, 2), 20);
  const style = (input.style as string) || 'modern';

  if (!SLIDE_STYLES[style]) {
    return { success: false, error: `Unknown style "${style}". Use: modern, minimal, corporate, or creative.` };
  }

  const html = buildSlidesHtml(topic, slideCount, style);
  const saved = await saveMediaBuffer(Buffer.from(html, 'utf-8'), 'text/html', 'slides');

  const placeholderCount = slideCount;
  return {
    success: true,
    data: `Presentation template saved to ${saved.path}. Contains ${placeholderCount} slides with image placeholders. To add visuals, generate images for each placeholder prompt and embed them.`,
  };
}

/**
 * Export an HTML slide presentation to PDF using Playwright/Chromium.
 * Renders all slides visible (one per page) in landscape orientation.
 */
export async function exportSlidesToPdf(
  _ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const htmlPath = input.html_path as string | undefined;
  if (!htmlPath) {
    return { success: false, error: 'html_path is required' };
  }

  // Safety: only export files from ~/.ohwow/media/
  const mediaDir = join(homedir(), '.ohwow', 'media');
  if (!htmlPath.startsWith(mediaDir)) {
    return { success: false, error: 'Can only export files from the media directory' };
  }

  let html: string;
  try {
    html = await readFile(htmlPath, 'utf-8');
  } catch {
    return { success: false, error: `Could not read file: ${htmlPath}` };
  }

  // Inject print styles: show all slides, one per page
  const printHtml = html.replace(
    '</head>',
    `<style>
  .slide { display: flex !important; page-break-after: always; height: 100vh; }
  .slide.active { display: flex !important; }
  .nav-hint, .slide-counter { display: none !important; }
  body { overflow: visible !important; }
</style></head>`,
  );

  const browser = new LocalBrowserService({ headless: true });
  try {
    const page = await browser.ensureBrowser();
    await page.setContent(printHtml, { waitUntil: 'networkidle' });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      landscape: true,
      printBackground: true,
    });

    const saved = await saveMediaBuffer(Buffer.from(pdfBuffer), 'application/pdf', 'presentation');
    return { success: true, data: `PDF exported to ${saved.path}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'PDF export failed';
    if (msg.includes("Executable doesn't exist")) {
      return { success: false, error: 'Chromium not installed. Run: npx playwright install chromium' };
    }
    return { success: false, error: msg };
  } finally {
    await browser.close();
  }
}

/**
 * Get or create a LyriaOpenRouterBridge instance.
 * Requires an OpenRouter API key from the model router.
 */
function getLyriaBridge(ctx: LocalToolContext): LyriaOpenRouterBridge | null {
  const apiKey = ctx.modelRouter?.getOpenRouterApiKey();
  if (!apiKey) return null;
  return new LyriaOpenRouterBridge({ apiKey });
}

/**
 * Generate music or sound effects from a text prompt via Google Lyria.
 * Saves output to ~/.ohwow/media/audio/.
 */
export async function generateMusic(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const prompt = input.prompt as string | undefined;
  if (!prompt) {
    return { success: false, error: 'prompt is required' };
  }

  const bridge = getLyriaBridge(ctx);
  if (!bridge) {
    return {
      success: false,
      error: 'Music generation requires an OpenRouter API key. Set it in Settings > Models > OpenRouter.',
    };
  }

  const durationSeconds = Math.min(Math.max(Number(input.duration_seconds) || 15, 5), 30);
  const genre = input.genre as string | undefined;
  const mood = input.mood as string | undefined;
  const bpm = input.bpm ? Math.min(Math.max(Number(input.bpm), 60), 180) : undefined;

  try {
    const result = await bridge.generateMusic({
      prompt,
      durationSeconds,
      genre,
      mood,
      bpm,
    });

    return {
      success: true,
      data: result.message,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Music generation failed';
    logger.error(`[generate_music] ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * Generate a short video from a text prompt via OpenRouter video models.
 * Saves output to ~/.ohwow/media/videos/.
 */
export async function generateVideo(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const prompt = input.prompt as string | undefined;
  if (!prompt) {
    return { success: false, error: 'prompt is required' };
  }

  const bridge = getLyriaBridge(ctx);
  if (!bridge) {
    return {
      success: false,
      error: 'Video generation requires an OpenRouter API key. Set it in Settings > Models > OpenRouter.',
    };
  }

  const durationSeconds = Math.min(Math.max(Number(input.duration_seconds) || 4, 2), 10);
  const aspectRatio = input.aspect_ratio as string || '16:9';

  if (!['16:9', '9:16', '1:1'].includes(aspectRatio)) {
    return { success: false, error: `Invalid aspect ratio "${aspectRatio}". Use 16:9, 9:16, or 1:1.` };
  }

  try {
    const result = await bridge.generateVideo({
      prompt,
      durationSeconds,
      aspectRatio,
    });

    return {
      success: true,
      data: result.message,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Video generation failed';
    logger.error(`[generate_video] ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * Generate speech audio from text. Tries local Kokoro first (free),
 * falls back to OpenRouter cloud TTS. Saves to ~/.ohwow/media/audio/.
 */
export async function generateVoice(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const text = input.text as string | undefined;
  if (!text) {
    return { success: false, error: 'text is required' };
  }

  if (text.length > 5000) {
    return { success: false, error: 'Text too long. Keep it under 5,000 characters per generation.' };
  }

  const voice = input.voice as string | undefined;
  const speed = input.speed ? Math.min(Math.max(Number(input.speed), 0.5), 2.0) : 1.0;

  // Try local Kokoro first (free, fast)
  const kokoro = new KokoroBridge();
  const kokoroAvailable = await kokoro.isAvailable();

  if (kokoroAvailable) {
    try {
      const result = await kokoro.textToSpeech({ text, voice, speed });
      return {
        success: true,
        data: `${result.message} (local Kokoro TTS, free)`,
      };
    } catch (err) {
      logger.warn(`[generate_voice] Kokoro failed, trying cloud fallback: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Fall back to OpenRouter cloud TTS
  const apiKey = ctx.modelRouter?.getOpenRouterApiKey();
  if (!apiKey) {
    return {
      success: false,
      error: kokoroAvailable
        ? 'Local TTS failed and no OpenRouter API key configured for cloud fallback.'
        : 'Kokoro TTS not running locally and no OpenRouter API key configured. Start Kokoro (port 8880) or set an OpenRouter key in Settings.',
    };
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://ohwow.fun',
        'X-Title': 'OHWOW',
      },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model: 'openai/tts-1',
        input: text,
        voice: voice ?? 'alloy',
        speed,
        response_format: 'mp3',
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Cloud TTS failed (${response.status}): ${errText.slice(0, 200)}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    logger.info(`[generate_voice] Cloud TTS generated ${buffer.length} bytes`);

    const saved = await saveMediaBuffer(buffer, 'audio/mpeg', 'voice');
    return {
      success: true,
      data: `Voice audio generated and saved to ${saved.path} (${Math.round(buffer.length / 1024)}KB, cloud TTS)`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Voice generation failed';
    logger.error(`[generate_voice] ${msg}`);
    return { success: false, error: msg };
  }
}
