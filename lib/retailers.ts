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
