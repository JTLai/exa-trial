import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { extractPrice, priceAppearsOnPage, type PriceCandidate } from "./ai";
import { db } from "./db";
import { observations, runs, skus, type NewObservation, type Sku } from "./db/schema";
import { deepSearchPrice, getContents, searchDomain, type ExaResult } from "./exa";
import { RETAILERS, type RetailerId } from "./retailers";
import { gtinMatches, urlContainsUpc } from "./upc";

type Lookup = Omit<NewObservation, "runId">;

function toCandidate(upc: string, r: ExaResult): PriceCandidate {
  return {
    url: r.url,
    title: r.title,
    text: r.text,
    gtinMatch: gtinMatches(upc, r.product?.gtin) || (r.url.includes("kroger.com") && urlContainsUpc(upc, r.url)),
    structured: r.product
      ? { gtin: r.product.gtin, price: r.product.price, availability: r.product.availability, seller: r.product.seller }
      : null,
  };
}

/** Find the SKU on the retailer's own site and read the price off the product page. */
async function lookupOnRetailerSite(sku: Sku, retailerId: RetailerId): Promise<Lookup> {
  const retailer = RETAILERS[retailerId];
  let costUsd = 0;
  const found: ExaResult[] = [];

  // 1. Deterministic UPC-keyed URL where the retailer supports one (Kroger).
  if (retailer.directUrl) {
    const direct = await getContents([retailer.directUrl(sku.upc)]).catch(() => null);
    if (direct) {
      costUsd += direct.costUsd;
      found.push(...direct.results.filter((r) => r.text.length > 200));
    }
  }

  // 2. Semantic search restricted to the retailer's domain.
  if (found.length === 0) {
    const search = await searchDomain(sku.title, retailer.domain);
    costUsd += search.costUsd;
    found.push(...search.results);
  }

  const candidates = found
    .filter((r, i, all) => all.findIndex((o) => o.url === r.url) === i)
    .map((r) => toCandidate(sku.upc, r));
  if (candidates.length === 0) {
    return { upc: sku.upc, retailer: retailerId, status: "not_listed", matchType: "not_found", costUsd, notes: "No pages found on " + retailer.domain };
  }

  const x = await extractPrice({ retailerName: retailer.name, upc: sku.upc, title: sku.title, candidates });
  const match = x.matchedIndex != null ? candidates[x.matchedIndex] : undefined;
  let { confidence, notes } = x;
  let matchType = match ? x.matchType : "not_found";
  if (match?.gtinMatch) matchType = "exact"; // UPC on the page is ground truth

  const price = match ? x.price : null;
  if (price != null && match && !priceAppearsOnPage(price, match)) {
    confidence = "low";
    notes = `${notes} (Extracted price not found verbatim on page.)`;
  }

  return {
    upc: sku.upc,
    retailer: retailerId,
    status: matchType === "not_found" ? "not_listed" : price != null ? "priced" : "no_price",
    price,
    regularPrice: match ? x.regularPrice : null,
    promo: match ? x.promo : null,
    availability: match ? x.availability : null,
    matchType,
    confidence,
    source: "retailer_page",
    upcVerified: match?.gtinMatch ?? false,
    url: match?.url ?? null,
    productTitle: match?.title ?? null,
    notes,
    costUsd,
  };
}

/**
 * Target renders prices client-side behind bot protection, so its product pages
 * never expose a price to crawlers. We still confirm the listing on target.com,
 * then take the price from Exa deep search (third-party sources), flagged as such.
 */
async function lookupViaDeepSearch(sku: Sku, retailerId: RetailerId): Promise<Lookup> {
  const retailer = RETAILERS[retailerId];
  const listing = await lookupOnRetailerSite(sku, retailerId);
  if (listing.status === "priced" && listing.confidence !== "low") return listing;

  const deep = await deepSearchPrice(retailer, sku.title, sku.upc);
  const costUsd = (listing.costUsd ?? 0) + deep.costUsd;
  const listed = listing.matchType !== "not_found";

  if (!deep.found || deep.priceUsd == null) {
    return { ...listing, costUsd, notes: `${listing.notes ?? ""} Deep search found no ${retailer.name} price.`.trim() };
  }
  return {
    ...listing,
    status: "priced",
    price: deep.priceUsd,
    regularPrice: null,
    promo: null,
    matchType: listed ? listing.matchType : "exact",
    // Third-party prices are never better than medium confidence.
    confidence: deep.confidence === "high" && listed ? "medium" : "low",
    source: "third_party",
    url: listing.url ?? deep.sourceUrl ?? null,
    productTitle: listing.productTitle ?? deep.productTitle ?? null,
    notes: listed
      ? `Listing confirmed on ${retailer.domain}; price from third-party sources (${retailer.name} pages hide prices from crawlers).`
      : `Not confirmed on ${retailer.domain}; price from third-party sources only.`,
    citations: deep.citations,
    costUsd,
  };
}

export async function lookupPrice(sku: Sku, retailerId: RetailerId): Promise<Lookup> {
  return RETAILERS[retailerId].priceVia === "deep_search"
    ? lookupViaDeepSearch(sku, retailerId)
    : lookupOnRetailerSite(sku, retailerId);
}

// ---------------------------------------------------------------------------
// Runs: a batch of (SKU × retailer) lookups executed with bounded concurrency.

const CONCURRENCY = Number(process.env.PRICE_CONCURRENCY ?? 8);
const STALE_MS = 5 * 60_000;

/** Returns the active run, marking it failed if the server died mid-run. */
export function activeRun() {
  const run = db.select().from(runs).where(eq(runs.status, "running")).get();
  if (run && Date.now() - run.updatedAt.getTime() > STALE_MS) {
    db.update(runs)
      .set({ status: "failed", error: "Interrupted (server restarted?)", finishedAt: new Date() })
      .where(eq(runs.id, run.id))
      .run();
    return undefined;
  }
  return run;
}

export function createRun(upcs: string[] | undefined, retailers: RetailerId[]) {
  const targetSkus = upcs?.length
    ? db.select().from(skus).where(inArray(skus.upc, upcs)).all()
    : db.select().from(skus).all();
  const tasks = targetSkus.flatMap((sku) => retailers.map((retailerId) => ({ sku, retailerId })));
  const run = db.insert(runs).values({ status: "running", total: tasks.length }).returning().get();
  return { run, tasks };
}

export async function executeRun(runId: number, tasks: { sku: Sku; retailerId: RetailerId }[]) {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const { sku, retailerId } = tasks[next++];
      let result: Lookup;
      try {
        result = await lookupPrice(sku, retailerId);
      } catch (error) {
        console.error(`Lookup failed for ${sku.upc} @ ${retailerId}:`, error);
        result = {
          upc: sku.upc,
          retailer: retailerId,
          status: "error",
          notes: error instanceof Error ? error.message.slice(0, 300) : "Unknown error",
        };
      }
      db.insert(observations).values({ ...result, runId }).run();
      db.update(runs)
        .set({
          completed: sql`${runs.completed} + 1`,
          failed: result.status === "error" ? sql`${runs.failed} + 1` : runs.failed,
          costUsd: sql`${runs.costUsd} + ${result.costUsd ?? 0}`,
          updatedAt: new Date(),
        })
        .where(eq(runs.id, runId))
        .run();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));
    db.update(runs).set({ status: "completed", finishedAt: new Date() }).where(eq(runs.id, runId)).run();
  } catch (error) {
    db.update(runs)
      .set({ status: "failed", error: String(error), finishedAt: new Date() })
      .where(and(eq(runs.id, runId), lt(runs.completed, runs.total)))
      .run();
  }
}
