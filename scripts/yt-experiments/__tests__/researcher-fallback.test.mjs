/**
 * Tests for the researcher-fallback seed shaper. Full dispatch-and-poll
 * path requires a live daemon so it's smoke-tested separately; here we
 * just exercise the shape mapping.
 */
import { describe, it, expect } from "vitest";
import { __testing } from "../seed-adapters/_researcher-fallback.mjs";

const { shapeSeed } = __testing;

describe("researcher-fallback / shapeSeed", () => {
  it("shapes a full payload into a SeriesSeed", () => {
    const seed = shapeSeed(
      {
        actor: "Anthropic",
        artifact: "Claude 4.7 Opus",
        summary: "Ships with 1M token context and long-running agent support.",
        citations: [
          { url: "https://anthropic.com/news/claude-4-7", text: "Official announcement" },
          { url: "https://news.ycombinator.com/item?id=12345" },
        ],
      },
      { seriesSlug: "briefing", taskId: "task-abc-123" },
    );
    expect(seed).not.toBeNull();
    expect(seed.kind).toBe("external-url");
    expect(seed.title).toBe("Anthropic: Claude 4.7 Opus");
    expect(seed.body).toMatch(/HEADLINE/);
    expect(seed.body).toMatch(/SUMMARY/);
    expect(seed.body).toMatch(/CITATIONS/);
    expect(seed.citations.length).toBe(2);
    expect(seed.metadata.source).toBe("researcher-agent-fallback");
    expect(seed.metadata.research_task_id).toBe("task-abc-123");
  });

  it("returns null when actor is missing", () => {
    expect(shapeSeed({ artifact: "x", summary: "y" }, { seriesSlug: "briefing", taskId: "t" })).toBeNull();
  });

  it("returns null when artifact is missing", () => {
    expect(shapeSeed({ actor: "x", summary: "y" }, { seriesSlug: "briefing", taskId: "t" })).toBeNull();
  });

  it("returns null when summary is missing", () => {
    expect(shapeSeed({ actor: "x", artifact: "y" }, { seriesSlug: "briefing", taskId: "t" })).toBeNull();
  });

  it("returns null for non-object payloads", () => {
    expect(shapeSeed(null, { seriesSlug: "briefing", taskId: "t" })).toBeNull();
    expect(shapeSeed(undefined, { seriesSlug: "briefing", taskId: "t" })).toBeNull();
    expect(shapeSeed("not-an-object", { seriesSlug: "briefing", taskId: "t" })).toBeNull();
  });

  it("tolerates missing citations (empty array)", () => {
    const seed = shapeSeed(
      { actor: "OpenAI", artifact: "o4", summary: "New model." },
      { seriesSlug: "briefing", taskId: "t" },
    );
    expect(seed).not.toBeNull();
    expect(seed.citations).toEqual([]);
  });

  it("caps citations at 5 to keep prompts compact", () => {
    const manyCitations = Array.from({ length: 10 }, (_, i) => ({ url: `https://example.com/${i}` }));
    const seed = shapeSeed(
      { actor: "x", artifact: "y", summary: "z", citations: manyCitations },
      { seriesSlug: "briefing", taskId: "t" },
    );
    expect(seed.citations.length).toBe(5);
  });

  it("accepts citations as plain URL strings too", () => {
    const seed = shapeSeed(
      { actor: "x", artifact: "y", summary: "z", citations: ["https://a.com", "https://b.com"] },
      { seriesSlug: "briefing", taskId: "t" },
    );
    expect(seed.citations).toEqual([{ url: "https://a.com" }, { url: "https://b.com" }]);
  });
});
