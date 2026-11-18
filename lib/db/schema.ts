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
