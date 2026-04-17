/**
 * r3f.orbiting-tags — text labels orbiting a central axis at varying
 * depths. Good for tool inventories ("35 MCP servers"), feature sets,
 * or model-family lists.
 *
 * Each tag is wrapped in a drei <Billboard> so it always faces the
 * camera — never rotates edge-on and never becomes unreadable as the
 * orbit carries it around.
 *
 * Tags fade by depth: the ones BEHIND the center are dimmer and
 * slightly smaller, creating a real sense of depth.
 *
 * Params:
 *   tags:       string[] — labels to orbit
 *   radius?:    number — orbit radius (default 2.6)
 *   speed?:     number — radians/sec (default 0.25)
 *   tagSize?:   number — pill height (default 0.38)
 *   axisTilt?:  number — radians — tilt of the orbit plane (default 0.28)
 *   color?:     string — tag background (default warm #e3b58a)
 *   textColor?: string (default #0a1629)
 */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { Billboard, Text } from "@react-three/drei";
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
  radius = 2.6,
  speed = 0.25,
  tagSize = 0.38,
  axisTilt = 0.28,
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
        const phase = base + (i / Math.max(1, tags.length)) * Math.PI * 2;
        const x = Math.cos(phase) * radius;
        const z = Math.sin(phase) * radius;
        // Slight Y oscillation per-tag for organic feel.
        const y = Math.sin(phase * 1.5 + i * 0.7) * 0.18;

        // Depth factor: +1 when tag is in front (z > 0), -1 when behind.
        const depthFactor = z / radius;
        // Opacity fades tags behind center; scale slightly.
        const opacity = 0.45 + (depthFactor + 1) * 0.275; // range 0.45..1.0
        const scale = 0.85 + (depthFactor + 1) * 0.075; // range 0.85..1.0

        // Pill sized to text content — approx.
        const charWidth = tagSize * 0.44;
        const pillWidth = Math.max(tagSize * 3.2, tag.length * charWidth + tagSize * 1.4);
        const pillHeight = tagSize * 1.55;

        return (
          <Billboard
            key={`${tag}-${i}`}
            position={[x, y, z]}
            follow
            lockX={false}
            lockY={false}
            lockZ={false}
          >
            <group scale={[scale, scale, scale]}>
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
          </Billboard>
        );
      })}
    </group>
  );
};
