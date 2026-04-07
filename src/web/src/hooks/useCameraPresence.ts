/**
 * useCameraPresence (Local Runtime Web UI)
 * Opens the front camera, detects faces on-device, and fires presence events.
 * Runs entirely in the browser (no frames leave the device).
 *
 * Uses motion-gated inference (arxiv 2601.00854): only runs face detection
 * when the scene changes, reducing CPU usage ~30x on a static scene.
 *
 * Face detection uses Chrome's FaceDetector API (available on Android Chrome 70+)
 * with a canvas-based luminance fallback for motion gating.
 */

import { useState, useRef, useCallback, useEffect } from 'react';


// ============================================================================
// TYPES
// ============================================================================

type PresencePhase = 'inactive' | 'absent' | 'detected' | 'confirmed';

interface UseCameraPresenceOptions {
  /** Called when presence state changes. */
  onPresenceChange: (event: { type: 'arrival' | 'departure' | 'still_here'; confidence: number }) => void;
  /** How long face must be detected before confirming (ms). Default: 3000 */
  confirmMs?: number;
  /** How long without detection before marking absent (ms). Default: 30000 */
  absentMs?: number;
  /** Frame analysis interval (ms). Default: 500 */
  frameIntervalMs?: number;
}

interface UseCameraPresenceReturn {
  isActive: boolean;
  phase: PresencePhase;
  confidence: number;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  /** The video element ref — attach to a <video> for preview. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_CONFIRM_MS = 3000;
const DEFAULT_ABSENT_MS = 30000;
const DEFAULT_FRAME_INTERVAL_MS = 500;

/** Luminance delta threshold for motion gating (0-255 scale). */
const MOTION_THRESHOLD = 8;

/** Minimum face detection confidence to count as a detection. */
const MIN_FACE_CONFIDENCE = 0.6;

/** Battery level below which we slow down capture. */
const LOW_BATTERY_THRESHOLD = 0.2;

/** Slower interval when battery is low. */
const LOW_BATTERY_INTERVAL_MS = 2000;

// ============================================================================
// HOOK
// ============================================================================

export function useCameraPresence(options: UseCameraPresenceOptions): UseCameraPresenceReturn {
  const {
    confirmMs = DEFAULT_CONFIRM_MS,
    absentMs = DEFAULT_ABSENT_MS,
    frameIntervalMs = DEFAULT_FRAME_INTERVAL_MS,
  } = options;

  const [isActive, setIsActive] = useState(false);
  const [phase, setPhase] = useState<PresencePhase>('inactive');
  const [confidence, setConfidence] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevFrameRef = useRef<Uint8ClampedArray | null>(null);
  const faceDetectorRef = useRef<FaceDetector | null>(null);

  // Background persistence refs
  const healthTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamDiedRef = useRef(false);
  const visibilityCleanupRef = useRef<(() => void) | null>(null);
  const restartCleanupRef = useRef<(() => void) | null>(null);
  const lockResolveRef = useRef<(() => void) | null>(null);

  // State tracking refs (avoid stale closures)
  const phaseRef = useRef<PresencePhase>('inactive');
  const firstDetectionRef = useRef<number>(0);
  const lastDetectionRef = useRef<number>(0);
  const onPresenceChangeRef = useRef(options.onPresenceChange);

  useEffect(() => {
    onPresenceChangeRef.current = options.onPresenceChange;
  });

  // --------------------------------------------------------------------------
  // FACE DETECTOR SETUP
  // --------------------------------------------------------------------------

  const initFaceDetector = useCallback(() => {
    if (typeof (globalThis as Record<string, unknown>).FaceDetector !== 'undefined') {
      try {
        faceDetectorRef.current = new FaceDetector({
          fastMode: true,
          maxDetectedFaces: 1,
        });
        return true;
      } catch {
        console.warn('[CameraPresence] FaceDetector API not available');
      }
    }
    return false;
  }, []);

  // --------------------------------------------------------------------------
  // MOTION GATING — Compare luminance between frames
  // --------------------------------------------------------------------------

  const hasMotion = useCallback((currentFrame: ImageData): boolean => {
    const current = currentFrame.data;
    const prev = prevFrameRef.current;

    if (!prev) {
      prevFrameRef.current = new Uint8ClampedArray(current);
      return true; // First frame always counts
    }

    // Sample every 16th pixel for speed
    let totalDelta = 0;
    let samples = 0;
    for (let i = 0; i < current.length; i += 64) { // 64 = 16 pixels * 4 channels
      // Luminance approximation: 0.299R + 0.587G + 0.114B
      const currLum = current[i] * 0.299 + current[i + 1] * 0.587 + current[i + 2] * 0.114;
      const prevLum = prev[i] * 0.299 + prev[i + 1] * 0.587 + prev[i + 2] * 0.114;
      totalDelta += Math.abs(currLum - prevLum);
      samples++;
    }

    prevFrameRef.current = new Uint8ClampedArray(current);
    const avgDelta = totalDelta / samples;
    return avgDelta > MOTION_THRESHOLD;
  }, []);

  // --------------------------------------------------------------------------
  // FRAME ANALYSIS
  // --------------------------------------------------------------------------

  const analyzeFrame = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return; // Not ready

    // Get or create canvas
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
    }
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    // Downscale for analysis (160x120 is plenty for face detection gating)
    canvas.width = 160;
    canvas.height = 120;
    ctx.drawImage(video, 0, 0, 160, 120);

    const imageData = ctx.getImageData(0, 0, 160, 120);

    // Motion gate: skip expensive face detection if scene is static
    if (!hasMotion(imageData)) {
      // No motion — check if we should transition to absent
      const now = Date.now();
      if (phaseRef.current !== 'absent' && phaseRef.current !== 'inactive') {
        if (now - lastDetectionRef.current > absentMs) {
          phaseRef.current = 'absent';
          setPhase('absent');
          setConfidence(0);
          onPresenceChangeRef.current({ type: 'departure', confidence: 0 });
        }
      }
      return;
    }

    // Run face detection
    let faceDetected = false;
    let faceConfidence = 0;

    if (faceDetectorRef.current) {
      try {
        // FaceDetector API works on ImageBitmap
        const bitmap = await createImageBitmap(canvas);
        const faces = await faceDetectorRef.current.detect(bitmap);
        bitmap.close();

        if (faces.length > 0) {
          faceDetected = true;
          // FaceDetector doesn't provide confidence directly, use bounding box size as proxy
          const face = faces[0];
          const faceAreaRatio = (face.boundingBox.width * face.boundingBox.height) / (160 * 120);
          faceConfidence = Math.min(1, faceAreaRatio * 10 + 0.5); // Rough confidence from area
        }
      } catch {
        // FaceDetector failed — treat motion as possible presence
        faceDetected = true;
        faceConfidence = 0.4;
      }
    } else {
      // No FaceDetector API — use motion as a presence signal
      faceDetected = true;
      faceConfidence = 0.5;
    }

    if (!faceDetected || faceConfidence < MIN_FACE_CONFIDENCE) {
      // No face — check absent timeout
      const now = Date.now();
      if (phaseRef.current !== 'absent' && phaseRef.current !== 'inactive') {
        if (now - lastDetectionRef.current > absentMs) {
          phaseRef.current = 'absent';
          setPhase('absent');
          setConfidence(0);
          onPresenceChangeRef.current({ type: 'departure', confidence: 0 });
        }
      }
      return;
    }

    // Face detected
    const now = Date.now();
    lastDetectionRef.current = now;
    setConfidence(faceConfidence);

    if (phaseRef.current === 'absent' || phaseRef.current === 'inactive') {
      // First detection — start confirmation timer
      phaseRef.current = 'detected';
      setPhase('detected');
      firstDetectionRef.current = now;
    } else if (phaseRef.current === 'detected') {
      // Check if enough time for confirmation
      if (now - firstDetectionRef.current >= confirmMs) {
        phaseRef.current = 'confirmed';
        setPhase('confirmed');
        onPresenceChangeRef.current({ type: 'arrival', confidence: faceConfidence });
      }
    }
    // If already confirmed, just keep updating lastDetection
  }, [hasMotion, confirmMs, absentMs]);

  // --------------------------------------------------------------------------
  // START / STOP
  // --------------------------------------------------------------------------

  // Restart camera after it died in background
  const restartCamera = useCallback(async () => {
    try {
      // Stop old tracks
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) track.stop();
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
        audio: false,
      });
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      // Re-request wake lock (lost when backgrounded)
      try {
        if ('wakeLock' in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request('screen');
        }
      } catch { /* ok */ }

      console.info('[CameraPresence] Camera restarted after background');
    } catch (err) {
      console.error({ err }, '[CameraPresence] Camera restart failed');
    }
  }, []);

  const start = useCallback(async () => {
    try {
      setError(null);

      // Request camera
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
        audio: false,
      });
      streamRef.current = stream;

      // Attach to video element
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      // Request wake lock
      try {
        if ('wakeLock' in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request('screen');
        }
      } catch {
        console.warn('[CameraPresence] Wake lock not available');
      }

      // Init face detector
      initFaceDetector();

      // Determine interval (slower on low battery)
      let interval = frameIntervalMs;
      try {
        if ('getBattery' in navigator) {
          const battery = await (navigator as Navigator & { getBattery: () => Promise<{ level: number }> }).getBattery();
          if (battery.level < LOW_BATTERY_THRESHOLD) {
            interval = LOW_BATTERY_INTERVAL_MS;
          }
        }
      } catch {
        // Battery API not available
      }

      // Start analysis loop
      phaseRef.current = 'absent';
      setPhase('absent');
      setIsActive(true);

      timerRef.current = setInterval(() => {
        analyzeFrame().catch(() => {});
      }, interval);

      // --- Background Persistence Layers ---

      // Layer 1: Picture-in-Picture — keeps video stream alive when tab is hidden
      const handleVisibility = () => {
        if (document.hidden && videoRef.current && document.pictureInPictureEnabled) {
          if (!document.pictureInPictureElement) {
            videoRef.current.requestPictureInPicture().catch(() => {
              // PiP not available on this device/browser
            });
          }
        }
      };
      document.addEventListener('visibilitychange', handleVisibility);
      visibilityCleanupRef.current = () => document.removeEventListener('visibilitychange', handleVisibility);

      // Layer 2: Web Lock — discourages browser from killing the tab
      if ('locks' in navigator) {
        navigator.locks.request('eye-camera-lock', { mode: 'exclusive' }, () => {
          return new Promise<void>((resolve) => {
            lockResolveRef.current = resolve;
          });
        }).catch(() => {});
      }

      // Layer 3: Stream health monitor — detect if camera died in background
      healthTimerRef.current = setInterval(() => {
        if (streamRef.current) {
          const videoTrack = streamRef.current.getVideoTracks()[0];
          if (videoTrack && videoTrack.readyState === 'ended') {
            streamDiedRef.current = true;
            console.warn('[CameraPresence] Camera stream died in background');
          }
        }
      }, 10_000);

      // Layer 3b: Auto-restart camera when tab becomes visible again
      const handleRestart = () => {
        if (!document.hidden && streamDiedRef.current && phaseRef.current !== 'inactive') {
          streamDiedRef.current = false;
          console.info('[CameraPresence] Restarting camera after background death');
          restartCamera();
        }
      };
      document.addEventListener('visibilitychange', handleRestart);
      restartCleanupRef.current = () => document.removeEventListener('visibilitychange', handleRestart);

      // Layer 4: Heartbeat — send still_here even if camera died (fix #3: not 'arrival')
      heartbeatTimerRef.current = setInterval(() => {
        if (phaseRef.current === 'confirmed' || phaseRef.current === 'detected') {
          onPresenceChangeRef.current({ type: 'still_here', confidence: 0.5 });
        }
      }, 30_000);

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Camera access denied';
      setError(message);
      console.error({ err }, '[CameraPresence] Start failed');
    }
  }, [frameIntervalMs, initFaceDetector, analyzeFrame, restartCamera]);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }

    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }

    // Clean up background persistence
    if (healthTimerRef.current) { clearInterval(healthTimerRef.current); healthTimerRef.current = null; }
    if (heartbeatTimerRef.current) { clearInterval(heartbeatTimerRef.current); heartbeatTimerRef.current = null; }
    visibilityCleanupRef.current?.();
    visibilityCleanupRef.current = null;
    restartCleanupRef.current?.();
    restartCleanupRef.current = null;
    if (lockResolveRef.current) { lockResolveRef.current(); lockResolveRef.current = null; }
    streamDiedRef.current = false;

    // Exit PiP if active
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    }

    prevFrameRef.current = null;
    phaseRef.current = 'inactive';
    setPhase('inactive');
    setIsActive(false);
    setConfidence(0);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return {
    isActive,
    phase,
    confidence,
    error,
    start,
    stop,
    videoRef,
  };
}

// ============================================================================
// FACE DETECTOR TYPE (Chrome API, not in standard lib types)
// ============================================================================

interface FaceDetectorOptions {
  fastMode?: boolean;
  maxDetectedFaces?: number;
}

interface DetectedFace {
  boundingBox: DOMRectReadOnly;
  landmarks?: Array<{ type: string; locations: Array<{ x: number; y: number }> }>;
}

declare class FaceDetector {
  constructor(options?: FaceDetectorOptions);
  detect(image: ImageBitmapSource): Promise<DetectedFace[]>;
}
