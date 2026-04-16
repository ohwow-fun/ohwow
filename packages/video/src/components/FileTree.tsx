/**
 * FileTree — Animated directory tree with files appearing one by one
 */

import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { colors, fonts, glass } from "./design";

interface FileEntry {
  name: string;
  indent: number; // 0 = root, 1 = child, etc.
  isDir?: boolean;
  delay: number; // frames before appearing
}

interface FileTreeProps {
  files: FileEntry[];
  title?: string;
  enterFrame?: number;
  width?: number;
}

export const FileTree: React.FC<FileTreeProps> = ({
  files,
  title = "docs.stripe.com",
  enterFrame = 0,
  width = 320,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const localFrame = frame - enterFrame;

  if (localFrame < 0) return null;

  const enter = spring({
    fps,
    frame: localFrame,
    config: { damping: 200 },
    durationInFrames: 15,
  });

  return (
    <div
      style={{
        ...glass,
        width,
        padding: "12px 16px",
        opacity: enter,
        transform: `scale(${interpolate(enter, [0, 1], [0.95, 1])})`,
      }}
    >
      {/* Header */}
      <div
        style={{
          fontFamily: fonts.mono,
          fontSize: 11,
          color: colors.accent,
          fontWeight: 600,
          marginBottom: 8,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span style={{ fontSize: 14 }}>&#128193;</span>
        {title}
      </div>

      {/* Files */}
      {files.map((file, i) => {
        const fileFrame = localFrame - file.delay;
        if (fileFrame < 0) return null;

        const fileEnter = spring({
          fps,
          frame: fileFrame,
          config: { damping: 200 },
          durationInFrames: 10,
        });

        const icon = file.isDir ? "&#128193;" : "&#128196;";
        const nameColor = file.isDir ? colors.blue : colors.text;

        return (
          <div
            key={i}
            style={{
              fontFamily: fonts.mono,
              fontSize: 12,
              color: nameColor,
              paddingLeft: file.indent * 16,
              opacity: fileEnter,
              transform: `translateX(${interpolate(fileEnter, [0, 1], [20, 0])}px)`,
              lineHeight: 1.8,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span
              style={{ fontSize: 11, opacity: 0.7 }}
              dangerouslySetInnerHTML={{ __html: icon }}
            />
            {file.name}
          </div>
        );
      })}
    </div>
  );
};
