/**
 * Web Speech API Wrappers
 * Browser-native STT (SpeechRecognition) and TTS (SpeechSynthesis).
 * Used as Tier 1 fallback when no backend voice providers are available.
 */

// ---------------------------------------------------------------------------
// Speech-to-Text (SpeechRecognition)
// ---------------------------------------------------------------------------

type SpeechRecognitionConstructor = new () => SpeechRecognition;

function getSpeechRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

export interface WebSTT {
  start(): void;
  stop(): void;
  onResult(cb: (text: string, isFinal: boolean) => void): void;
  onError(cb: (error: string) => void): void;
  isSupported: boolean;
}

export function createWebSTT(lang = 'en-US'): WebSTT {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    return {
      isSupported: false,
      start() {},
      stop() {},
      onResult() {},
      onError() {},
    };
  }

  const recognition = new Ctor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = lang;

  let resultCb: ((text: string, isFinal: boolean) => void) | null = null;
  let errorCb: ((error: string) => void) | null = null;

  recognition.onresult = (event: SpeechRecognitionEvent) => {
    if (!resultCb) return;
    const last = event.results[event.results.length - 1];
    if (last) {
      resultCb(last[0].transcript, last.isFinal);
    }
  };

  recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      errorCb?.(event.error);
    }
  };

  // Auto-restart on unexpected end (browser may stop after silence)
  recognition.onend = () => {
    try {
      recognition.start();
    } catch {
      // Already started or page unloading
    }
  };

  return {
    isSupported: true,
    start() {
      try { recognition.start(); } catch { /* already started */ }
    },
    stop() {
      recognition.onend = null; // Prevent auto-restart
      try { recognition.stop(); } catch { /* already stopped */ }
    },
    onResult(cb) { resultCb = cb; },
    onError(cb) { errorCb = cb; },
  };
}

// ---------------------------------------------------------------------------
// Text-to-Speech (SpeechSynthesis)
// ---------------------------------------------------------------------------

export interface WebTTS {
  speak(text: string): void;
  stop(): void;
  isSpeaking(): boolean;
  onStart(cb: () => void): void;
  onEnd(cb: () => void): void;
  isSupported: boolean;
}

export function createWebTTS(): WebTTS {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    return {
      isSupported: false,
      speak() {},
      stop() {},
      isSpeaking: () => false,
      onStart() {},
      onEnd() {},
    };
  }

  const synth = window.speechSynthesis;
  let startCb: (() => void) | null = null;
  let endCb: (() => void) | null = null;

  return {
    isSupported: true,
    speak(text: string) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.onstart = () => startCb?.();
      utterance.onend = () => endCb?.();
      utterance.onerror = () => endCb?.();
      synth.speak(utterance);
    },
    stop() {
      synth.cancel();
    },
    isSpeaking: () => synth.speaking,
    onStart(cb) { startCb = cb; },
    onEnd(cb) { endCb = cb; },
  };
}
