import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setConcurrency(1);
Config.setPublicDir("public");
// Required for @remotion/three / WebGL-based scenes (R3F primitives).
// Without this, the headless Chromium can't create a WebGL context and
// any Three.js scene throws "Error creating WebGL context." at frame 0.
// See https://www.remotion.dev/docs/three
Config.setChromiumOpenGlRenderer("angle");
