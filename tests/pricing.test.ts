import { describe, expect, it } from "vitest";
import { priceAppearsOnPage, priceExtractionSchema } from "@/lib/ai";
import type { Observation } from "@/lib/db/schema";
import { buildRows, enforceExactSku, latestByKey, median, summarizeRetailers, toCsv } from "@/lib/insights";
import { RETAILERS } from "@/lib/retailers";
import { compareSize, findPackOption, optionPriceOnPage, packLabel, packOfLabel, packRatio, parseSize } from "@/lib/size";
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
      packOption: null,
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
    packRatio: null,
    packOption: null,
    listedPrice: null,
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
    expect(rows[0].prices.target).toMatchObject({ status: "not_listed", price: null });
    // SKU 2 has identical prices, so it doesn't count toward the index.
    expect(summary.amazon.comparedSkus).toBe(1);

    const csv = toCsv(rows);
    expect(csv.split("\n")).toHaveLength(1 + 2 * 5);
    expect(csv).toContain("1,A,X,walmart,priced,9");
  });
});

describe("enforceExactSku", () => {
  const base = {
    id: 1, runId: 1, upc: "1", retailer: "walmart", status: "priced", price: 9, regularPrice: null, promo: null,
    availability: "in_stock", matchType: "exact", confidence: "high", source: "retailer_page", upcVerified: false,
    packRatio: null, packOption: null, listedPrice: null, url: "https://www.walmart.com/ip/1", productTitle: "Biotrue Solution 4 fl oz", notes: null, citations: null,
    costUsd: 0, observedAt: new Date(2026, 10, 17),
  } as Observation;
  const sku = { upc: "1", title: "Biotrue Original multi-purpose solution 4 fl oz (118 mL)", brand: "Biotrue" };

  it("keeps exact same-size matches", () => {
    expect(enforceExactSku(base, sku)).toBe(base);
  });

  it("marks wrong sizes and unconfirmed third-party prices as no match", () => {
    expect(enforceExactSku({ ...base, productTitle: "Biotrue Solution 10 fl oz" }, sku)).toMatchObject({ status: "not_listed", price: null });
    expect(enforceExactSku({ ...base, matchType: "different_size" }, sku)).toMatchObject({ status: "not_listed", price: null });
    expect(
      enforceExactSku({ ...base, retailer: "target", source: "third_party", url: "https://www.shipt.com/x" }, sku),
    ).toMatchObject({ status: "not_listed" });
  });
});

describe("size matching", () => {
  it("parses volumes, counts and packs", () => {
    expect(parseSize("Opcon-A Eye Drops 2 x 0.5 fl oz (15 mL)")).toMatchObject({ pack: 2 });
    expect(parseSize("blink NutriTears 50 ct Soft Gels").counts).toEqual([50]);
    expect(parseSize("Ocuvite Eye Performance Soft Gels, 30.0 ea").counts).toEqual([30]);
  });

  it("matches the same size across units and wording", () => {
    expect(compareSize("LUMIFY Eye Drops 0.08 fl oz (2.5 mL)", "Lumify Eye Drops for Redness Relief - 2.5ml : Target")).toBe("match");
    expect(compareSize("LUMIFY Eye Drops 0.25 fl oz (7.5 mL)", "LUMIFY® Redness Reliever Eye Drops, .25 fl oz - Kroger")).toBe("match");
    expect(compareSize("PreserVision AREDS 2 100 ct Soft Gels", "PreserVision, Eye Vitamins, AREDS2 with CoQ10, 100 Softgels")).toBe("match");
    expect(compareSize("Soothe XP 2 x 0.5 fl oz (15 mL)", "Soothe XP Lubricant Eye Drops, Twin Pack, 0.5 fl oz")).toBe("match");
    expect(compareSize("Soothe Night Time Ointment 0.125 oz (3.5 g)", "Soothe Nighttime Dry Eye Ointment, 1/8 Oz : Target")).toBe("match");
  });

  it("flags different sizes and packs", () => {
    expect(compareSize("Biotrue Original multi-purpose solution 4 fl oz (118 mL)", "Biotrue Multi-Purpose Contact Lens Solution & Cleaner with Lens Case, 10 fl oz")).toBe("conflict");
    expect(compareSize("Ocuvite Adult 50 + 90 ct Soft Gels", "(2 pack) Ocuvite Adult 50 Plus Softgels, 90 Count - Walmart.com")).toBe("conflict");
    expect(compareSize("PreserVision AREDS 2 Formula 90 ct Soft Gels", "PreserVision AREDS 2 Softgels - 120ct : Target")).toBe("conflict");
  });

  it("reports unknown when the listing shows no size, and no_size when the SKU has none", () => {
    expect(compareSize("Blink GelTears 0.34 fl oz (10 mL)", "Walgreens | Walgreens")).toBe("unknown");
    expect(compareSize("Soothe XP 2 x 0.5 fl oz (15 mL)", "Soothe XP Lubricant Eye Drops 0.5 fl oz")).toBe("unknown");
    expect(compareSize("Biotrue Hydration Boost Dry Eye Drops", "Biotrue Hydration Boost 10 ml")).toBe("no_size");
  });
});

describe("multi-pack normalization", () => {
  it("detects a different pack of the same unit size", () => {
    expect(packRatio("Ocuvite Adult 50 + 90 ct Soft Gels", "(2 pack) Ocuvite Adult 50 Plus Softgels, 90 Count")).toBe(2);
    expect(packRatio("Biotrue solution 10 fl oz (300 mL)", "Biotrue Multi-Purpose Solution, 10 fl oz, Pack of 3")).toBe(3);
    expect(packRatio("Soothe XP 2 x 0.5 fl oz (15 mL)", "Soothe XP Lubricant Eye Drops 0.5 fl oz (Pack of 1)")).toBe(0.5);
    expect(packLabel(2)).toBe("÷2");
    expect(packLabel(0.5)).toBe("×2");
  });

  it("does not treat a different unit size or an implicit pack as a pack", () => {
    expect(packRatio("Ocuvite 90 ct Soft Gels", "(2 pack) Ocuvite Softgels, 120 Count")).toBeNull();
    expect(packRatio("Biotrue 4 fl oz", "Biotrue 10 fl oz")).toBeNull();
    expect(packRatio("Ocuvite 90 ct Soft Gels", "Ocuvite Softgels, 90 Count")).toBeNull();
  });

  it("normalizes stored multi-pack prices and keeps them comparable", () => {
    const o = {
      id: 1, runId: 1, upc: "1", retailer: "walmart", status: "priced", price: 30, regularPrice: null, promo: null,
      availability: "in_stock", matchType: "different_size", confidence: "high", source: "retailer_page",
      upcVerified: false, packRatio: null, packOption: null, listedPrice: null, url: "https://www.walmart.com/ip/1",
      productTitle: "(2 pack) Ocuvite Adult 50 Plus Softgels, 90 Count", notes: null, citations: null, costUsd: 0,
      observedAt: new Date(2026, 10, 17),
    } as Observation;
    const out = enforceExactSku(o, { upc: "1", title: "Ocuvite Adult 50 + 90 ct Soft Gels", brand: "Ocuvite" });
    expect(out).toMatchObject({ status: "priced", matchType: "exact", price: 15, listedPrice: 30, packRatio: 2 });
    // A price already taken from the page's "Single" option is left alone, not divided again.
    const single = { ...o, matchType: "exact", price: 9.74, packOption: "Single" } as Observation;
    expect(enforceExactSku(single, { upc: "1", title: "Ocuvite Adult 50 + 90 ct Soft Gels", brand: "Ocuvite" })).toBe(single);
  });
});

describe("pack-size options", () => {
  const walmart2Pack = "Pack Size: 2 Pack\nSingle, $9.74, $9.74/fl oz\nSingle $9.74$9.74/fl oz\n2 Pack $18.99$9.50/fl oz\nCurrent price is USD$18.99";

  it("reads the pack count from option labels", () => {
    expect(packOfLabel("Single")).toBe(1);
    expect(packOfLabel("1 Count")).toBe(1);
    expect(packOfLabel("2 Pack")).toBe(2);
    expect(packOfLabel("Pack of 3")).toBe(3);
    expect(packOfLabel("Mint")).toBeNull();
  });

  it("requires the option label and its price together on the page", () => {
    expect(optionPriceOnPage("Single", 9.74, walmart2Pack)).toBe(true);
    expect(optionPriceOnPage("2 Pack", 18.99, walmart2Pack)).toBe(true);
    expect(optionPriceOnPage("Single", 18.99, walmart2Pack)).toBe(false);
    expect(optionPriceOnPage("Single", 9.7, walmart2Pack)).toBe(false);
  });
});

describe("findPackOption", () => {
  const page = "Pack Size: 2 Pack\n\nSingle, $9.74, $9.74/fl oz\n\nSingle $9.74$9.74/fl oz\n\n2 Pack $18.99$9.50/fl oz";
  it("reads the SKU's pack option from a pack-size selector", () => {
    expect(findPackOption(page, 1)).toEqual({ label: "Single", price: 9.74 });
    expect(findPackOption(page, 2)).toEqual({ label: "2 Pack", price: 18.99 });
    expect(findPackOption(page, 3)).toBeNull();
    expect(findPackOption("Single $9.74", 1)).toBeNull(); // no selector on the page
  });
});
