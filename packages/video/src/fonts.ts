/**
 * Load brand fonts via @remotion/google-fonts. Per-series brand kits reference
 * these by their CSS family name; keep the names in sync if you swap a font.
 */

import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadJetBrainsMono } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadSmoochSans } from "@remotion/google-fonts/SmoochSans";
import { loadFont as loadPlayfairDisplay } from "@remotion/google-fonts/PlayfairDisplay";
import { loadFont as loadPoppins } from "@remotion/google-fonts/Poppins";
import { loadFont as loadMerriweather } from "@remotion/google-fonts/Merriweather";
import { loadFont as loadMontserrat } from "@remotion/google-fonts/Montserrat";

/**
 * CSS family names exported by the fonts we load. Brand kit JSONs use these
 * verbatim in their `fonts.{sans,mono,display}` fields.
 */
export const FONT_FAMILIES = {
  inter: "Inter, system-ui, -apple-system, sans-serif",
  jetBrainsMono: "JetBrains Mono, SF Mono, Menlo, monospace",
  smoochSans: "'Smooch Sans', system-ui, sans-serif",
  playfairDisplay: "'Playfair Display', Georgia, serif",
  poppins: "Poppins, system-ui, sans-serif",
  merriweather: "Merriweather, Georgia, serif",
  montserrat: "Montserrat, system-ui, sans-serif",
} as const;

export function loadBrandFonts() {
  loadInter();
  loadJetBrainsMono();
  loadSmoochSans();
  loadPlayfairDisplay();
  loadPoppins();
  loadMerriweather();
  loadMontserrat();
}
