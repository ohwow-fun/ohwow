import type { VideoSpec } from "./types";

export const emptySpec: VideoSpec = {
  id: "empty",
  version: 1,
  fps: 30,
  width: 1280,
  height: 720,
  brand: {
    colors: { bg: "#0a0a0f", text: "#ffffff" },
    fonts: { sans: "Inter", mono: "JetBrains Mono", display: "Inter" },
    glass: {
      background: "rgba(255,255,255,0.05)",
      border: "1px solid rgba(255,255,255,0.1)",
      borderRadius: 16,
      backdropFilter: "blur(20px)",
    },
  },
  voiceovers: [],
  transitions: [],
  scenes: [],
};
