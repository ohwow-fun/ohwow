/**
 * useHandGestures
 * Runs MediaPipe GestureRecognizer on a shared <video> element to detect
 * hand gestures in real-time. Emits debounced gesture events for action mapping.
 *
 * Built-in gestures: Open_Palm, Closed_Fist, Pointing_Up, Thumb_Up,
 * Thumb_Down, Victory, ILoveYou, None.
 *
 * The recognizer instance is a module-level singleton (expensive to create,
 * never destroyed). The rAF loop starts/stops based on `enabled`.
 */

import { useState, useRef, useCallback, useEffect } from 'react';

// ============================================================================
// TYPES
// ============================================================================

/** A normalized 3D landmark (x, y, z in [0, 1] relative to image dimensions) */
interface NormalizedLandmark {
  x: number;
  y: number;
  z: number;
}

export interface HandGesture {
  /** Gesture name: 'Thumb_Up', 'Open_Palm', etc. */
  name: string;
  /** Detection confidence 0-1 */
  confidence: number;
  /** Which hand */
  handedness: 'Left' | 'Right';
  /** 21 hand landmarks for overlay drawing */
  landmarks: NormalizedLandmark[];
}

interface UseHandGesturesOptions {
  /** The video element to read frames from */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Whether gesture recognition is enabled */
  enabled?: boolean;
  /** Target FPS for recognition. Default: 10 */
  targetFps?: number;
  /** Minimum confidence to consider a gesture. Default: 0.65 */
  minConfidence?: number;
  /** Called when a gesture passes sustained-hold + cooldown checks */
  onGesture?: (gesture: HandGesture) => void;
}

export interface UseHandGesturesReturn {
  /** Whether the recognizer has loaded and is running */
  isReady: boolean;
  /** Current gesture (null if no hand or 'None') */
  currentGesture: HandGesture | null;
  /** All detected hand landmarks for overlay drawing */
  landmarks: NormalizedLandmark[][] | null;
  /** Error message if model failed to load */
  error: string | null;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_TARGET_FPS = 10;
const DEFAULT_MIN_CONFIDENCE = 0.65;

/** Consecutive frames of the same gesture required before firing onGesture */
const SUSTAINED_HOLD_FRAMES = 3;

/** Per-gesture cooldown (ms) after firing onGesture */
const GESTURE_COOLDOWNS: Record<string, number> = {
  Open_Palm: 1500,
  Thumb_Up: 3000,
  Thumb_Down: 3000,
  Pointing_Up: 2000,
  Victory: 5000,
  ILoveYou: 5000,
};

const DEFAULT_COOLDOWN = 2000;

/** If inference takes longer than this (ms), halve the FPS */
const SLOW_FRAME_THRESHOLD = 120;
const MIN_FPS = 3;

// WASM files served from jsdelivr
const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm';
// Model hosted by Google
const MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task';

// ============================================================================
// MODULE-LEVEL SINGLETON
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let recognizerInstance: any = null;
let recognizerLoading = false;
let recognizerError: string | null = null;
const loadCallbacks: Array<() => void> = [];

async function getRecognizer(): Promise<unknown> {
  if (recognizerInstance) return recognizerInstance;
  if (recognizerError) throw new Error(recognizerError);

  if (recognizerLoading) {
    return new Promise<unknown>((resolve, reject) => {
      loadCallbacks.push(() => {
        if (recognizerInstance) resolve(recognizerInstance);
        else reject(new Error(recognizerError || 'Load failed'));
      });
    });
  }

  recognizerLoading = true;

  try {
    const vision = await import('@mediapipe/tasks-vision');
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM_CDN);
    recognizerInstance = await vision.GestureRecognizer.createFromModelPath(fileset, MODEL_PATH);
    await recognizerInstance.setOptions({ runningMode: 'VIDEO' });
    recognizerLoading = false;
    console.info('[HandGestures] GestureRecognizer loaded');
    loadCallbacks.forEach(cb => cb());
    loadCallbacks.length = 0;
    return recognizerInstance;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load gesture model';
    recognizerError = msg;
    recognizerLoading = false;
    loadCallbacks.forEach(cb => cb());
    loadCallbacks.length = 0;
    throw err;
  }
}

// ============================================================================
// HOOK
// ============================================================================

export function useHandGestures(options: UseHandGesturesOptions): UseHandGesturesReturn {
  const {
    videoRef,
    enabled = false,
    targetFps = DEFAULT_TARGET_FPS,
    minConfidence = DEFAULT_MIN_CONFIDENCE,
    onGesture,
  } = options;

  const [isReady, setIsReady] = useState(!!recognizerInstance);
  const [currentGesture, setCurrentGesture] = useState<HandGesture | null>(null);
  const [landmarks, setLandmarks] = useState<NormalizedLandmark[][] | null>(null);
  const [error, setError] = useState<string | null>(recognizerError);

  const rafRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef(0);
  const adaptiveFpsRef = useRef(targetFps);
  const onGestureRef = useRef(onGesture);
  const minConfidenceRef = useRef(minConfidence);

  const sustainedRef = useRef<{ name: string; count: number }>({ name: '', count: 0 });
  const cooldownRef = useRef<Record<string, number>>({});

  useEffect(() => { onGestureRef.current = onGesture; });
  useEffect(() => { minConfidenceRef.current = minConfidence; }, [minConfidence]);
  useEffect(() => { adaptiveFpsRef.current = targetFps; }, [targetFps]);

  // --------------------------------------------------------------------------
  // RECOGNITION LOOP
  // --------------------------------------------------------------------------

  const runLoop = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recognizer = recognizerInstance as any;
    if (!recognizer) return;

    const tick = () => {
      if (!videoRef.current || document.hidden) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const now = performance.now();
      const frameInterval = 1000 / adaptiveFpsRef.current;

      if (now - lastFrameTimeRef.current < frameInterval) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const video = videoRef.current;
      if (video.readyState < 2) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const inferStart = performance.now();
      let result;
      try {
        result = recognizer.recognizeForVideo(video, now);
      } catch {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const inferTime = performance.now() - inferStart;
      lastFrameTimeRef.current = now;

      if (inferTime > SLOW_FRAME_THRESHOLD && adaptiveFpsRef.current > MIN_FPS) {
        adaptiveFpsRef.current = Math.max(MIN_FPS, Math.floor(adaptiveFpsRef.current / 2));
        console.warn(`[HandGestures] Slowing down — inference ${Math.round(inferTime)}ms, new FPS: ${adaptiveFpsRef.current}`);
      }

      const allLandmarks: NormalizedLandmark[][] = result.landmarks ?? [];
      setLandmarks(allLandmarks.length > 0 ? allLandmarks : null);

      const gestures = result.gestures;
      const handedness = result.handedness;

      if (!gestures || gestures.length === 0 || !gestures[0] || gestures[0].length === 0) {
        setCurrentGesture(null);
        sustainedRef.current = { name: '', count: 0 };
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const topGesture = gestures[0][0];
      const gestureName: string = topGesture.categoryName ?? topGesture.displayName ?? '';
      const gestureScore: number = topGesture.score ?? 0;

      if (gestureName === 'None' || gestureScore < minConfidenceRef.current) {
        setCurrentGesture(null);
        sustainedRef.current = { name: '', count: 0 };
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const hand = handedness?.[0]?.[0]?.categoryName === 'Right' ? 'Right' as const : 'Left' as const;
      const gesture: HandGesture = {
        name: gestureName,
        confidence: gestureScore,
        handedness: hand,
        landmarks: allLandmarks[0] ?? [],
      };

      setCurrentGesture(gesture);

      if (sustainedRef.current.name === gestureName) {
        sustainedRef.current.count++;
      } else {
        sustainedRef.current = { name: gestureName, count: 1 };
      }

      if (sustainedRef.current.count >= SUSTAINED_HOLD_FRAMES) {
        const lastFired = cooldownRef.current[gestureName] || 0;
        const cooldown = GESTURE_COOLDOWNS[gestureName] ?? DEFAULT_COOLDOWN;

        if (now - lastFired > cooldown) {
          cooldownRef.current[gestureName] = now;
          onGestureRef.current?.(gesture);
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [videoRef]);

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    queueMicrotask(() => {
      setCurrentGesture(null);
      setLandmarks(null);
    });
    sustainedRef.current = { name: '', count: 0 };
  }, []);

  // --------------------------------------------------------------------------
  // LIFECYCLE
  // --------------------------------------------------------------------------

  useEffect(() => {
    if (!enabled) {
      stopLoop();
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        await getRecognizer();
        if (cancelled) return;
        setIsReady(true);
        setError(null);
        runLoop();
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Gesture model failed to load';
        setError(msg);
        console.error('[HandGestures] Failed to initialize', err);
      }
    })();

    return () => {
      cancelled = true;
      stopLoop();
    };
  }, [enabled, runLoop, stopLoop]);

  return {
    isReady,
    currentGesture,
    landmarks,
    error,
  };
}
