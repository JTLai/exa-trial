import type { Observation, Sku } from "./db/schema";
import { RETAILER_IDS, RETAILERS, type RetailerId } from "./retailers";
import { compareSize, packLabel, packRatio } from "./size";

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

/**
 * The size must match for a listing to be the same SKU. Re-applies that rule to
 * stored observations (older runs saved size mismatches and unconfirmed
 * third-party prices) so anything not confirmed as this exact SKU reads as no match.
 * Same unit size in a different pack is normalized to one SKU and keeps its packRatio tag.
 */
export function enforceExactSku(o: Observation, sku: Sku): Observation {
  if (o.status !== "priced" && o.status !== "no_price") return o;
  // Already resolved to the SKU's pack when it was looked up (normalized, or priced from the page's pack option).
  if (o.packRatio != null || o.packOption != null) return o;

  const ratio = !o.upcVerified && o.source === "retailer_page" && o.productTitle ? packRatio(sku.title, o.productTitle) : null;
  if (ratio != null) {
    const normalize = (p: number | null) => (p != null ? Math.round((p / ratio) * 100) / 100 : p);
    return {
      ...o,
      matchType: "exact",
      packRatio: ratio,
      listedPrice: o.price,
      price: normalize(o.price),
      regularPrice: normalize(o.regularPrice),
      notes: `Only a different pack is listed ("${o.productTitle}"); price normalized ${packLabel(ratio)}.`,
    };
  }

  let reason: string | null = null;
  if (o.matchType !== "exact") reason = "only a different size/pack is listed";
  else if (!o.upcVerified && o.productTitle && compareSize(sku.title, o.productTitle) === "conflict")
    reason = `listing is a different size/pack ("${o.productTitle}")`;
  else if (o.source === "third_party" && !o.url?.includes(RETAILERS[o.retailer as RetailerId]?.domain ?? "\0"))
    reason = "not confirmed on the retailer's site";
  if (!reason) return o;
  return {
    ...o,
    status: "not_listed",
    matchType: o.matchType === "exact" ? "different_size" : o.matchType,
    price: null,
    regularPrice: null,
    promo: null,
    notes: `No match: ${reason}.`,
  };
}

export function buildRows(skuList: Sku[], latest: Map<string, Partial<Record<RetailerId, Observation>>>): SkuRow[] {
  return skuList.map((sku) => {
    const prices = Object.fromEntries(
      Object.entries(latest.get(sku.upc) ?? {}).map(([r, o]) => [r, enforceExactSku(o, sku)]),
    ) as Partial<Record<RetailerId, Observation>>;
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
  const header = ["UPC", "Title", "Brand", "Retailer", "Status", "Price", "Regular Price", "Promo", "Availability", "Match", "Confidence", "Source", "UPC Verified", "URL", "Observed At", "Notes", "Pack Normalized", "Listed Pack Price"];
  const lines = rows.flatMap((row) =>
    RETAILER_IDS.map((r) => {
      const o = row.prices[r];
      return [row.upc, row.title, row.brand, r, o?.status ?? "not_checked", o?.price, o?.regularPrice, o?.promo, o?.availability, o?.matchType, o?.confidence, o?.source, o?.upcVerified, o?.url, o?.observedAt?.toISOString(), o?.notes, o?.packRatio != null ? packLabel(o.packRatio) : "", o?.listedPrice]
        .map(csvCell)
        .join(",");
    }),
  );
  return [header.join(","), ...lines].join("\n");
}
