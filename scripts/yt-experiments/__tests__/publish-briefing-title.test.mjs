/**
 * Regression tests for title/date derivation in _publish-briefing.mjs.
 *
 * Background: a greedy /(\d{4})(\d{2})(\d{2})/ regex over spec.id caused
 * numeric ids like "yt-video-1776538439135" (unix-ms timestamps) to
 * false-match "1776"/"53"/"84" as (year, month, day). JS Date rolled the
 * out-of-range month/day to 1780-07-23 and the daily Briefing shipped a
 * draft titled "Daily AI News - July 23, 1780" before it was caught.
 *
 * The fix requires a hyphen-separated YYYY-MM-DD shape AND validates the
 * parsed components are in a sane range (year 2020–2099, month 1–12,
 * day 1–31). Any miss falls back to today in UTC.
 */
import { describe, it, expect } from "vitest";

import {
  deriveDateLabel,
  deriveTitle,
} from "../_publish-briefing.mjs";

function todayUtcLabel() {
  return new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function todayUtcYear() {
  return String(new Date().getUTCFullYear());
}

describe("deriveDateLabel", () => {
  it("falls back to today for numeric unix-ms-style spec.id (no false match)", () => {
    const out = deriveDateLabel("yt-video-1776538439135");
    // Must NOT contain the old false-match year.
    expect(out).not.toMatch(/1780/);
    expect(out).not.toMatch(/1776/);
    // Year must be the current UTC year.
    expect(out).toMatch(new RegExp(`\\b${todayUtcYear()}\\b`));
    // Should equal today's fallback label.
    expect(out).toBe(todayUtcLabel());
  });

  it("parses hyphen-separated YYYY-MM-DD in the id", () => {
    expect(deriveDateLabel("briefing-2026-04-18")).toBe("April 18, 2026");
  });

  it("falls back to today when a packed YYYYMMDD is used (hyphens required)", () => {
    // Pinned: strict hyphen-required regex, so "20260418" does NOT match.
    expect(deriveDateLabel("briefing-20260418")).toBe(todayUtcLabel());
  });

  it("falls back to today for out-of-range month/day (e.g. 9999-99-99)", () => {
    // Year is out of the 2020–2099 band AND month/day are out of range.
    expect(deriveDateLabel("briefing-9999-99-99")).toBe(todayUtcLabel());
  });

  it("falls back to today for empty string", () => {
    expect(deriveDateLabel("")).toBe(todayUtcLabel());
  });

  it("falls back to today for undefined and does not throw", () => {
    expect(() => deriveDateLabel(undefined)).not.toThrow();
    expect(deriveDateLabel(undefined)).toBe(todayUtcLabel());
  });

  it("falls back to today for null and does not throw", () => {
    expect(() => deriveDateLabel(null)).not.toThrow();
    expect(deriveDateLabel(null)).toBe(todayUtcLabel());
  });
});

describe("deriveTitle", () => {
  it("includes the hook suffix when one is derivable from spec scenes", () => {
    // deriveTitle reads spec.scenes for the floating-title subtitle; since
    // we pass a bare spec with just id, the hook is null, so no suffix.
    // Simulate the hook-present case by stubbing a scene graph shape.
    const spec = {
      id: "yt-video-1776538439135",
      scenes: [
        {
          id: "intro",
          params: {
            primitives: [
              {
                primitive: "r3f.floating-title",
                params: { subtitle: "APR 18 · one move" },
              },
            ],
          },
        },
      ],
    };
    expect(deriveTitle(spec, "April 18, 2026")).toBe(
      "Daily AI News - April 18, 2026 · One Move",
    );
  });

  it("omits the hook suffix when the spec has no derivable hook", () => {
    const spec = { id: "yt-video-1776538439135" };
    expect(deriveTitle(spec, "April 18, 2026")).toBe(
      "Daily AI News - April 18, 2026",
    );
  });
});
