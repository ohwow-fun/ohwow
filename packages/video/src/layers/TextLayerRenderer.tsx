import React from "react";
import { useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { noise2D } from "@remotion/noise";
import type { TextLayer, TextPosition } from "./types";
import { fonts, colors } from "../components/design";
import { breathe } from "../motion/generative";

const FONT_MAP = {
  sans: fonts.sans,
  mono: fonts.mono,
  display: fonts.display,
} as const;

function positionStyles(pos: TextPosition): React.CSSProperties {
  switch (pos) {
    case "center":
      return { justifyContent: "center", alignItems: "center", textAlign: "center" as const };
    case "bottom-center":
      return { justifyContent: "flex-end", alignItems: "center", textAlign: "center" as const, paddingBottom: 140 };
    case "bottom-left":
      return { justifyContent: "flex-end", alignItems: "flex-start", textAlign: "left" as const, paddingBottom: 140 };
    case "top-center":
      return { justifyContent: "flex-start", alignItems: "center", textAlign: "center" as const, paddingTop: 80 };
  }
}

const TypewriterText: React.FC<{
  text: string;
  style: React.CSSProperties;
  accentColor: string;
}> = ({ text, style, accentColor }) => {
  const frame = useCurrentFrame();
  const speed = 1.5;
  const charsToShow = Math.min(text.length, Math.floor(frame * speed));
  const typed = text.slice(0, charsToShow);
  const isTyping = charsToShow < text.length;
  const cursorVisible = isTyping || Math.floor(frame * 0.06) % 2 === 0;

  return (
    <div style={style}>
      {typed}
      {cursorVisible && (
        <span style={{ color: accentColor, fontWeight: 300 }}>▍</span>
      )}
    </div>
  );
};

const FadeInText: React.FC<{
  text: string;
  style: React.CSSProperties;
}> = ({ text, style }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [8, 35], [0, 1], { extrapolateRight: "clamp" });
  const y = interpolate(frame, [8, 35], [15, 0], { extrapolateRight: "clamp" });

  return (
    <div style={{ ...style, opacity, transform: `${style.transform ?? ""} translateY(${y}px)`.trim() }}>
      {text}
    </div>
  );
};

const WordByWordText: React.FC<{
  text: string;
  style: React.CSSProperties;
  accentColor: string;
}> = ({ text, style, accentColor }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = text.split(/\s+/);
  const framesPerWord = Math.max(3, Math.floor(fps * 0.18));

  return (
    <div style={style}>
      {words.map((word, i) => {
        const wordStart = 10 + i * framesPerWord;
        const opacity = interpolate(frame, [wordStart, wordStart + 6], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const y = interpolate(frame, [wordStart, wordStart + 6], [8, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const isLast = i === words.length - 1;
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              opacity,
              transform: `translateY(${y}px)`,
              marginRight: 8,
              color: isLast ? accentColor : undefined,
            }}
          >
            {word}
          </span>
        );
      })}
    </div>
  );
};

const GlowText: React.FC<{
  text: string;
  style: React.CSSProperties;
  accentColor: string;
}> = ({ text, style, accentColor }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  const glowRadius = interpolate(
    breathe(frame, 0.04, 1),
    [0, 2],
    [8, 30],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const glowOpacity = interpolate(
    breathe(frame, 0.04, 1),
    [0, 2],
    [0.4, 0.9],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <div
      style={{
        ...style,
        opacity,
        textShadow: [
          `0 0 ${glowRadius}px ${accentColor}${Math.round(glowOpacity * 255).toString(16).padStart(2, "0")}`,
          `0 0 ${glowRadius * 2}px ${accentColor}40`,
          `0 0 ${glowRadius * 4}px ${accentColor}18`,
        ].join(", "),
      }}
    >
      {text}
    </div>
  );
};

const SplitRevealText: React.FC<{
  text: string;
  style: React.CSSProperties;
}> = ({ text, style }) => {
  const frame = useCurrentFrame();
  const lines = text.split("\n").filter(Boolean);

  return (
    <div style={{ ...style, display: "flex", flexDirection: "column", gap: 12 }}>
      {lines.map((line, i) => {
        const delay = i * 8;
        const progress = interpolate(frame, [delay + 5, delay + 25], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const fromRight = i % 2 === 0;
        const x = (1 - progress) * (fromRight ? 120 : -120);

        return (
          <div
            key={i}
            style={{
              opacity: progress,
              transform: `translateX(${x}px)`,
              textAlign: style.textAlign,
            }}
          >
            {line}
          </div>
        );
      })}
    </div>
  );
};

const CountUpLine: React.FC<{
  line: string;
  delay: number;
  accentColor: string;
  style: React.CSSProperties;
}> = ({ line, delay, accentColor, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const match = line.match(/^(\d+(?:[.,]\d+)?)/);
  const target = match ? parseFloat(match[1].replace(",", "")) : 0;
  const suffix = match ? line.slice(match[0].length) : line;
  const isDecimal = match ? match[1].includes(".") : false;
  const decimals = isDecimal ? (match![1].split(".")[1]?.length ?? 0) : 0;

  const countDuration = Math.min(fps * 2, 60);
  const progress = interpolate(frame, [delay + 8, delay + 8 + countDuration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const eased = 1 - Math.pow(1 - progress, 3);
  const current = target * eased;
  const display = isDecimal ? current.toFixed(decimals) : Math.round(current).toLocaleString();

  const fadeIn = interpolate(frame, [delay, delay + 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div style={{ ...style, opacity: fadeIn }}>
      <span style={{ color: accentColor, fontVariantNumeric: "tabular-nums" }}>
        {display}
      </span>
      {suffix && <span>{suffix}</span>}
    </div>
  );
};

const CountUpText: React.FC<{
  text: string;
  style: React.CSSProperties;
  accentColor: string;
}> = ({ text, style, accentColor }) => {
  const lines = text.split("\n").filter(Boolean);

  if (lines.length <= 1) {
    return <CountUpLine line={text} delay={0} accentColor={accentColor} style={style} />;
  }

  return (
    <div style={{ ...style, display: "flex", flexDirection: "column", gap: 16 }}>
      {lines.map((line, i) => (
        <CountUpLine
          key={i}
          line={line}
          delay={i * 12}
          accentColor={accentColor}
          style={{ fontSize: style.fontSize, fontFamily: style.fontFamily, fontWeight: style.fontWeight, color: style.color }}
        />
      ))}
    </div>
  );
};

const LetterScatterText: React.FC<{
  text: string;
  style: React.CSSProperties;
}> = ({ text, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <div style={style}>
      {text.split("").map((char, i) => {
        const delay = i * 0.8;
        const progress = Math.min(1, Math.max(0, (frame - delay) / 12));
        const startX = noise2D("scatter-x", i * 0.5, 0) * 60;
        const startY = noise2D("scatter-y", 0, i * 0.5) * 40;
        const x = startX * (1 - progress);
        const y = startY * (1 - progress);
        const opacity = progress;
        const rotation = (1 - progress) * (noise2D("scatter-r", i, 0) * 30);

        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              opacity,
              transform: `translate(${x}px, ${y}px) rotate(${rotation}deg)`,
              whiteSpace: char === " " ? "pre" : undefined,
            }}
          >
            {char}
          </span>
        );
      })}
    </div>
  );
};

export const TextLayerRenderer: React.FC<{
  config: TextLayer;
  durationInFrames?: number;
}> = ({ config, durationInFrames }) => {
  const frame = useCurrentFrame();
  const position = config.position ?? "center";
  const accent = config.accentColor ?? colors.accent;
  const fontSize = config.fontSize ?? (config.content.length > 80 ? 32 : config.content.length > 50 ? 38 : 46);
  const fontWeight = config.fontWeight ?? 600;
  const fontFamily = FONT_MAP[config.fontFamily ?? "sans"];
  const maxWidth = config.maxWidth ?? 900;

  const fadeIn = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" });
  const posStyles = positionStyles(position);

  const textStyle: React.CSSProperties = {
    fontFamily,
    fontSize,
    fontWeight,
    color: config.color ?? colors.text,
    lineHeight: 1.35,
    maxWidth,
    transform: `scale(${breathe(frame, 0.025, 0.006)})`,
  };

  const dur = durationInFrames ?? 180;
  const subtitleFade = config.subtitle
    ? interpolate(frame, [Math.min(dur - 50, 50), Math.min(dur - 30, 70)], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 0;

  const animation = config.animation ?? "typewriter";

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        padding: "0 100px",
        opacity: fadeIn,
        pointerEvents: "none",
        ...posStyles,
      }}
    >
      {animation === "typewriter" && (
        <TypewriterText text={config.content} style={textStyle} accentColor={accent} />
      )}
      {animation === "fade-in" && (
        <FadeInText text={config.content} style={textStyle} />
      )}
      {animation === "word-by-word" && (
        <WordByWordText text={config.content} style={textStyle} accentColor={accent} />
      )}
      {animation === "letter-scatter" && (
        <LetterScatterText text={config.content} style={textStyle} />
      )}
      {animation === "glow-text" && (
        <GlowText text={config.content} style={textStyle} accentColor={accent} />
      )}
      {animation === "split-reveal" && (
        <SplitRevealText text={config.content} style={textStyle} />
      )}
      {animation === "count-up" && (
        <CountUpText text={config.content} style={textStyle} accentColor={accent} />
      )}

      {config.subtitle && subtitleFade > 0 && (
        <div
          style={{
            fontFamily: fonts.sans,
            fontSize: 18,
            color: colors.textMuted,
            marginTop: 20,
            opacity: subtitleFade,
          }}
        >
          {config.subtitle}
        </div>
      )}
    </div>
  );
};
