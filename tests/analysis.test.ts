import { describe, expect, it } from "vitest";
import { analysisSchema } from "@/lib/ai";

describe("analysisSchema", () => {
  it("accepts a valid analysis result", () => {
    const result = analysisSchema.safeParse({
      summary: "The customer is unhappy about a late delivery.",
      sentiment: "negative",
      topics: ["shipping delay", "customer support"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown sentiment", () => {
    const result = analysisSchema.safeParse({
      summary: "Some summary",
      sentiment: "angry",
      topics: ["misc"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty topics", () => {
    const result = analysisSchema.safeParse({
      summary: "Some summary",
      sentiment: "neutral",
      topics: [],
    });
    expect(result.success).toBe(false);
  });
});
