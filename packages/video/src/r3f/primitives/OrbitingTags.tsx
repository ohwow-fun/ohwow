/**
 * r3f.orbiting-tags — text labels orbiting a central axis at varying
 * depths. Good for tool inventories ("35 MCP servers"), feature sets,
 * or model-family lists.
 *
 * Each tag sits on a soft luminous pill (thin rounded box) so the
 * text stays legible even when it rotates edge-on.
 *
 * Params:
 *   tags:       string[] — labels to orbit
 *   radius?:    number — orbit radius (default 2.8)
 *   speed?:     number — radians/sec (default 0.3)
 *   tagSize?:   number — tag height (default 0.32)
 *   axisTilt?:  number — radians — tilt of the orbit plane (default 0.18)
 *   color?:     string — tag background (default warm #e3b58a)
 *   textColor?: string (default #0a1629)
 */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { Text } from "@react-three/drei";
import { chromeMaterialPreset } from "../../motion/asmr";

interface OrbitingTagsProps {
  tags?: string[];
  radius?: number;
  speed?: number;
  tagSize?: number;
  axisTilt?: number;
  color?: string;
  textColor?: string;
  motionProfile?: string;
}

export const OrbitingTags: React.FC<OrbitingTagsProps> = ({
  tags = [],
  radius = 2.8,
  speed = 0.3,
  tagSize = 0.32,
  axisTilt = 0.18,
  color = "#e3b58a",
  textColor = "#0a1629",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const base = t * speed;

  return (
    <group rotation={[axisTilt, 0, 0]}>
      {tags.map((tag, i) => {
        const phase = base + (i / tags.length) * Math.PI * 2;
        const x = Math.cos(phase) * radius;
        const z = Math.sin(phase) * radius;
        // Slight Y oscillation per-tag for organic feel.
        const y = Math.sin(phase * 2 + i * 0.7) * 0.15;
        // Fade by depth: tags behind the center are slightly dimmer.
        const depthOpacity = (z + radius) / (radius * 2); // 0 when behind, 1 when in front
        const opacity = 0.45 + depthOpacity * 0.55;
        // Character-ish pill width: estimate ~0.13 world-units per character at tagSize 0.32.
        const charWidth = tagSize * 0.42;
        const pillWidth = Math.max(tagSize * 3, tag.length * charWidth + tagSize * 1.2);
        const pillHeight = tagSize * 1.55;

        // Tags face the camera (y-axis lookAt, billboard-lite).
        const lookY = -phase + Math.PI / 2;

        return (
          <group key={`${tag}-${i}`} position={[x, y, z]} rotation={[0, lookY, 0]}>
            <mesh>
              <boxGeometry args={[pillWidth, pillHeight, 0.06]} />
              <meshStandardMaterial
                {...chromeMaterialPreset}
                color={color}
                transparent
                opacity={opacity}
              />
            </mesh>
            <Text
              position={[0, 0, 0.04]}
              fontSize={tagSize * 0.55}
              color={textColor}
              anchorX="center"
              anchorY="middle"
              fontWeight={700}
            >
              {tag}
            </Text>
          </group>
        );
      })}
    </group>
  );
};
