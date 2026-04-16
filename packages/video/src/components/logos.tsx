/**
 * AI Platform Logos — Simplified SVG versions
 * Used in Scene 1 for the "scattered chats" visual
 */

import React from "react";

const SIZE = 48;

/** OpenAI / ChatGPT logo mark */
export const ChatGPTLogo: React.FC<{ size?: number }> = ({ size = SIZE }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
    <rect width="48" height="48" rx="12" fill="#10a37f" />
    <path
      d="M24 10c-1.5 0-2.8 1-3.2 2.4l-.8 2.6H16c-1.7 0-3 1.3-3 3 0 .8.3 1.6.9 2.1l2 1.7-.8 2.6c-.5 1.6.3 3.3 1.8 3.9.8.3 1.6.2 2.3-.2l2.2-1.4h2.7l2.2 1.4c1.4.9 3.2.5 4.1-.9.4-.7.5-1.5.2-2.3l-.8-2.6 2-1.7c1.3-1.1 1.4-3 .4-4.3-.5-.6-1.3-1-2.1-1h-4l-.8-2.6C26.8 11 25.5 10 24 10z"
      fill="white"
      opacity="0.9"
    />
  </svg>
);

/** Anthropic / Claude logo mark */
export const ClaudeLogo: React.FC<{ size?: number }> = ({ size = SIZE }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
    <rect width="48" height="48" rx="12" fill="#d97706" />
    <path
      d="M16 32l8-20 8 20M18.5 26h11"
      stroke="white"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Google Gemini logo mark */
export const GeminiLogo: React.FC<{ size?: number }> = ({ size = SIZE }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
    <rect width="48" height="48" rx="12" fill="#4285f4" />
    <circle cx="24" cy="16" r="5" fill="white" opacity="0.9" />
    <circle cx="16" cy="28" r="4" fill="white" opacity="0.7" />
    <circle cx="32" cy="28" r="4" fill="white" opacity="0.7" />
    <circle cx="24" cy="36" r="3" fill="white" opacity="0.5" />
  </svg>
);

/** Perplexity logo mark */
export const PerplexityLogo: React.FC<{ size?: number }> = ({ size = SIZE }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
    <rect width="48" height="48" rx="12" fill="#1a1a2e" />
    <path
      d="M24 12v24M14 18l10 6-10 6M34 18l-10 6 10 6"
      stroke="#20b2aa"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** xAI / Grok logo mark */
export const GrokLogo: React.FC<{ size?: number }> = ({ size = SIZE }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
    <rect width="48" height="48" rx="12" fill="#1a1a1a" />
    <path
      d="M16 16l16 16M32 16l-16 16"
      stroke="white"
      strokeWidth="3"
      strokeLinecap="round"
    />
    <circle cx="24" cy="24" r="3" fill="white" />
  </svg>
);

/** OHWOW wordmark in brand style (Smooch Sans uppercase) */
export const OhwowWordmark: React.FC<{
  fontSize?: number;
  showDotFun?: boolean;
}> = ({ fontSize = 64, showDotFun = true }) => (
  <div
    style={{
      display: "flex",
      alignItems: "baseline",
      fontFamily: "'Smooch Sans', system-ui, sans-serif",
      textTransform: "uppercase",
      letterSpacing: "0.15em",
    }}
  >
    <span style={{ fontSize, fontWeight: 700, color: "#e4e4e7" }}>OHWOW</span>
    {showDotFun && (
      <span style={{ fontSize, fontWeight: 300, color: "#71717a" }}>
        .FUN
      </span>
    )}
  </div>
);
