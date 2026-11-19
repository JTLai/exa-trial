import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { extractPrice, priceAppearsOnPage, type PriceCandidate } from "./ai";
import { db } from "./db";
import { observations, runs, skus, type NewObservation, type Sku } from "./db/schema";
import { deepSearchPrice, getContents, searchDomain, type ExaResult } from "./exa";
import { krogerApiConfigured, krogerStorePrice } from "./kroger";
import { priceBasisOf, RETAILERS, type RetailerId } from "./retailers";
import {
  compareSize,
  findPackOption,
  listingName,
  optionPriceOnPage,
  packLabel,
  packOfLabel,
  packRatio,
  parseSize,
  singleUnitRatio,
} from "./size";
import { gtinMatches, urlContainsUpc } from "./upc";

type Lookup = Omit<NewObservation, "runId">;

export function toCandidate(upc: string, r: ExaResult): PriceCandidate {
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

/** The structured offer price, when the retailer itself (not a marketplace seller) is selling it. */
export function onlinePriceFromStructured(candidate: Pick<PriceCandidate, "structured">, retailerName: string): number | null {
  const s = candidate.structured;
  if (s?.price == null) return null;
  if (s.seller && !s.seller.toLowerCase().includes(retailerName.toLowerCase())) return null;
  return s.price;
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
  let ratio: number | null = null;
  // Size and pack come from the listing's full product name: Exa titles can be truncated or a category page's title.
  const name = match ? listingName(match.title, match.text, sku.brand, x.price) : "";

  // Prefer the page's own pack-size option for the SKU's pack (Walmart shows "Single $9.74" on the 2-pack page)
  // over dividing the pre-selected pack's price. Trust it only if the option is the SKU's pack, the unit size
  // matches, and the label + price appear together on the page.
  const skuPack = parseSize(sku.title).pack ?? 1;
  const unitSizeOk =
    !!match && (packRatio(sku.title, name) != null || compareSize(sku.title, name) !== "conflict");
  const llmOption =
    match && !match.gtinMatch && x.packOption && packOfLabel(x.packOption.label) === skuPack &&
    optionPriceOnPage(x.packOption.label, x.packOption.price, match.text)
      ? x.packOption
      : null;
  const pageOption = match && !match.gtinMatch ? findPackOption(match.text, skuPack) : null;
  const option = unitSizeOk ? (llmOption ?? (pageOption && { ...pageOption, regularPrice: null })) : null;
  const useOption = option != null;
  if (useOption) matchType = "exact";

  // The size must match for it to be the same SKU. A UPC on the page is ground truth;
  // otherwise the listing must show a matching size, not just a similar product name.
  // Exception: same unit size in a different pack (e.g. only a 2-pack) is normalized and tagged.
  if (match && !match.gtinMatch && !useOption && (matchType === "exact" || matchType === "different_size")) {
    ratio = packRatio(sku.title, name);
    // A multi-pack SKU sold only as single units of the same size (e.g. Walgreens' single Muro tube for a 2-pack SKU).
    if (ratio == null && x.matchType === "different_size") ratio = singleUnitRatio(sku.title, name);
    if (ratio != null) matchType = "exact";
  }
  if (match && !match.gtinMatch && matchType === "exact" && ratio == null && !useOption) {
    let size = compareSize(sku.title, name);
    if (size === "unknown") size = compareSize(sku.title, `${name}\n${match.text.slice(0, 1500)}`);
    if (size === "conflict") {
      matchType = "different_size";
      notes = `Listing is a different size/pack: "${name}".`;
    } else if (size === "unknown") {
      matchType = "not_found";
      notes = `Could not confirm the size on "${name}" and no UPC on the page.`;
    }
  }
  if (match?.gtinMatch) matchType = "exact";

  if (!match || matchType !== "exact") {
    return {
      upc: sku.upc,
      retailer: retailerId,
      status: "not_listed",
      matchType: match ? matchType : "not_found",
      source: "retailer_page",
      url: match?.url ?? null,
      productTitle: match ? name : null,
      notes: `No match: ${notes}`,
      costUsd,
    };
  }

  // The retailer's own structured offer is its online price for this listing; page text can carry
  // store/pickup prices or other sellers' offers. Keep it unless a pack option or pack normalization applies.
  const structuredPrice = onlinePriceFromStructured(match, retailer.name);
  if (!useOption && ratio == null && structuredPrice != null && x.price != null && x.price !== structuredPrice) {
    notes = `Used the retailer's structured online price $${structuredPrice.toFixed(2)} over $${x.price.toFixed(2)} read from page text. ${notes}`;
    x.price = structuredPrice;
    if (x.regularPrice != null && x.regularPrice <= structuredPrice) x.regularPrice = null;
  }

  if (!useOption && x.price != null && !priceAppearsOnPage(x.price, match)) {
    confidence = "low";
    notes = `${notes} (Extracted price not found verbatim on page.)`;
  }
  const normalize = (p: number | null) => (p != null && ratio != null ? Math.round((p / ratio) * 100) / 100 : p);
  const price = useOption ? option!.price : normalize(x.price);
  const regularPrice = useOption ? option!.regularPrice : normalize(x.regularPrice);
  if (useOption) notes = `Price from the page's "${option!.label}" pack-size option. ${notes}`;
  if (ratio != null) notes = `Only a different pack is listed ("${name}"); price normalized ${packLabel(ratio)}. ${notes}`;

  return {
    upc: sku.upc,
    retailer: retailerId,
    status: price != null ? "priced" : "no_price",
    price,
    regularPrice,
    packRatio: ratio,
    packOption: useOption ? option!.label : null,
    listedPrice: ratio != null ? x.price : null,
    promo: x.promo,
    availability: x.availability,
    matchType,
    confidence,
    source: "retailer_page",
    upcVerified: match.gtinMatch,
    url: match.url,
    productTitle: name,
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

  // Only fill in a price for a listing we confirmed is this exact SKU on the retailer's site.
  if (listing.matchType !== "exact") return listing;
  // Deep search prices the SKU itself, not the different pack this retailer sells, so don't mix them.
  if (listing.packRatio != null) return listing;

  const deep = await deepSearchPrice(retailer, sku.title, sku.upc);
  const costUsd = (listing.costUsd ?? 0) + deep.costUsd;
  const deepSizeConflict = deep.productTitle != null && compareSize(sku.title, deep.productTitle) === "conflict";

  if (!deep.found || deep.priceUsd == null || deepSizeConflict) {
    const why = deepSizeConflict ? `third-party price was for a different size ("${deep.productTitle}")` : `deep search found no ${retailer.name} price`;
    return { ...listing, costUsd, notes: `${listing.notes ?? ""} Listed, but ${why}.`.trim() };
  }
  return {
    ...listing,
    status: "priced",
    price: deep.priceUsd,
    regularPrice: null,
    promo: null,
    // Third-party prices are never better than medium confidence.
    confidence: deep.confidence === "high" ? "medium" : "low",
    source: "third_party",
    notes: `Listing confirmed on ${retailer.domain}; price from third-party sources (${retailer.name} pages hide prices from crawlers).`,
    citations: deep.citations,
    costUsd,
  };
}

/** Kroger prices are per store, so price one pinned reference store through Kroger's own Products API. */
async function lookupKrogerStore(sku: Sku): Promise<Lookup> {
  const k = await krogerStorePrice(sku.upc);
  const base = {
    upc: sku.upc,
    retailer: "kroger",
    source: "retailer_page" as const,
    priceBasis: `kroger:${k.storeId}`,
    url: RETAILERS.kroger.directUrl!(sku.upc),
    costUsd: 0,
  };
  if (!k.found) {
    return { ...base, status: "not_listed", matchType: "not_found", notes: `Kroger API has no product for this UPC at ${k.storeName}.` };
  }
  const size = k.size ? compareSize(sku.title, `${k.description ?? ""} ${k.size}`) : "unknown";
  if (size === "conflict") {
    return {
      ...base,
      status: "not_listed",
      matchType: "different_size",
      productTitle: k.description,
      notes: `No match: Kroger's product for this UPC is a different size ("${k.description}, ${k.size}").`,
    };
  }
  return {
    ...base,
    status: k.price != null ? "priced" : "no_price",
    price: k.price,
    regularPrice: k.regularPrice,
    availability: k.availability,
    matchType: "exact",
    confidence: "high",
    upcVerified: true,
    productTitle: k.description,
    notes: k.price != null ? `Kroger API price at ${k.storeName}.` : `Listed at ${k.storeName} but the API returned no price.`,
  };
}

export async function lookupPrice(sku: Sku, retailerId: RetailerId): Promise<Lookup> {
  if (retailerId === "kroger" && krogerApiConfigured()) return lookupKrogerStore(sku);
  const result =
    RETAILERS[retailerId].priceVia === "deep_search"
      ? await lookupViaDeepSearch(sku, retailerId)
      : await lookupOnRetailerSite(sku, retailerId);
  return { ...result, priceBasis: priceBasisOf({ retailer: retailerId }) };
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

export function createRun(
  upcs: string[] | undefined,
  retailers: RetailerId[],
  cells?: { upc: string; retailer: RetailerId }[],
) {
  const wanted = cells?.length ? cells.map((c) => c.upc) : upcs;
  const targetSkus = wanted?.length
    ? db.select().from(skus).where(inArray(skus.upc, wanted)).all()
    : db.select().from(skus).all();
  const tasks = cells?.length
    ? cells.flatMap((c) => targetSkus.filter((s) => s.upc === c.upc).map((sku) => ({ sku, retailerId: c.retailer })))
    : targetSkus.flatMap((sku) => retailers.map((retailerId) => ({ sku, retailerId })));
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
