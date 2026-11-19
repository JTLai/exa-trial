import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const skus = sqliteTable("skus", {
  upc: text("upc").primaryKey(),
  title: text("title").notNull(),
  brand: text("brand").notNull(),
});

export const runs = sqliteTable("runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  status: text("status", { enum: ["running", "completed", "failed"] }).notNull(),
  total: integer("total").notNull(),
  completed: integer("completed").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  error: text("error"),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
});

export const OBSERVATION_STATUSES = ["priced", "no_price", "not_listed", "error"] as const;

/** One price lookup for one SKU at one retailer. Append-only, so history is preserved. */
export const observations = sqliteTable(
  "observations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id").notNull(),
    upc: text("upc").notNull(),
    retailer: text("retailer").notNull(),
    status: text("status", { enum: OBSERVATION_STATUSES }).notNull(),
    price: real("price"),
    regularPrice: real("regular_price"),
    promo: text("promo"),
    availability: text("availability", { enum: ["in_stock", "out_of_stock", "unknown"] }),
    matchType: text("match_type", { enum: ["exact", "different_size", "not_found"] }),
    confidence: text("confidence", { enum: ["high", "medium", "low"] }),
    /** retailer_page = read from the retailer's own product page; third_party = Exa deep search across other sources. */
    source: text("source", { enum: ["retailer_page", "third_party"] }),
    /**
     * Which price this is, so only like-for-like prices are compared: "online" (national ship-to-home price)
     * or "kroger:<locationId>" (one Kroger store; Kroger has no national price). Null on rows from before this existed.
     */
    priceBasis: text("price_basis"),
    /** Set when the retailer only sells a different pack: listing pack ÷ SKU pack. `price` is normalized by it. */
    packRatio: real("pack_ratio"),
    /** Pack-size option on the page whose price was used (e.g. "Single" on Walmart's 2-pack page). */
    packOption: text("pack_option"),
    /** The listing's own price before pack normalization. */
    listedPrice: real("listed_price"),
    upcVerified: integer("upc_verified", { mode: "boolean" }).notNull().default(false),
    url: text("url"),
    productTitle: text("product_title"),
    notes: text("notes"),
    citations: text("citations", { mode: "json" }).$type<string[]>(),
    costUsd: real("cost_usd").notNull().default(0),
    observedAt: integer("observed_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [index("observations_upc_retailer_idx").on(t.upc, t.retailer, t.observedAt)],
);

export type Sku = typeof skus.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Observation = typeof observations.$inferSelect;
export type NewObservation = typeof observations.$inferInsert;

export const BROWSER_TOOLS = ["browserless", "firecrawl"] as const;
export type BrowserTool = (typeof BROWSER_TOOLS)[number];

/** One attempt by a browser-automation product to read the price of a golden-set item Exa missed (Browser-Use tab). */
export const browserChecks = sqliteTable(
  "browser_checks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    upc: text("upc").notNull(),
    retailer: text("retailer").notNull(),
    tool: text("tool", { enum: BROWSER_TOOLS }).notNull(),
    status: text("status", { enum: ["running", "priced", "no_price", "error"] }).notNull(),
    /** Price of the listing exactly as the tool read it. */
    price: real("price"),
    productTitle: text("product_title"),
    availability: text("availability", { enum: ["in_stock", "out_of_stock", "unknown"] }),
    notes: text("notes"),
    url: text("url").notNull(),
    /** How the tool got there, e.g. Browserless strategy or Firecrawl credits. */
    detail: text("detail"),
    durationMs: integer("duration_ms"),
    startedAt: integer("started_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    finishedAt: integer("finished_at", { mode: "timestamp" }),
  },
  (t) => [index("browser_checks_key_idx").on(t.upc, t.retailer, t.tool, t.startedAt)],
);

export type BrowserCheck = typeof browserChecks.$inferSelect;
