import skuList from "@/data/skus.json";
import { db } from "./db";
import { skus } from "./db/schema";

// Brand families in the active assortment, most specific first.
const BRANDS: [RegExp, string][] = [
  [/preservision/i, "PreserVision"],
  [/ocuvite/i, "Ocuvite"],
  [/lumify/i, "LUMIFY"],
  [/biotrue/i, "Biotrue"],
  [/renu/i, "renu"],
  [/boston/i, "Boston"],
  [/blink/i, "blink"],
  [/soothe/i, "Soothe"],
  [/alaway/i, "Alaway"],
  [/opcon/i, "Opcon-A"],
  [/muro/i, "Muro 128"],
  [/sensitive eyes/i, "Sensitive Eyes"],
  [/advanced eye relief/i, "Advanced Eye Relief"],
  [/fogshield/i, "FogShield"],
];

export function brandOf(title: string): string {
  return BRANDS.find(([re]) => re.test(title))?.[1] ?? "Other";
}

/** Load the tracked assortment (data/skus.json, from the client's spreadsheet) into SQLite. Idempotent. */
export function ensureSkus() {
  const existing = db.select({ upc: skus.upc }).from(skus).all();
  if (existing.length >= skuList.length) return;
  db.insert(skus)
    .values(skuList.map((s) => ({ upc: s.upc, title: s.title, brand: brandOf(s.title) })))
    .onConflictDoNothing()
    .run();
}
