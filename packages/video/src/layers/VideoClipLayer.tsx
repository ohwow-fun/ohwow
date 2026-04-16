import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";

export interface VideoClipLayerProps {
  /** staticFile-relative path, e.g. "clips/<hash>.mp4". */
  src?: string;
  opacity?: number;
  blendMode?: React.CSSProperties["mixBlendMode"];
  fit?: "cover" | "contain";
  muted?: boolean;
}

/**
 * Renders a pre-generated mp4 clip as a full-bleed visual layer.
 * Staged into packages/video/public/clips/ by video_workspace_author.ts
 * so staticFile() resolves cleanly at render time.
 *
 * If `src` is missing (graceful fallback when no video provider is
 * configured), we render nothing — other layers carry the scene.
 */
export const VideoClipLayer: React.FC<VideoClipLayerProps> = ({
  src,
  opacity = 1,
  blendMode,
  fit = "cover",
  muted = true,
}) => {
  if (!src) return null;
  return (
    <AbsoluteFill style={{ opacity, mixBlendMode: blendMode }}>
      <OffthreadVideo
        src={staticFile(src)}
        muted={muted}
        style={{ width: "100%", height: "100%", objectFit: fit }}
      />
    </AbsoluteFill>
  );
};
