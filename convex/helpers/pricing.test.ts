import { describe, it, expect } from "vitest";

import { resolveModelPricing, estimateCostUsd, PRICING_TABLE } from "./pricing";

describe("resolveModelPricing", () => {
  it("matches exact canonical names", () => {
    expect(resolveModelPricing("claude-sonnet-4-5")?.key).toBe("claude-sonnet-4-5");
    expect(resolveModelPricing("gpt-4o")?.key).toBe("gpt-4o");
    expect(resolveModelPricing("gemini-2.5-flash")?.key).toBe("gemini-2.5-flash");
  });

  it("is case-insensitive", () => {
    expect(resolveModelPricing("Claude-Sonnet-4-5")?.key).toBe("claude-sonnet-4-5");
    expect(resolveModelPricing("GPT-4O")?.key).toBe("gpt-4o");
  });

  it("matches provider-prefixed names", () => {
    expect(resolveModelPricing("anthropic/claude-sonnet-4-5")?.key).toBe("claude-sonnet-4-5");
    expect(resolveModelPricing("openai/gpt-4o")?.key).toBe("gpt-4o");
    expect(resolveModelPricing("google/gemini-1.5-pro")?.key).toBe("gemini-1.5-pro");
    expect(resolveModelPricing("vertex_ai/gemini-1.5-flash")?.key).toBe("gemini-1.5-flash");
  });

  it("matches versioned/dated variants via date-suffix stripping", () => {
    expect(resolveModelPricing("claude-3-5-sonnet-20241022")?.key).toBe("claude-3-5-sonnet");
    expect(resolveModelPricing("gpt-4o-2024-11-20")).toBeDefined();
  });

  it("matches -latest/-preview suffixed variants", () => {
    expect(resolveModelPricing("gemini-2.5-pro-latest")?.key).toBe("gemini-2.5-pro");
    expect(resolveModelPricing("o3-mini-preview")?.key).toBe("o3-mini");
  });

  it("prefers the longest matching key (most specific)", () => {
    // claude-3-5-haiku should not resolve to claude-3-haiku's shorter key.
    expect(resolveModelPricing("claude-3-5-haiku")?.key).toBe("claude-3-5-haiku");
  });

  it("returns undefined for unknown models", () => {
    expect(resolveModelPricing("totally-made-up-model-9000")).toBeUndefined();
    expect(resolveModelPricing("")).toBeUndefined();
  });

  it("handles non-string / nullish input defensively", () => {
    // @ts-expect-error intentionally passing wrong type to verify runtime guard
    expect(resolveModelPricing(undefined)).toBeUndefined();
    // @ts-expect-error intentionally passing wrong type to verify runtime guard
    expect(resolveModelPricing(null)).toBeUndefined();
  });

  it("every pricing table entry resolves to itself", () => {
    for (const key of Object.keys(PRICING_TABLE)) {
      expect(resolveModelPricing(key)?.key).toBe(key);
    }
  });
});

describe("estimateCostUsd", () => {
  it("computes cost for a known model", () => {
    const result = estimateCostUsd("claude-sonnet-4-5", 1_000_000, 1_000_000);
    expect(result.matched).toBe(true);
    expect(result.pricingKey).toBe("claude-sonnet-4-5");
    expect(result.costUsd).toBeCloseTo(3 + 15, 6);
  });

  it("computes cost proportionally for partial millions", () => {
    const result = estimateCostUsd("gpt-4o", 500_000, 250_000);
    expect(result.matched).toBe(true);
    expect(result.costUsd).toBeCloseTo(2.5 * 0.5 + 10 * 0.25, 6);
  });

  it("never guesses for unknown models: cost 0, matched false", () => {
    const result = estimateCostUsd("mystery-llm-v3", 100_000, 100_000);
    expect(result.matched).toBe(false);
    expect(result.costUsd).toBe(0);
    expect(result.pricingKey).toBeUndefined();
  });

  it("treats negative or non-finite token counts as zero rather than throwing", () => {
    const result = estimateCostUsd("gpt-4o", -5, Number.NaN);
    expect(result.matched).toBe(true);
    expect(result.costUsd).toBe(0);
  });

  it("handles zero tokens", () => {
    const result = estimateCostUsd("gpt-4o", 0, 0);
    expect(result.matched).toBe(true);
    expect(result.costUsd).toBe(0);
  });
});
