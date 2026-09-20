import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  canonicalModelId,
  modelTokens,
  scoreModelMatch,
  bestModelMatch,
  MATCH_TIER,
} from "open-sse/services/modelMatch.js";
import {
  markAutoComboHealthy,
  markAutoComboUnavailable,
  isAutoComboDisabled,
  autoComboDisabledUntil,
  partitionByHealth,
  getAutoComboHealth,
  resetAutoComboHealth,
} from "open-sse/services/autoComboHealth.js";

// Auto-combo turns a bare model name into a fallback chain across every
// provider that carries the model. Two halves are covered here: deciding which
// provider spellings mean the same model, and remembering which members failed.

describe("modelMatch — canonicalization", () => {
  it("collapses separators, case and vendor prefix", () => {
    expect(canonicalModelId("gpt-5.6-sol")).toBe("gpt56sol");
    expect(canonicalModelId("GPT_5_6_SOL")).toBe("gpt56sol");
    expect(canonicalModelId("openai/gpt-5.6-sol")).toBe("gpt56sol");
    expect(canonicalModelId("vendor/sub/gpt-5.6-sol")).toBe("gpt56sol");
  });

  it("drops tags and parentheticals that name a catalog, not a model", () => {
    expect(canonicalModelId("qwen/qwen3:free")).toBe("qwen3");
    expect(canonicalModelId("claude-sonnet-4.5 (beta)")).toBe("claudesonnet45");
  });

  it("tokenizes digits and letters alike regardless of spelling", () => {
    expect(modelTokens("gpt-5.6-sol")).toEqual(["gpt", "5", "6", "sol"]);
    expect(modelTokens("gpt56sol")).toEqual(["gpt", "56", "sol"]);
  });
});

describe("modelMatch — tiers", () => {
  it("scores an identical id as exact", () => {
    expect(scoreModelMatch("gpt-5.6-sol", "gpt-5.6-sol")).toMatchObject({ tier: MATCH_TIER.EXACT });
  });

  it("treats separator and vendor variants as the same model", () => {
    expect(scoreModelMatch("gpt-5.6-sol", "gpt-5-6-sol")).toMatchObject({ tier: MATCH_TIER.CANONICAL });
    expect(scoreModelMatch("gpt-5.6-sol", "openai/gpt-5.6-sol")).toMatchObject({ tier: MATCH_TIER.CANONICAL });
    expect(scoreModelMatch("gpt-5.6-sol", "GPT_5_6_Sol")).toMatchObject({ tier: MATCH_TIER.CANONICAL });
  });

  it("looks past release-channel and snapshot decoration", () => {
    for (const decorated of [
      "gpt-5.6-sol-latest",
      "gpt-5.6-sol-preview",
      "gpt-5-6-sol-20260918",
      "gpt-5.6-sol:free",
    ]) {
      expect(scoreModelMatch("gpt-5.6-sol", decorated)?.tier).toBeLessThanOrEqual(MATCH_TIER.DECORATED);
    }
  });

  it("accepts a short variant affix as a weaker match", () => {
    const m = scoreModelMatch("gpt-5.6-sol", "gpt-5-6-solm");
    expect(m).toMatchObject({ tier: MATCH_TIER.VARIANT });
    expect(m.score).toBeGreaterThan(scoreModelMatch("gpt-5.6-sol", "gpt-5-6-sol").score);
  });

  it("tolerates a typo within the near-match budget", () => {
    expect(scoreModelMatch("claude-sonnet-4.5", "claude-sonnet-45")?.tier).toBeLessThanOrEqual(MATCH_TIER.NEAR);
  });

  it("does not match a genuinely different model", () => {
    expect(scoreModelMatch("gpt-5.6-sol", "claude-sonnet-4.5")).toBeNull();
    expect(scoreModelMatch("gpt-5.6-sol", "gemini-3-pro")).toBeNull();
    expect(scoreModelMatch("gpt-4o", "gpt-4o-audio-preview-2024-12-17")?.tier).not.toBe(MATCH_TIER.EXACT);
  });

  it("never lets a loose match outrank an exact one", () => {
    const best = bestModelMatch("gpt-5.6-sol", [
      "gpt-5-6-solm",
      "gpt-5.6-sol-latest",
      "gpt-5.6-sol",
      "gpt-5-6-sol",
    ]);
    expect(best.candidate).toBe("gpt-5.6-sol");
    expect(best.tier).toBe(MATCH_TIER.EXACT);
  });

  it("prefers the plain id over a decorated sibling when both are inexact", () => {
    const best = bestModelMatch("gpt-5.6-sol", ["gpt-5-6-sol-latest", "gpt-5-6-sol"]);
    expect(best.candidate).toBe("gpt-5-6-sol");
  });

  it("honours a tier ceiling", () => {
    const candidates = ["gpt-5-6-solm"];
    expect(bestModelMatch("gpt-5.6-sol", candidates)).not.toBeNull();
    expect(bestModelMatch("gpt-5.6-sol", candidates, { maxTier: MATCH_TIER.CANONICAL })).toBeNull();
  });

  it("ignores empty and non-string candidates", () => {
    expect(bestModelMatch("gpt-5.6-sol", [null, undefined, "", "   ", 42])).toBeNull();
  });
});

describe("autoComboHealth", () => {
  beforeEach(() => {
    resetAutoComboHealth();
    vi.useRealTimers();
  });

  it("benches a member after a failure and frees it when the cooldown lapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));

    markAutoComboUnavailable("prov-a/gpt-5.6-sol", 429, "rate limited");
    expect(isAutoComboDisabled("prov-a/gpt-5.6-sol")).toBe(true);

    vi.setSystemTime(new Date("2026-09-20T00:01:00Z"));
    expect(isAutoComboDisabled("prov-a/gpt-5.6-sol")).toBe(true);

    vi.setSystemTime(new Date("2026-09-20T00:05:00Z"));
    expect(isAutoComboDisabled("prov-a/gpt-5.6-sol")).toBe(false);
    vi.useRealTimers();
  });

  it("backs off further on each consecutive failure", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
    const first = markAutoComboUnavailable("prov-a/m", 500);
    const second = markAutoComboUnavailable("prov-a/m", 500);
    expect(second - Date.now()).toBeGreaterThan(first - Date.now());
    vi.useRealTimers();
  });

  it("respects an upstream reset further out than the ladder step", () => {
    const resetAt = Date.now() + 12 * 60 * 60 * 1000;
    const until = markAutoComboUnavailable("prov-a/m", 429, "quota", resetAt);
    expect(until).toBe(resetAt);
  });

  it("clears the strike on success", () => {
    markAutoComboUnavailable("prov-a/m", 500);
    expect(isAutoComboDisabled("prov-a/m")).toBe(true);
    markAutoComboHealthy("prov-a/m");
    expect(isAutoComboDisabled("prov-a/m")).toBe(false);
    expect(autoComboDisabledUntil("prov-a/m")).toBe(0);
  });

  it("is case-insensitive about member ids", () => {
    markAutoComboUnavailable("Prov-A/GPT-5.6-Sol", 500);
    expect(isAutoComboDisabled("prov-a/gpt-5.6-sol")).toBe(true);
  });

  it("partitions members, ordering benched ones by soonest eligible", () => {
    markAutoComboUnavailable("prov-b/m", 429, "x", Date.now() + 60 * 60 * 1000);
    markAutoComboUnavailable("prov-c/m", 429, "x", Date.now() + 10 * 60 * 1000);

    const { healthy, disabled } = partitionByHealth(["prov-a/m", "prov-b/m", "prov-c/m"]);
    expect(healthy).toEqual(["prov-a/m"]);
    expect(disabled).toEqual(["prov-c/m", "prov-b/m"]);
  });

  it("reports why a member was benched", () => {
    markAutoComboUnavailable("prov-a/m", 402, "payment required");
    const [entry] = getAutoComboHealth();
    expect(entry).toMatchObject({ member: "prov-a/m", failures: 1, disabled: true, lastStatus: 402 });
    expect(entry.lastError).toContain("payment required");
  });

  it("resets one member without touching the rest", () => {
    markAutoComboUnavailable("prov-a/m", 500);
    markAutoComboUnavailable("prov-b/m", 500);
    resetAutoComboHealth("prov-a/m");
    expect(isAutoComboDisabled("prov-a/m")).toBe(false);
    expect(isAutoComboDisabled("prov-b/m")).toBe(true);
  });
});
