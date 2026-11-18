import { describe, expect, it } from "vitest";
import { priceAppearsOnPage, priceExtractionSchema } from "@/lib/ai";
import type { Observation } from "@/lib/db/schema";
import { buildRows, latestByKey, median, summarizeRetailers, toCsv } from "@/lib/insights";
import { RETAILERS } from "@/lib/retailers";
import { brandOf } from "@/lib/skus";
import { gtinMatches, krogerProductCode, normalizeGtin } from "@/lib/upc";

describe("UPC helpers", () => {
  it("normalizes GTIN-14 and UPC-A to the same digits", () => {
    expect(normalizeGtin("00310119537251")).toBe(normalizeGtin("310119537251"));
  });

  it("builds Kroger's 13-digit code by dropping the check digit", () => {
    expect(krogerProductCode("310119537251")).toBe("0031011953725");
    expect(krogerProductCode("047144073385")).toBe("0004714407338");
    expect(RETAILERS.kroger.directUrl?.("324208697627")).toBe("https://www.kroger.com/p/item/0032420869762");
  });

  it("matches GTINs across formats and rejects other products", () => {
    expect(gtinMatches("310119537251", "00310119537251")).toBe(true);
    expect(gtinMatches("310119537251", "0031011953725")).toBe(true);
    expect(gtinMatches("310119537251", "243926583459")).toBe(false);
    expect(gtinMatches("310119537251", null)).toBe(false);
  });
});

describe("priceAppearsOnPage", () => {
  const page = (text: string, price: number | null = null) => ({
    text,
    structured: price == null ? null : { gtin: null, price, availability: null, seller: null },
  });

  it("finds prices in common renderings", () => {
    expect(priceAppearsOnPage(22.99, page("$22.99$22.99\n$91.96/fl oz"))).toBe(true);
    expect(priceAppearsOnPage(21.99, page("Price: $ 21. 99 List"))).toBe(true);
    expect(priceAppearsOnPage(18.99, page("Price: 18.99 USD."))).toBe(true);
  });

  it("accepts structured-data prices and rejects prices not on the page", () => {
    expect(priceAppearsOnPage(30.99, page("List Price: $40.99", 30.99))).toBe(true);
    expect(priceAppearsOnPage(4.69, page("4.69 out of 5 stars"))).toBe(true); // why we also require a match + LLM rules
    expect(priceAppearsOnPage(12.99, page("$112.99"))).toBe(false);
    expect(priceAppearsOnPage(9.99, page("$19.99"))).toBe(false);
  });
});

describe("priceExtractionSchema", () => {
  it("accepts a valid extraction and rejects negative prices", () => {
    const valid = {
      matchedIndex: 0,
      matchType: "exact",
      price: 22.99,
      regularPrice: null,
      promo: null,
      availability: "in_stock",
      confidence: "high",
      notes: "UPC verified.",
    };
    expect(priceExtractionSchema.safeParse(valid).success).toBe(true);
    expect(priceExtractionSchema.safeParse({ ...valid, price: -1 }).success).toBe(false);
  });
});

describe("brandOf", () => {
  it("maps titles to brand families", () => {
    expect(brandOf("PreserVision AREDS 2 Formula 120 ct")).toBe("PreserVision");
    expect(brandOf("2x16+2oz renu Advance MPS")).toBe("renu");
    expect(brandOf("0.34 FL OZ (10mL) Blink Boost")).toBe("blink");
  });
});

describe("insights", () => {
  let id = 0;
  const obs = (upc: string, retailer: string, price: number | null, extra: Partial<Observation> = {}): Observation => ({
    id: ++id,
    runId: 1,
    upc,
    retailer,
    status: price == null ? "not_listed" : "priced",
    price,
    regularPrice: null,
    promo: null,
    availability: "in_stock",
    matchType: price == null ? "not_found" : "exact",
    confidence: "high",
    source: "retailer_page",
    upcVerified: true,
    url: null,
    productTitle: null,
    notes: null,
    citations: null,
    costUsd: 0,
    observedAt: new Date(2026, 10, 17),
    ...extra,
  });

  it("computes median", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it("keeps the newest observation per retailer and indexes retailers against the SKU median", () => {
    const skuList = [{ upc: "1", title: "A", brand: "X" }, { upc: "2", title: "B", brand: "X" }];
    const rows = buildRows(
      skuList,
      latestByKey([
        // newest first
        obs("1", "walmart", 9),
        obs("1", "walmart", 50), // older, ignored
        obs("1", "amazon", 10),
        obs("1", "kroger", 11),
        obs("1", "target", 5, { matchType: "different_size" }), // not comparable
        obs("2", "walmart", 20),
        obs("2", "amazon", 20),
      ]),
    );
    expect(rows[0]).toMatchObject({ min: 9, max: 11, median: 10 });
    const summary = Object.fromEntries(summarizeRetailers(rows).map((s) => [s.retailer, s]));
    expect(summary.walmart.avgIndexPct).toBeCloseTo(-10);
    expect(summary.walmart.lowestCount).toBe(1);
    expect(summary.kroger.highestCount).toBe(1);
    expect(summary.target.priced).toBe(0);
    // SKU 2 has identical prices, so it doesn't count toward the index.
    expect(summary.amazon.comparedSkus).toBe(1);

    const csv = toCsv(rows);
    expect(csv.split("\n")).toHaveLength(1 + 2 * 5);
    expect(csv).toContain("1,A,X,walmart,priced,9");
  });
});
