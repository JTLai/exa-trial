import type { Observation, Sku } from "./db/schema";
import { RETAILER_IDS, type RetailerId } from "./retailers";

export type SkuRow = Sku & {
  prices: Partial<Record<RetailerId, Observation>>;
  /** Stats over comparable prices only (exact match, priced). */
  min: number | null;
  max: number | null;
  median: number | null;
};

export type RetailerSummary = {
  retailer: RetailerId;
  priced: number;
  /** Average of (retailer price / SKU median − 1) across SKUs priced at ≥2 retailers. Negative = cheaper. */
  avgIndexPct: number | null;
  comparedSkus: number;
  lowestCount: number;
  highestCount: number;
};

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** A price is comparable across retailers only if it's for the exact SKU. */
export function isComparable(o: Observation | undefined): o is Observation & { price: number } {
  return !!o && o.status === "priced" && o.price != null && o.matchType === "exact";
}

/** Keep only the newest observation per (upc, retailer). Input must be sorted newest first. */
export function latestByKey(rows: Observation[]): Map<string, Partial<Record<RetailerId, Observation>>> {
  const map = new Map<string, Partial<Record<RetailerId, Observation>>>();
  for (const o of rows) {
    const entry = map.get(o.upc) ?? {};
    const r = o.retailer as RetailerId;
    if (!entry[r]) entry[r] = o;
    map.set(o.upc, entry);
  }
  return map;
}

export function buildRows(skuList: Sku[], latest: Map<string, Partial<Record<RetailerId, Observation>>>): SkuRow[] {
  return skuList.map((sku) => {
    const prices = latest.get(sku.upc) ?? {};
    const values = RETAILER_IDS.map((r) => prices[r]).filter(isComparable).map((o) => o.price);
    return {
      ...sku,
      prices,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      median: median(values),
    };
  });
}

export function summarizeRetailers(rows: SkuRow[]): RetailerSummary[] {
  return RETAILER_IDS.map((retailer) => {
    let priced = 0;
    let lowestCount = 0;
    let highestCount = 0;
    const indexes: number[] = [];
    for (const row of rows) {
      const o = row.prices[retailer];
      if (!isComparable(o)) continue;
      priced++;
      const comparable = RETAILER_IDS.map((r) => row.prices[r]).filter(isComparable);
      if (comparable.length < 2 || row.median == null || row.min === row.max) continue;
      indexes.push(o.price / row.median - 1);
      if (o.price === row.min) lowestCount++;
      if (o.price === row.max) highestCount++;
    }
    return {
      retailer,
      priced,
      comparedSkus: indexes.length,
      avgIndexPct: indexes.length ? (indexes.reduce((a, b) => a + b, 0) / indexes.length) * 100 : null,
      lowestCount,
      highestCount,
    };
  });
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows: SkuRow[]): string {
  const header = ["UPC", "Title", "Brand", "Retailer", "Status", "Price", "Regular Price", "Promo", "Availability", "Match", "Confidence", "Source", "UPC Verified", "URL", "Observed At", "Notes"];
  const lines = rows.flatMap((row) =>
    RETAILER_IDS.map((r) => {
      const o = row.prices[r];
      return [row.upc, row.title, row.brand, r, o?.status ?? "not_checked", o?.price, o?.regularPrice, o?.promo, o?.availability, o?.matchType, o?.confidence, o?.source, o?.upcVerified, o?.url, o?.observedAt?.toISOString(), o?.notes]
        .map(csvCell)
        .join(",");
    }),
  );
  return [header.join(","), ...lines].join("\n");
}
