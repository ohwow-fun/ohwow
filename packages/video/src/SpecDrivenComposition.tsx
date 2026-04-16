import React from "react";
import { AbsoluteFill } from "remotion";
import type { VideoSpec } from "./spec/types";

/**
 * Phase 0 stub. Full implementation lands in Phase 1 (spec → TransitionSeries).
 */
export const SpecDrivenComposition: React.FC<VideoSpec> = () => {
  return <AbsoluteFill style={{ backgroundColor: "#0a0a0f" }} />;
};
