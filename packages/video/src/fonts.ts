/**
 * Load brand fonts via @remotion/google-fonts
 */

import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadJetBrainsMono } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadSmoochSans } from "@remotion/google-fonts/SmoochSans";

export function loadBrandFonts() {
  loadInter();
  loadJetBrainsMono();
  loadSmoochSans();
}
