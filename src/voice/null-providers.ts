/**
 * Null Providers for Browser-Native Voice Mode
 * Used when STT/TTS is handled entirely in the browser via Web Speech API.
 * These providers report as available but should never be called directly.
 */

import type { STTProvider, STTResult, STTOptions, TTSProvider, TTSResult, TTSOptions } from './types.js';

export class BrowserNativeSTT implements STTProvider {
  readonly name = 'browser-native';
  readonly isLocal = true;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async transcribe(_audio: Buffer, _options?: STTOptions): Promise<STTResult> {
    throw new Error('BrowserNativeSTT should not be called directly; STT is handled in the browser.');
  }
}

export class BrowserNativeTTS implements TTSProvider {
  readonly name = 'browser-native';
  readonly isLocal = true;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async synthesize(_text: string, _options?: TTSOptions): Promise<TTSResult> {
    throw new Error('BrowserNativeTTS should not be called directly; TTS is handled in the browser.');
  }
}
