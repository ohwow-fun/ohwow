/**
 * HandLandmarkOverlay
 * Draws hand wireframes (landmarks + connectors) on a canvas positioned
 * over the fullscreen camera background.
 *
 * The canvas internal resolution is set to the video element's CSS display
 * size (clientWidth × clientHeight), so canvas coordinates = screen pixels.
 * The X axis is flipped in code to match the video's CSS scaleX(-1) mirror.
 */

import { useRef, useEffect } from 'react';

// MediaPipe landmark indices for hand connections (21 landmarks)
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
  landmarks: NormalizedLandmark[][] | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

export function HandLandmarkOverlay({ landmarks, videoRef }: HandLandmarkOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Keep canvas internal resolution = video CSS display size.
  // This ensures canvas coordinates map 1:1 to screen pixels.
  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const syncSize = () => {
      const w = video.clientWidth;
      const h = video.clientHeight;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    };

    syncSize();
    const observer = new ResizeObserver(syncSize);
    observer.observe(video);

    return () => observer.disconnect();
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

    // Landmarks are normalized [0,1] to the full video frame.
    // The video uses object-fit:cover + scaleX(-1). We need to:
    //   1. Map normalized coords to the object-cover rendered size
    //   2. Subtract the crop offset
    //   3. Mirror X to match scaleX(-1)
    const vw = video.videoWidth || cw;
    const vh = video.videoHeight || ch;

    // Object-cover: scale to fill, then crop the overflow
    const scale = Math.max(cw / vw, ch / vh);
    const renderedW = vw * scale;
    const renderedH = vh * scale;
    const cropX = (renderedW - cw) / 2;
    const cropY = (renderedH - ch) / 2;

    const toPixel = (lm: NormalizedLandmark): [number, number] => [
      // Mirror X (video has CSS scaleX(-1)), then apply object-cover transform
      cw - (lm.x * renderedW - cropX),
      lm.y * renderedH - cropY,
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
      className="absolute inset-0 w-full h-full pointer-events-none z-[7]"
    />
  );
}
