/**
 * Seed-adapter tests. Each adapter runs against a fixture x-intel-history
 * in an isolated tmp HOME so the real workspace is untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getSeedAdapter,
  hasSeedAdapter,
} from "../seed-adapters/index.mjs";
import {
  parseHighlight,
  leaksProduct,
  hash,
} from "../seed-adapters/_common.mjs";

const WS = "default";
let tmpHome;
const savedHome = process.env.HOME;

function seedHistory(rows) {
  const dir = join(tmpHome, ".ohwow", "workspaces", WS);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "x-intel-history.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n"),
  );
  writeFileSync(join(tmpHome, ".ohwow", "current-workspace"), WS);
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "yt-seed-test-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = savedHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("seed-adapters/_common", () => {
  it("parseHighlight splits permalink from text", () => {
    const got = parseHighlight('Claude shipped 4.6 (perma=/dwarkesh/status/12345)');
    expect(got.handle).toBe("dwarkesh");
    expect(got.text).toBe("Claude shipped 4.6");
    expect(got.url).toContain("x.com/dwarkesh/status/");
  });

  it("leaksProduct catches OHWOW self-references", () => {
    expect(leaksProduct("ohwow runs multiple workspaces")).toBe(true);
    expect(leaksProduct("our daemon syncs tasks")).toBe(true);
    expect(leaksProduct("Anthropic shipped Claude")).toBe(false);
  });

  it("hash is stable and short", () => {
    expect(hash("abc")).toBe(hash("abc"));
    expect(hash("abc")).not.toBe(hash("abd"));
    expect(hash("x").length).toBe(16);
  });
});

describe("seed-adapters/index", () => {
  it("knows the four v1 series", () => {
    expect(hasSeedAdapter("briefing")).toBe(true);
    expect(hasSeedAdapter("tomorrow-broke")).toBe(true);
    expect(hasSeedAdapter("mind-wars")).toBe(true);
    expect(hasSeedAdapter("operator-mode")).toBe(true);
  });

  it("bot-beats is deferred and throws on adapter lookup", () => {
    expect(hasSeedAdapter("bot-beats")).toBe(false);
    expect(() => getSeedAdapter("bot-beats")).toThrow(/deferred|not wired/);
  });
});

describe("briefing seed adapter", () => {
  it("picks an advancements row with headline + highlights", async () => {
    const today = new Date().toISOString().slice(0, 10);
    seedHistory([
      {
        date: today,
        bucket: "advancements",
        headline: "Anthropic shipped Claude 4.6",
        emerging_patterns: ["rate-limit loosening across frontier labs"],
        highlights: [
          'Claude 4.6 handles 1M context (perma=/dwarkesh/status/1)',
          'pricing drops 30% (perma=/swyx/status/2)',
          'benchmarks up 15% on SWE (perma=/alexalbert__/status/3)',
        ],
        posts: 42,
      },
    ]);
    const pick = getSeedAdapter("briefing");
    const seed = await pick({ workspace: WS, historyDays: 2 });
    expect(seed).not.toBeNull();
    expect(seed.kind).toBe("x-intel");
    expect(seed.title).toMatch(/Anthropic/);
    expect(seed.body).toContain("HEADLINE");
    expect(seed.citations.length).toBeGreaterThanOrEqual(3);
    expect(seed.metadata.bucket).toBe("advancements");
  });

  it("refuses rows that leak OHWOW product", async () => {
    const today = new Date().toISOString().slice(0, 10);
    seedHistory([
      {
        date: today,
        bucket: "advancements",
        headline: "OHWOW shipped a new orchestrator",
        emerging_patterns: ["local-first ai runtime trends"],
        highlights: ["ohwow announcement (perma=/acme/status/1)"],
      },
    ]);
    const pick = getSeedAdapter("briefing");
    const seed = await pick({ workspace: WS, historyDays: 2 });
    expect(seed).toBeNull();
  });

  it("returns null when the bucket has no advancements rows", async () => {
    const today = new Date().toISOString().slice(0, 10);
    seedHistory([
      { date: today, bucket: "hacks", headline: "tactical win", emerging_patterns: ["x"], highlights: [] },
    ]);
    const pick = getSeedAdapter("briefing");
    const seed = await pick({ workspace: WS, historyDays: 2 });
    expect(seed).toBeNull();
  });

  it("dedupes across runs — same headline returns null on second pick", async () => {
    const today = new Date().toISOString().slice(0, 10);
    seedHistory([
      {
        date: today,
        bucket: "advancements",
        headline: "one story",
        emerging_patterns: ["p"],
        highlights: ["a (perma=/x/status/1)", "b (perma=/y/status/2)", "c (perma=/z/status/3)"],
      },
    ]);
    const pick = getSeedAdapter("briefing");
    const first = await pick({ workspace: WS, historyDays: 2 });
    const second = await pick({ workspace: WS, historyDays: 2 });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});

describe("tomorrow-broke seed adapter", () => {
  it("picks a prediction with ≥0.35 confidence", async () => {
    const today = new Date().toISOString().slice(0, 10);
    seedHistory([
      {
        date: today,
        bucket: "advancements",
        headline: "placeholder",
        emerging_patterns: [],
        highlights: [],
        predictions: [
          { id: "p1", what: "half of new-hire SDRs replaced by AI by Q4 2027", by_when: "2027-12-31", confidence: 0.6, citations: [] },
        ],
      },
    ]);
    const pick = getSeedAdapter("tomorrow-broke");
    const seed = await pick({ workspace: WS, historyDays: 10 });
    expect(seed).not.toBeNull();
    expect(seed.kind).toBe("prediction");
    expect(seed.body).toMatch(/FORECAST/);
    expect(seed.metadata.prediction_id).toBeTruthy();
  });

  it("falls back to emerging_patterns when no predictions", async () => {
    const today = new Date().toISOString().slice(0, 10);
    seedHistory([
      {
        date: today,
        bucket: "advancements",
        headline: "x",
        emerging_patterns: ["workers at big-box retailers are retrained monthly by a central AI"],
        highlights: [],
      },
    ]);
    const pick = getSeedAdapter("tomorrow-broke");
    const seed = await pick({ workspace: WS, historyDays: 10 });
    expect(seed).not.toBeNull();
    expect(seed.kind).toBe("x-intel");
  });
});

describe("operator-mode seed adapter", () => {
  it("prefers the use-case bank when present", async () => {
    const today = new Date().toISOString().slice(0, 10);
    seedHistory([{ date: today, bucket: "hacks", headline: "h", emerging_patterns: ["fallback pattern"], highlights: [] }]);
    const ucPath = join(tmpHome, ".ohwow", "workspaces", WS, "operator-mode-use-cases.jsonl");
    writeFileSync(ucPath, JSON.stringify({
      id: "uc-1",
      pain: "sales team manually copy-pastes from Linkedin 4 hours a day",
      workflow: "Zapier + Claude + Google Sheets: 3-step scoring, then draft the email, then send via Instantly",
      outcome_metric: "3h/day saved per SDR",
      tools: ["Zapier", "Claude", "Instantly", "Google Sheets"],
      vertical: "B2B SaaS",
      team_size: "5-20",
    }) + "\n");
    const pick = getSeedAdapter("operator-mode");
    const seed = await pick({ workspace: WS, historyDays: 5 });
    expect(seed).not.toBeNull();
    expect(seed.kind).toBe("internal-archive");
    expect(seed.body).toMatch(/PAIN/);
    expect(seed.body).toMatch(/WORKFLOW/);
  });

  it("falls back to x-intel hacks when no bank entries", async () => {
    const today = new Date().toISOString().slice(0, 10);
    seedHistory([
      {
        date: today,
        bucket: "hacks",
        headline: "productivity",
        emerging_patterns: ["founders using Cursor + custom snippets to generate outbound"],
        highlights: ["template trick (perma=/a/status/1)"],
      },
    ]);
    const pick = getSeedAdapter("operator-mode");
    const seed = await pick({ workspace: WS, historyDays: 5 });
    expect(seed).not.toBeNull();
    expect(seed.kind).toBe("x-intel");
    expect(seed.metadata.source).toBe("x-intel-hacks");
  });
});

describe("mind-wars seed adapter", () => {
  it("returns a bootstrap question when KB is empty", async () => {
    // No KB setup; adapter should use bootstrap list.
    const pick = getSeedAdapter("mind-wars");
    const seed = await pick({ workspace: WS });
    expect(seed).not.toBeNull();
    expect(seed.kind).toBe("internal-archive");
    expect(seed.body).toMatch(/QUESTION|FRAME/);
  });

  it("marks seen questions so successive picks vary", async () => {
    const pick = getSeedAdapter("mind-wars");
    const seen = new Set();
    for (let i = 0; i < 5; i++) {
      const s = await pick({ workspace: WS });
      if (!s) break;
      seen.add(s.title);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
