/**
 * useTypewriter hook
 * Reveals text character-by-character at a configurable cadence.
 */

import { useState, useEffect } from 'react';

/**
 * Reveals `text` one character at a time.
 *
 * @param text         The full string to reveal.
 * @param enabled      When false, returns the full text immediately (default: true).
 * @param charDelayMs  Milliseconds between each revealed character (default: 40).
 * @returns            The currently-visible slice of `text`.
 */
export function useTypewriter(text: string, enabled = true, charDelayMs = 40): string {
  const [revealedCount, setRevealedCount] = useState(0);

  useEffect(() => {
    // Always reset when text changes so we re-animate new content
    setRevealedCount(0);

    if (!enabled || text.length === 0) {
      // Nothing to animate — expose full text via the slice below
      if (!enabled) setRevealedCount(text.length);
      return;
    }

    const id = setInterval(() => {
      setRevealedCount((prev) => {
        if (prev >= text.length) {
          clearInterval(id);
          return prev;
        }
        return prev + 1;
      });
    }, charDelayMs);

    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, enabled, charDelayMs]);

  return text.slice(0, revealedCount);
}
