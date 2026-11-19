import { describe, expect, it } from "vitest";
import type { Observation } from "@/lib/db/schema";
import { GOLDEN_SET, scoreItem, summarize, type GoldenItem } from "@/lib/eval";

const verifiedAt = new Date("2026-11-18T19:30:00Z");
const item = (expected: Partial<GoldenItem["expected"]>, url = "https://www.walmart.com/ip/10448594"): GoldenItem => ({
  upc: "310119056110",
  retailer: "walmart",
  stratum: "test",
  basis: "online",
  expected: { status: "priced", price: 10, availability: "in_stock", ...expected },
  url,
  notes: "",
});
const obs = (o: Partial<Observation>): Observation =>
  ({
    id: 1, runId: 1, upc: "310119056110", retailer: "walmart", status: "priced", price: 10, regularPrice: null, promo: null,
    availability: "in_stock", matchType: "exact", confidence: "high", source: "retailer_page", packRatio: null, packOption: null,
    listedPrice: null, priceBasis: null, upcVerified: false, url: "https://www.walmart.com/ip/Some-Slug/10448594", productTitle: null, notes: null,
    citations: null, costUsd: 0, observedAt: new Date("2026-11-18T07:30:00Z"), ...o,
  }) as Observation;

describe("eval scoring", () => {
  it("loads and validates the golden set", () => {
    expect(GOLDEN_SET.items.length).toBeGreaterThan(10);
  });

  it("classifies price outcomes", () => {
    expect(scoreItem(item({}), obs({ price: 10 }), verifiedAt).outcome).toBe("exact");
    expect(scoreItem(item({}), obs({ price: 10.4 }), verifiedAt).outcome).toBe("close");
    expect(scoreItem(item({}), obs({ price: 12 }), verifiedAt).outcome).toBe("wrong_price");
    expect(scoreItem(item({}), obs({ status: "not_listed", price: null }), verifiedAt).outcome).toBe("missed");
    expect(scoreItem(item({}), null, verifiedAt).outcome).toBe("not_run");
    const absent = item({ status: "not_listed", price: null });
    expect(scoreItem(absent, obs({ price: 8 }), verifiedAt).outcome).toBe("false_price");
    expect(scoreItem(absent, obs({ status: "no_price", price: null }), verifiedAt).outcome).toBe("correct_absent");
  });

  it("measures freshness and flags stale reads from the same page", () => {
    const r = scoreItem(item({}), obs({ price: 12 }), verifiedAt);
    expect(r.lagHours).toBe(12);
    expect(r.fresh).toBe(true);
    expect(r.likelyStale).toBe(true);
    const otherPage = scoreItem(item({}), obs({ price: 12, url: "https://www.walmart.com/ip/999999999" }), verifiedAt);
    expect(otherPage.likelyStale).toBe(false);
    expect(scoreItem(item({}), obs({ observedAt: new Date("2026-11-16T00:00:00Z") }), verifiedAt).fresh).toBe(false);
    expect(scoreItem(item({}), obs({ availability: "out_of_stock" }), verifiedAt).availabilityMatch).toBe(false);
  });

  it("doesn't count prices read at different stores as wrong", () => {
    const kroger = { ...item({}, "https://www.kroger.com/p/item/0031011905421"), retailer: "kroger" as const, basis: "kroger:browser-default" };
    const exa = obs({ retailer: "kroger", price: 8.5, url: "https://www.kroger.com/p/item/0031011905421" });
    const r = scoreItem(kroger, exa, verifiedAt);
    expect(r.observedBasis).toBe("kroger:exa-default");
    expect(r.outcome).toBe("different_basis");
    expect(r.likelyStale).toBe(false);
    // Agreement across bases still counts, and same-basis disagreement is still wrong.
    expect(scoreItem(kroger, obs({ retailer: "kroger", price: 10 }), verifiedAt).outcome).toBe("exact");
    expect(scoreItem({ ...kroger, basis: "kroger:exa-default" }, exa, verifiedAt).outcome).toBe("wrong_price");
    const s = summarize([{ ...r, title: "" }]);
    expect(s.differentBasis).toBe(1);
    expect(s.evaluated).toBe(0);
  });

  it("summarizes rates", () => {
    const rows = [
      scoreItem(item({}), obs({ price: 10 }), verifiedAt),
      scoreItem(item({}), obs({ price: 20 }), verifiedAt),
      scoreItem(item({ status: "not_listed", price: null }), obs({ price: 5 }), verifiedAt),
    ].map((r) => ({ ...r, title: "" }));
    const s = summarize(rows);
    expect(s.exactRate).toBe(0.5);
    expect(s.falsePriceRate).toBe(1);
    expect(s.overallAccuracy).toBeCloseTo(1 / 3);
  });
});
