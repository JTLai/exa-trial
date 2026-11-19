import { krogerProductCode } from "./upc";

export const RETAILER_IDS = ["walmart", "target", "amazon", "walgreens", "kroger"] as const;
export type RetailerId = (typeof RETAILER_IDS)[number];

export type Retailer = {
  id: RetailerId;
  name: string;
  domain: string;
  /** Product page URL derivable from the UPC alone, when the retailer supports it. */
  directUrl?: (upc: string) => string;
  /** How the price is sourced. Target hides prices from crawlers, so it falls back to Exa deep search. */
  priceVia: "retailer_page" | "deep_search";
};

export const RETAILERS: Record<RetailerId, Retailer> = {
  walmart: { id: "walmart", name: "Walmart", domain: "walmart.com", priceVia: "retailer_page" },
  target: { id: "target", name: "Target", domain: "target.com", priceVia: "deep_search" },
  amazon: { id: "amazon", name: "Amazon", domain: "amazon.com", priceVia: "retailer_page" },
  walgreens: { id: "walgreens", name: "Walgreens", domain: "walgreens.com", priceVia: "retailer_page" },
  kroger: {
    id: "kroger",
    name: "Kroger",
    domain: "kroger.com",
    priceVia: "retailer_page",
    // Kroger product URLs are keyed by the UPC (any slug works).
    directUrl: (upc) => `https://www.kroger.com/p/item/${krogerProductCode(upc)}`,
  },
};

/** Kroger pages show whichever store the crawler's location maps to; we can't choose it. */
export const KROGER_EXA_BASIS = "kroger:exa-default";

/**
 * Which price an observation represents, so only like-for-like prices are compared:
 * "online" = national ship-to-home price; "kroger:<locationId>" = one Kroger store (Kroger has no national price).
 * Rows from before priceBasis existed were all Exa lookups.
 */
export function priceBasisOf(o: { retailer: string; priceBasis?: string | null }): string {
  return o.priceBasis ?? (o.retailer === "kroger" ? KROGER_EXA_BASIS : "online");
}

export function describeBasis(basis: string): string {
  if (basis === "online") return "online price";
  if (basis === KROGER_EXA_BASIS) return "Kroger store Exa's crawler lands on";
  if (basis === "kroger:browser-default") return "Kroger store the browser was assigned";
  return basis.startsWith("kroger:") ? `Kroger store ${basis.slice(7)}` : basis;
}
