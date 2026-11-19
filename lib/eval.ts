import { z } from "zod";
import golden from "@/data/golden-set.json";
import type { Observation, Sku } from "./db/schema";
import { enforceExactSku } from "./insights";
import { priceBasisOf, RETAILER_IDS, type RetailerId } from "./retailers";

// Scores what the tracker shows (latest Exa-based observation per SKU × retailer)
// against a hand-verified golden set (data/golden-set.json) on accuracy and freshness.

const goldenSchema = z.object({
  version: z.number(),
  verifiedAt: z.string(),
  method: z.string(),
  stratification: z.string(),
  items: z.array(
    z.object({
      upc: z.string(),
      retailer: z.enum(RETAILER_IDS),
      stratum: z.string(),
      /** Price basis the golden price was read at (see priceBasisOf). */
      basis: z.string(),
      /** When this item was checked, if later than the set's verifiedAt. */
      verifiedAt: z.string().optional(),
      expected: z.object({
        status: z.enum(["priced", "no_price", "not_listed"]),
        price: z.number().nullable(),
        regularPrice: z.number().optional(),
        listedPrice: z.number().optional(),
        packRatio: z.number().optional(),
        availability: z.enum(["in_stock", "out_of_stock", "unknown"]),
        promo: z.string().optional(),
      }),
      url: z.string(),
      notes: z.string(),
    }),
  ),
  skipped: z.array(z.object({ upc: z.string(), retailer: z.enum(RETAILER_IDS), reason: z.string() })),
});

export type GoldenSet = z.infer<typeof goldenSchema>;
export type GoldenItem = GoldenSet["items"][number];
export const GOLDEN_SET: GoldenSet = goldenSchema.parse(golden);

/** A price within this many dollars counts as an exact match. */
export const EXACT_TOLERANCE_USD = 0.01;
/** A price within this fraction of the true price counts as close. */
export const CLOSE_TOLERANCE = 0.05;
/** Matches Exa's default content max age (EXA_MAX_AGE_HOURS) in lib/exa.ts. */
export const FRESH_WITHIN_HOURS = 24;

export const OUTCOMES = [
  "exact",
  "close",
  "wrong_price",
  "missed",
  "false_price",
  "correct_absent",
  /** Prices disagree but were read at different bases (e.g. two Kroger stores), so they aren't comparable. */
  "different_basis",
  "not_run",
] as const;
/** Outcomes left out of accuracy and freshness rates. */
const EXCLUDED: Outcome[] = ["not_run", "different_basis"];
export type Outcome = (typeof OUTCOMES)[number];

export type EvalRow = {
  item: GoldenItem;
  title: string;
  observed: Observation | null;
  /** Price basis of the observation, when there is one. */
  observedBasis: string | null;
  outcome: Outcome;
  /** (observed − expected) / expected, when both have a price. */
  errorPct: number | null;
  /** Hours between Exa's observation and the golden verification (positive = Exa observed earlier). */
  lagHours: number | null;
  fresh: boolean | null;
  /** Stock status agrees, when both sides know it. */
  availabilityMatch: boolean | null;
  /** Wrong price read from the same page the golden set used: most likely a stale snapshot, not a wrong product. */
  likelyStale: boolean;
};

export type EvalSummary = {
  evaluated: number;
  overallAccuracy: number | null;
  goldPriced: number;
  exactRate: number | null;
  withinToleranceRate: number | null;
  coverageRate: number | null;
  meanAbsErrorPct: number | null;
  goldUnpriced: number;
  differentBasis: number;
  falsePriceRate: number | null;
  medianLagHours: number | null;
  freshRate: number | null;
  availabilityAgreement: number | null;
  likelyStale: number;
  counts: Record<Outcome, number>;
};

export type RetailerEval = { retailer: RetailerId; evaluated: number; correct: number; skipped: number };

const rate = (n: number, d: number) => (d ? n / d : null);
const hostAndPath = (u: string | null | undefined) => {
  try {
    const url = new URL(u ?? "");
    return url.hostname.replace(/^www\./, "") + url.pathname.replace(/\/$/, "");
  } catch {
    return null;
  }
};
/** Retailer product IDs are the stable part of a product URL (slugs vary). */
const productKey = (u: string | null | undefined) => {
  const hp = hostAndPath(u);
  if (!hp) return null;
  const id = hp.match(/(\d{6,})(?!.*\d{6,})/)?.[1] ?? hp.match(/(A-\d+|prod\d+)/)?.[1];
  return id ? `${hp.split("/")[0]}:${id}` : hp;
};

export function scoreItem(item: GoldenItem, observed: Observation | null, verifiedAt: Date): Omit<EvalRow, "title"> {
  const exp = item.expected;
  const hasPrice = observed?.status === "priced" && observed.price != null;
  let outcome: Outcome;
  let errorPct: number | null = null;

  if (!observed || observed.status === "error") outcome = "not_run";
  else if (exp.status === "priced" && exp.price != null) {
    if (!hasPrice) outcome = "missed";
    else {
      const diff = observed.price! - exp.price;
      errorPct = diff / exp.price;
      outcome =
        Math.abs(diff) <= EXACT_TOLERANCE_USD ? "exact" : Math.abs(errorPct) <= CLOSE_TOLERANCE ? "close" : "wrong_price";
    }
  } else outcome = hasPrice ? "false_price" : "correct_absent";

  const lagHours = observed ? (verifiedAt.getTime() - new Date(observed.observedAt).getTime()) / 3_600_000 : null;
  const known = (a?: string | null) => a === "in_stock" || a === "out_of_stock";
  const availabilityMatch =
    observed && known(exp.availability) && known(observed.availability) ? exp.availability === observed.availability : null;
  // Third-party prices come from other sites' citations, so only a retailer-page read can be a stale snapshot of this page.
  const observedBasis = observed ? priceBasisOf(observed) : null;
  if (observedBasis !== item.basis && (outcome === "close" || outcome === "wrong_price")) outcome = "different_basis";
  const samePage =
    observedBasis === item.basis &&
    observed?.source === "retailer_page" &&
    productKey(observed.url) != null &&
    productKey(observed.url) === productKey(item.url);

  return {
    item,
    observed,
    observedBasis,
    outcome,
    errorPct,
    lagHours,
    fresh: lagHours == null ? null : Math.abs(lagHours) <= FRESH_WITHIN_HOURS,
    availabilityMatch,
    likelyStale: (outcome === "wrong_price" || outcome === "close") && samePage,
  };
}

export function runEval(skuList: Sku[], latest: Map<string, Partial<Record<RetailerId, Observation>>>, set = GOLDEN_SET) {
  const verifiedAt = new Date(set.verifiedAt);
  const skuByUpc = new Map(skuList.map((s) => [s.upc, s]));
  const rows: EvalRow[] = set.items.map((item) => {
    const sku = skuByUpc.get(item.upc);
    const raw = latest.get(item.upc)?.[item.retailer] ?? null;
    // Score what the tracker actually shows, after its exact-SKU rules.
    const observed = raw && sku ? enforceExactSku(raw, sku) : raw;
    return { ...scoreItem(item, observed, item.verifiedAt ? new Date(item.verifiedAt) : verifiedAt), title: sku?.title ?? item.upc };
  });
  return { rows, summary: summarize(rows), retailers: byRetailer(rows, set), set };
}

const CORRECT: Outcome[] = ["exact", "correct_absent"];

export function summarize(rows: EvalRow[]): EvalSummary {
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
  for (const r of rows) counts[r.outcome]++;
  const run = rows.filter((r) => !EXCLUDED.includes(r.outcome));
  const priced = run.filter((r) => r.item.expected.status === "priced");
  const unpriced = run.filter((r) => r.item.expected.status !== "priced");
  const errors = run.map((r) => r.errorPct).filter((e): e is number => e != null);
  const lags = run.map((r) => r.lagHours).filter((l): l is number => l != null).sort((a, b) => a - b);
  const avail = run.filter((r) => r.availabilityMatch != null);

  return {
    evaluated: run.length,
    overallAccuracy: rate(run.filter((r) => CORRECT.includes(r.outcome)).length, run.length),
    goldPriced: priced.length,
    exactRate: rate(counts.exact, priced.length),
    withinToleranceRate: rate(counts.exact + counts.close, priced.length),
    coverageRate: rate(priced.length - counts.missed, priced.length),
    meanAbsErrorPct: errors.length ? errors.reduce((a, e) => a + Math.abs(e), 0) / errors.length : null,
    goldUnpriced: unpriced.length,
    differentBasis: counts.different_basis,
    falsePriceRate: rate(counts.false_price, unpriced.length),
    medianLagHours: lags.length ? lags[Math.floor(lags.length / 2)] : null,
    freshRate: rate(run.filter((r) => r.fresh).length, run.length),
    availabilityAgreement: rate(avail.filter((r) => r.availabilityMatch).length, avail.length),
    likelyStale: run.filter((r) => r.likelyStale).length,
    counts,
  };
}

function byRetailer(rows: EvalRow[], set: GoldenSet): RetailerEval[] {
  return RETAILER_IDS.map((retailer) => {
    const mine = rows.filter((r) => r.item.retailer === retailer && !EXCLUDED.includes(r.outcome));
    return {
      retailer,
      evaluated: mine.length,
      correct: mine.filter((r) => CORRECT.includes(r.outcome)).length,
      skipped: set.skipped.filter((s) => s.retailer === retailer).length,
    };
  });
}
