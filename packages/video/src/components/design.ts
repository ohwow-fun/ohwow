/**
 * Shared design tokens for the OHWOW demo video
 */

export const colors = {
  bg: "#0a0a0f",
  bgSubtle: "#111118",
  accent: "#f97316",
  accentGlow: "rgba(249, 115, 22, 0.3)",
  blue: "#3b82f6",
  green: "#22c55e",
  purple: "#a855f7",
  text: "#e4e4e7",
  textMuted: "#71717a",
  textDim: "rgba(255,255,255,0.4)",
  card: "rgba(255,255,255,0.06)",
  cardBorder: "rgba(255,255,255,0.1)",
  chatgpt: "#10a37f",
  claude: "#d97706",
  gemini: "#4285f4",
  perplexity: "#20b2aa",
  grok: "#e5e5e5",
};

export const fonts = {
  /** Body text — same as ohwow.fun --font-body */
  sans: "Inter, system-ui, -apple-system, sans-serif",
  /** Code and labels — same as ohwow.fun --font-mono */
  mono: "JetBrains Mono, SF Mono, Menlo, monospace",
  /** Display / wordmark — same as ohwow.fun --font-display */
  display: "'Smooch Sans', system-ui, sans-serif",
};

export const glass = {
  background: colors.card,
  backdropFilter: "blur(20px)",
  border: `1px solid ${colors.cardBorder}`,
  borderRadius: 12,
};
