/**
 * Regression coverage for the publish-draft visibility gate + the
 * 2026-04-18 founder-confirmed public override.
 *
 * Policy (pinned):
 *   - Default / autopilot: --visibility=public requires ≥N prior applied
 *     unlisted rows for the series (autopilot guard, N = 5).
 *   - Human-in-the-loop override: when BOTH --yes AND an explicit
 *     --visibility=public are supplied, the gate is bypassed with an
 *     audit-visible warning. The guard is preserved for every other
 *     path.
 *   - Non-public visibility (unlisted, private) never hits the gate.
 *
 * The exported helper evaluatePublicVisibilityGate is a pure function
 * so this test doesn't need to mock the Studio browser session or
 * execute the cmdPublishDraft wrapper.
 */
import { describe, it, expect } from "vitest";

import { evaluatePublicVisibilityGate } from "../_publish-briefing.mjs";

const THRESHOLD = 5;

describe("evaluatePublicVisibilityGate — autopilot guard preserved", () => {
  it("refuses --visibility=public when --yes is passed alone (no explicit visibility)", () => {
    // Caller flipped --yes but didn't actually pass --visibility=public on
    // the CLI; visibility resolved to 'public' via the approval row's
    // stored payload. The human-in-the-loop override requires BOTH
    // flags to be present, so the gate still fires.
    const result = evaluatePublicVisibilityGate({
      visibility: "public",
      explicitVisibility: undefined,
      confirmedYes: true,
      priorAppliedUnlisted: 0,
      threshold: THRESHOLD,
    });
    expect(result.allowed).toBe(false);
    expect(result.override).toBe(false);
    expect(result.reason).toMatch(/need ≥5 applied unlisted/);
  });

  it("refuses --visibility=public when the flag is passed but --yes is absent", () => {
    const result = evaluatePublicVisibilityGate({
      visibility: "public",
      explicitVisibility: "public",
      confirmedYes: false,
      priorAppliedUnlisted: 0,
      threshold: THRESHOLD,
    });
    expect(result.allowed).toBe(false);
    expect(result.override).toBe(false);
    expect(result.reason).toMatch(/need ≥5 applied unlisted/);
  });

  it("allows --visibility=public on the happy autopilot path (≥N prior applied unlisted)", () => {
    // Day 6+ case: the series has 5 unlisted rows in the approvals
    // queue, so the autopilot guard opens on its own without any
    // override. override=false because we didn't apply it.
    const result = evaluatePublicVisibilityGate({
      visibility: "public",
      explicitVisibility: "public",
      confirmedYes: false,
      priorAppliedUnlisted: THRESHOLD,
      threshold: THRESHOLD,
    });
    expect(result.allowed).toBe(true);
    expect(result.override).toBe(false);
    expect(result.reason).toBeNull();
  });
});

describe("evaluatePublicVisibilityGate — founder-confirmed public override", () => {
  it("bypasses the gate when BOTH --yes AND --visibility=public are explicitly passed", () => {
    const result = evaluatePublicVisibilityGate({
      visibility: "public",
      explicitVisibility: "public",
      confirmedYes: true,
      priorAppliedUnlisted: 0,
      threshold: THRESHOLD,
    });
    expect(result.allowed).toBe(true);
    expect(result.override).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("still honors the override when explicitVisibility is mixed-case PUBLIC", () => {
    const result = evaluatePublicVisibilityGate({
      visibility: "public",
      explicitVisibility: "PUBLIC",
      confirmedYes: true,
      priorAppliedUnlisted: 0,
      threshold: THRESHOLD,
    });
    expect(result.allowed).toBe(true);
    expect(result.override).toBe(true);
  });
});

describe("evaluatePublicVisibilityGate — non-public paths untouched", () => {
  it("allows unlisted visibility regardless of flags / count", () => {
    const result = evaluatePublicVisibilityGate({
      visibility: "unlisted",
      explicitVisibility: "unlisted",
      confirmedYes: false,
      priorAppliedUnlisted: 0,
      threshold: THRESHOLD,
    });
    expect(result.allowed).toBe(true);
    expect(result.override).toBe(false);
  });

  it("allows private visibility regardless of flags / count", () => {
    const result = evaluatePublicVisibilityGate({
      visibility: "private",
      explicitVisibility: undefined,
      confirmedYes: false,
      priorAppliedUnlisted: 0,
      threshold: THRESHOLD,
    });
    expect(result.allowed).toBe(true);
    expect(result.override).toBe(false);
  });
});
