import { describe, expect, it } from "vitest";
import { exaMisses, normalizeToSku, parseAgentOutput, scoreCheck } from "@/lib/browser-use";
import type { BrowserCheck } from "@/lib/db/schema";
import type { EvalRow, GoldenItem } from "@/lib/eval";

const item = (expected: Partial<GoldenItem["expected"]>, retailer: GoldenItem["retailer"] = "walgreens"): GoldenItem => ({
  upc: "324208385562",
  retailer,
  stratum: "test",
  basis: retailer === "kroger" ? "kroger:browser-default" : "online",
  expected: { status: "priced", price: 59.98, listedPrice: 29.99, packRatio: 0.5, availability: "in_stock", ...expected },
  url: "https://www.walgreens.com/store/c/x/ID=prod352379-product",
  notes: "",
});
const check = (c: Partial<BrowserCheck>): BrowserCheck =>
  ({
    id: 1, upc: "324208385562", retailer: "walgreens", tool: "browserless", status: "priced", price: 29.99, productTitle: null,
    availability: "in_stock", notes: null, url: "https://x", detail: null, durationMs: 1000,
    startedAt: new Date(), finishedAt: new Date(), ...c,
  }) as BrowserCheck;

describe("browser-use scoring", () => {
  it("normalizes a listing price to the SKU's pack like the golden set", () => {
    expect(normalizeToSku(item({}), 29.99)).toEqual({ price: 59.98, normalized: true });
    expect(normalizeToSku(item({}), 59.98)).toEqual({ price: 59.98, normalized: false });
    expect(normalizeToSku(item({ listedPrice: undefined, packRatio: undefined }), 29.99).normalized).toBe(false);
  });

  it("scores tool reads with the Eval outcomes", () => {
    expect(scoreCheck(item({}), check({})).outcome).toBe("exact");
    expect(scoreCheck(item({}), check({ status: "no_price", price: null })).outcome).toBe("missed");
    expect(scoreCheck(item({}), check({ status: "error", price: null })).outcome).toBe("error");
    expect(scoreCheck(item({}), check({ status: "running", price: null })).outcome).toBe("running");
    const absent = item({ status: "not_listed", price: null, listedPrice: undefined, packRatio: undefined });
    expect(scoreCheck(absent, check({ price: 9.68 })).outcome).toBe("false_price");
    expect(scoreCheck(absent, check({ status: "no_price", price: null })).outcome).toBe("correct_absent");
  });

  it("treats a different Kroger store's price as not comparable", () => {
    const k = item({ price: 10.99, listedPrice: undefined, packRatio: undefined }, "kroger");
    expect(scoreCheck(k, check({ retailer: "kroger", price: 10.49 })).outcome).toBe("different_basis");
    expect(scoreCheck(k, check({ retailer: "kroger", price: 10.99 })).outcome).toBe("exact");
  });

  it("parses agent answers", () => {
    expect(parseAgentOutput('Here: {"price": 29.99, "productTitle": "Muro", "inStock": true, "notes": ""}')).toMatchObject({ price: 29.99 });
    expect(parseAgentOutput("It costs $1,024.50 today")).toMatchObject({ price: 1024.5 });
  });

  it("lists only cases Exa got wrong", () => {
    const rows = ["exact", "correct_absent", "missed", "wrong_price"].map((outcome) => ({ outcome }) as EvalRow);
    expect(exaMisses(rows).map((r) => r.outcome)).toEqual(["missed", "wrong_price"]);
  });
});
