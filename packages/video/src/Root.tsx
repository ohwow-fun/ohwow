import React from "react";
import { Composition } from "remotion";
import { SpecDrivenComposition } from "./SpecDrivenComposition";
import { totalDurationFrames } from "./spec/totalDuration";
import type { VideoSpec } from "./spec/types";
import { emptySpec } from "./spec/empty";

export const Root: React.FC = () => {
  return (
    <Composition
      id="SpecDriven"
      component={SpecDrivenComposition as unknown as React.FC<Record<string, unknown>>}
      calculateMetadata={({ props }) => {
        const spec = props as unknown as VideoSpec;
        return {
          durationInFrames: totalDurationFrames(spec),
          fps: spec.fps,
          width: spec.width,
          height: spec.height,
        };
      }}
      defaultProps={emptySpec as unknown as Record<string, unknown>}
    />
  );
};
