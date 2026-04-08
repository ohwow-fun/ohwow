/**
 * HandLandmarkOverlay
 * Draws hand wireframes (landmarks + connectors) on a canvas positioned
 * over the fullscreen camera background. Uses MediaPipe DrawingUtils.
 */

import { useRef, useEffect } from 'react';

// MediaPipe landmark indices for hand connections (21 landmarks)
// Wrist(0) → Thumb(1-4) → Index(5-8) → Middle(9-12) → Ring(13-16) → Pinky(17-20)
const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],       // Thumb
  [0, 5], [5, 6], [6, 7], [7, 8],       // Index
  [0, 9], [9, 10], [10, 11], [11, 12],  // Middle
  [0, 13], [13, 14], [14, 15], [15, 16],// Ring
  [0, 17], [17, 18], [18, 19], [19, 20],// Pinky
  [5, 9], [9, 13], [13, 17],            // Palm cross-connections
];

interface NormalizedLandmark {
  x: number;
  y: number;
  z: number;
}

interface HandLandmarkOverlayProps {
  /** All hand landmarks arrays (one per detected hand) */
  landmarks: NormalizedLandmark[][] | null;
  /** The video element to match dimensions against */
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

export function HandLandmarkOverlay({ landmarks, videoRef }: HandLandmarkOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Keep canvas internal resolution synced with the video's intrinsic size.
  // The canvas uses the same object-fit:cover + scaleX(-1) CSS as the video,
  // so the browser aligns them automatically — no manual transform math needed.
  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const syncSize = () => {
      const vw = video.videoWidth || video.clientWidth;
      const vh = video.videoHeight || video.clientHeight;
      if (canvas.width !== vw) canvas.width = vw;
      if (canvas.height !== vh) canvas.height = vh;
    };

    syncSize();
    const observer = new ResizeObserver(syncSize);
    observer.observe(video);
    video.addEventListener('loadedmetadata', syncSize);

    return () => {
      observer.disconnect();
      video.removeEventListener('loadedmetadata', syncSize);
    };
  }, [videoRef]);

  // Draw landmarks on every update
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!landmarks || landmarks.length === 0) return;

    const cw = canvas.width;
    const ch = canvas.height;

    // Canvas has the same object-fit:cover and scaleX(-1) CSS as the video,
    // so landmarks just map directly into the video's intrinsic coordinate space.
    const toPixel = (lm: NormalizedLandmark): [number, number] => [
      lm.x * cw,
      lm.y * ch,
    ];

    for (const hand of landmarks) {
      if (hand.length < 21) continue;

      // Draw connectors
      ctx.strokeStyle = 'rgba(0, 220, 255, 0.3)';
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';

      for (const [start, end] of HAND_CONNECTIONS) {
        const [ax, ay] = toPixel(hand[start]);
        const [bx, by] = toPixel(hand[end]);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }

      // Draw landmark dots
      for (const point of hand) {
        const [px, py] = toPixel(point);
        ctx.beginPath();
        ctx.arc(px, py, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 220, 255, 0.5)';
        ctx.fill();
      }

      // Draw fingertips slightly larger (indices 4, 8, 12, 16, 20)
      const fingertips = [4, 8, 12, 16, 20];
      for (const idx of fingertips) {
        const [px, py] = toPixel(hand[idx]);
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 220, 255, 0.6)';
        ctx.fill();
      }
    }
  }, [landmarks, videoRef]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full object-cover pointer-events-none z-[7]"
      style={{ transform: 'scaleX(-1)' }}
    />
  );
}
