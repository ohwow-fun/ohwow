/**
 * Audio Transcription Tool
 * Transcribes audio files using the best available STT provider,
 * with optional LLM analysis of the transcript.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import type { STTProvider } from '../../voice/types.js';
import { VoiceboxSTTProvider } from '../../voice/voicebox-stt-provider.js';
import { GemmaAudioProvider, WhisperLocalProvider, WhisperAPIProvider } from '../../voice/stt-providers.js';
import { logger } from '../../lib/logger.js';

/** Supported audio MIME types and their base64 magic-byte prefixes. */
const AUDIO_MAGIC: Array<{ prefix: string; mime: string }> = [
  { prefix: 'UklGR', mime: 'audio/wav' },   // RIFF (WAV)
  { prefix: '//uQx', mime: 'audio/mp3' },   // MP3 (common)
  { prefix: 'SUQz', mime: 'audio/mp3' },    // MP3 (ID3v2)
  { prefix: 'T2dn', mime: 'audio/ogg' },    // OGG
  { prefix: 'GkXf', mime: 'audio/webm' },   // WebM
  { prefix: 'AAAAGGZ0', mime: 'audio/mp4' }, // M4A (ftyp box)
];

function detectAudioMime(base64: string): string {
  for (const { prefix, mime } of AUDIO_MAGIC) {
    if (base64.startsWith(prefix)) return mime;
  }
  return 'audio/wav'; // default assumption
}

/** Find the best available STT provider from the cascade. */
async function getBestProvider(ctx: LocalToolContext): Promise<STTProvider | null> {
  const candidates: STTProvider[] = [
    new VoiceboxSTTProvider(),
  ];

  // Add Ollama-based providers if URL is configured
  const ollamaUrl = ctx.ollamaUrl || 'http://localhost:11434';
  candidates.push(
    new GemmaAudioProvider(ollamaUrl, 'gemma4:e2b'),
    new WhisperLocalProvider(ollamaUrl),
  );

  // Add OpenAI Whisper API if we have an API key
  // Check for OpenAI key in engine config
  const engineConfig = (ctx.engine as unknown as { config?: { openaiApiKey?: string } })?.config;
  if (engineConfig?.openaiApiKey) {
    candidates.push(new WhisperAPIProvider(engineConfig.openaiApiKey));
  }

  for (const provider of candidates) {
    try {
      if (await provider.isAvailable()) {
        return provider;
      }
    } catch {
      // Skip unavailable providers silently
    }
  }

  return null;
}

/**
 * Transcribe audio and optionally analyze the transcript with an LLM.
 */
export async function transcribeAudio(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const audioBase64 = input.audio_base64 as string | undefined;
  if (!audioBase64) {
    return {
      success: false,
      error: 'audio_base64 is required. Provide base64-encoded audio data (WAV, MP3, OGG, WebM, or M4A).',
    };
  }

  // Basic validation
  const raw = audioBase64.replace(/^data:[^;]+;base64,/, '');
  if (raw.length < 100) {
    return {
      success: false,
      error: `Audio data is too short (${raw.length} chars). Provide actual base64-encoded audio file data.`,
    };
  }

  const language = input.language as string | undefined;
  const analysisPrompt = input.prompt as string | undefined;

  // Find provider
  const provider = await getBestProvider(ctx);
  if (!provider) {
    return {
      success: false,
      error: 'No speech-to-text provider available. Start Voicebox, pull a Whisper model in Ollama, or configure an OpenAI API key.',
    };
  }

  try {
    // Decode audio
    const audioBuffer = Buffer.from(raw, 'base64');
    const mime = detectAudioMime(raw);

    logger.info({ provider: provider.name, size: audioBuffer.length, mime }, '[Audio] Transcribing');

    // Transcribe
    const sttResult = await provider.transcribe(audioBuffer, {
      language,
      prompt: analysisPrompt ? 'Transcribe accurately.' : undefined,
    });

    const transcript = sttResult.text;

    if (!transcript || transcript.trim().length === 0) {
      return {
        success: true,
        data: {
          transcript: '',
          provider: provider.name,
          message: 'No speech detected in the audio.',
        },
      };
    }

    // Optional analysis step
    let analysis: string | undefined;
    if (analysisPrompt && ctx.modelRouter) {
      try {
        const chatProvider = await ctx.modelRouter.getProvider('agent_task');
        const response = await chatProvider.createMessage({
          messages: [
            {
              role: 'user',
              content: `Here is a transcript of an audio recording:\n\n---\n${transcript}\n---\n\n${analysisPrompt}`,
            },
          ],
          maxTokens: 4096,
          temperature: 0.3,
        });
        analysis = response.content;
      } catch (err) {
        logger.warn({ err }, '[Audio] Analysis step failed, returning transcript only');
      }
    }

    return {
      success: true,
      data: {
        transcript,
        analysis: analysis || undefined,
        provider: provider.name,
        language: sttResult.language || language,
        confidence: sttResult.confidence,
        durationMs: sttResult.durationMs,
        segments: sttResult.segments || undefined,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Audio transcription failed';
    logger.error({ err }, '[Audio] Transcription failed');
    return { success: false, error: message };
  }
}
