// Deterministic size check: a listing only counts as the same SKU if its size
// (volume / weight, count, pack) matches. The LLM is good at matching product
// lines but regularly calls a 10 fl oz bottle or a 2-pack an "exact" match.

type Size = { oz: number[]; counts: number[]; pack: number | null };

const ML_PER_OZ = 29.5735;
const G_PER_OZ = 28.3495;
const TOLERANCE = 0.08; // labels round (0.08 fl oz ≈ 2.5 mL is 5.6% off)

const COUNT_UNITS =
  "ct|count|ea|softgels?|soft\\s?gels|minigels|chewables|gummies|capsules|tablets|vials|dispensers|single-use dispensers";

/** Pull every size mention out of a product title. */
export function parseSize(text: string): Size {
  const t = text.toLowerCase().replace(/(\d),(\d{3})/g, "$1$2");
  const oz: number[] = [];
  const counts: number[] = [];
  const num = "(\\d+/\\d+|\\d*\\.?\\d+)"; // "1/8 oz", ".25 fl oz", "10 mL"
  const n = (v: string) => (v.includes("/") ? Number(v.split("/")[0]) / Number(v.split("/")[1]) : Number(v));

  for (const m of t.matchAll(new RegExp(`${num}\\s*(?:fl\\.?\\s*)?oz\\b`, "g"))) oz.push(n(m[1]));
  for (const m of t.matchAll(new RegExp(`${num}\\s*ml\\b`, "g"))) oz.push(n(m[1]) / ML_PER_OZ);
  for (const m of t.matchAll(new RegExp(`${num}\\s*g\\b`, "g"))) oz.push(n(m[1]) / G_PER_OZ);
  for (const m of t.matchAll(new RegExp(`${num}\\s*(?:${COUNT_UNITS})\\b`, "g"))) counts.push(n(m[1]));

  let pack: number | null = null;
  const packMatch =
    t.match(/(\d+)\s*x\s*\d*\.?\d/) ?? // "2 x 0.5 fl oz"
    t.match(/\(?(\d+)[\s-]*(?:pack|pk)\b/) ?? // "(2 pack)", "2-Pack"
    t.match(/pack of (\d+)/);
  if (packMatch) pack = Number(packMatch[1]);
  else if (/\btwin[\s-]?pack\b/.test(t)) pack = 2;

  return { oz: oz.filter((v) => v > 0), counts: counts.filter((v) => v > 0), pack };
}

const close = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b) <= TOLERANCE;

/**
 * When a listing is the same unit size but sold in a different pack (e.g. only a
 * 2-pack of the 90 ct bottle), returns listing pack ÷ SKU pack so the price can be
 * normalized to one SKU. Null if the pack isn't explicit or the unit size differs.
 */
export function packRatio(skuTitle: string, listingText: string): number | null {
  const sku = parseSize(skuTitle);
  const page = parseSize(listingText);
  const skuPack = sku.pack ?? 1;
  if (page.pack == null || page.pack === skuPack) return null;
  // Unit size may be shown per unit ("2 x 4 fl oz") or as the pack total ("2 pack, 8 fl oz").
  const unitMatches = (pageVals: number[], skuVals: number[]) =>
    pageVals.some((p) => skuVals.some((s) => close(p, s) || close(p / page.pack!, s)));
  const ozShared = sku.oz.length > 0 && page.oz.length > 0;
  const countShared = sku.counts.length > 0 && page.counts.length > 0;
  if (!ozShared && !countShared) return null;
  if (ozShared && !unitMatches(page.oz, sku.oz)) return null;
  if (countShared && !unitMatches(page.counts, sku.counts)) return null;
  return page.pack / skuPack;
}

/** Pack count named by a pack-size option label: "Single" → 1, "2 Pack" → 2, "Pack of 3" → 3. */
export function packOfLabel(label: string): number | null {
  const pack = parseSize(label).pack;
  if (pack != null) return pack;
  if (/\b(single|each|1\s*(count|ct|pack|pk|ea))\b/i.test(label)) return 1;
  return null;
}

/** True when the page text shows this option label followed closely by its price ("Single $9.74", "Single, $9.74"). */
export function optionPriceOnPage(label: string, price: number, text: string): boolean {
  const escaped = label.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const [dollars, cents] = price.toFixed(2).split(".");
  return new RegExp(`${escaped}[\\s,:-]{0,6}(?:USD)?\\s?\\$?\\s?${dollars}\\.${cents}(?!\\d)`, "i").test(text);
}

/**
 * Read the SKU's pack option straight from a pack-size selector ("Pack Size: 2 Pack … Single $9.74 …").
 * Deterministic backstop for when the LLM reports the option price as the page price, or not at all.
 */
export function findPackOption(text: string, pack: number): { label: string; price: number } | null {
  if (!/pack size/i.test(text)) return null;
  const labels = pack === 1 ? ["Single", "1 Pack", "1 Count"] : [`${pack} Pack`, `${pack}-Pack`, `Pack of ${pack}`];
  for (const label of labels) {
    const m = text.match(new RegExp(`(?:^|[\\s,])${label}[\\s,:-]{0,6}\\$\\s?(\\d+\\.\\d{2})(?!\\d)`, "im"));
    if (m) return { label, price: Number(m[1]) };
  }
  return null;
}

/** "÷2" when the listing is a bigger pack than the SKU, "×2" when smaller. */
export function packLabel(ratio: number): string {
  return ratio >= 1 ? `÷${+ratio.toFixed(2)}` : `×${+(1 / ratio).toFixed(2)}`;
}

export type SizeCheck = "match" | "conflict" | "unknown" | "no_size";

/**
 * Compare the tracked SKU's size against a retailer listing.
 * - match: listing shows a size that matches (and no conflicting pack)
 * - conflict: listing shows a different size, count or pack
 * - unknown: listing shows no comparable size
 * - no_size: the SKU title itself has no size, so there's nothing to check
 */
export function compareSize(skuTitle: string, listingText: string): SizeCheck {
  const sku = parseSize(skuTitle);
  if (sku.oz.length === 0 && sku.counts.length === 0) return "no_size";
  const page = parseSize(listingText);
  const skuPack = sku.pack ?? 1;

  // Accept per-unit or total size for multi-packs ("2 x 15 mL" ⇒ 15 mL or 30 mL).
  const skuOz = [...sku.oz, ...sku.oz.map((v) => v * skuPack)];
  const skuCounts = [...sku.counts, ...sku.counts.map((v) => v * skuPack)];

  if (page.pack != null && page.pack !== skuPack) return "conflict";
  const ozShared = sku.oz.length > 0 && page.oz.length > 0;
  const countShared = sku.counts.length > 0 && page.counts.length > 0;
  if (ozShared && !page.oz.some((p) => skuOz.some((s) => close(p, s)))) return "conflict";
  if (countShared && !page.counts.some((p) => skuCounts.some((s) => close(p, s)))) return "conflict";
  if (!ozShared && !countShared) return "unknown";
  // A multi-pack SKU needs the listing to show the pack, or the total size.
  if (skuPack > 1 && page.pack == null) {
    const totalOz = sku.oz.map((v) => v * skuPack);
    const showsTotal = page.oz.some((p) => totalOz.some((s) => close(p, s)));
    if (!showsTotal) return "unknown";
  }
  return "match";
}

const hasSize = (text: string) => {
  const s = parseSize(text);
  return s.oz.length > 0 || s.counts.length > 0;
};

/**
 * The listing's own product name, with its size and pack. Exa titles are often truncated
 * ("…Supplement, 120 ...") or are a category page's title ("Topical Antibiotics - Eye Ointment"),
 * while the page text names the product in full ("# …, 120 Soft Gels - 4 Pack", "- Muro 128 … - 0.13 oz").
 * Prefers a text line that names the brand, shows a size, and whose nearest price is the extracted price.
 */
export function listingName(title: string, text: string, brand: string, price: number | null): string {
  const truncated = /(\.\.\.|…)\s*$/.test(title);
  const all = text.split("\n").filter((line) => line.trim());
  // Selling prices only: not unit prices ("$230.69/oz") or savings ("Save $5.00").
  const priceAt = all.map((line) => (/\bsave\b/i.test(line) ? null : (line.match(/\$\s?(\d+\.\d{2})(?!\s*\/)/)?.[1] ?? null)));
  // Category pages list several products, some with the price after the name and some before it,
  // so a product's price is the one closest to its name line (ties go to the price after).
  const nearestPrice = (i: number) => {
    for (let d = 0; d <= 6; d++) {
      if (priceAt[i + d]) return priceAt[i + d];
      if (d > 0 && priceAt[i - d]) return priceAt[i - d];
    }
    return null;
  };
  const lines = all
    .map((line, i) => ({ name: line.replace(/^[\s#*>-]+/, "").replace(/\s*-\s*Walmart\.com\s*$/i, "").trim(), i }))
    .filter(
      (l) => l.name.length > 0 && l.name.length < 200 && l.name.toLowerCase().includes(brand.toLowerCase()) && hasSize(l.name),
    );
  if (price != null) {
    const priced = lines.find((l) => nearestPrice(l.i) === price.toFixed(2));
    if (priced) return priced.name;
  }
  if (!truncated && hasSize(title)) return title;
  const prefix = title.replace(/(\.\.\.|…)\s*$/, "").slice(0, 30).toLowerCase();
  return lines.find((l) => l.name.toLowerCase().startsWith(prefix))?.name ?? title;
}

/**
 * When a multi-pack SKU (e.g. "2 x 0.125 oz") is only sold as a single unit of the same size,
 * returns 1 / SKU pack so the single price can be scaled up to the SKU. Null otherwise.
 * Only use it when the listing was judged a different size/pack: a twin pack may also show its per-unit size.
 */
export function singleUnitRatio(skuTitle: string, listingText: string): number | null {
  const sku = parseSize(skuTitle);
  const page = parseSize(listingText);
  const skuPack = sku.pack ?? 1;
  if (skuPack <= 1 || (page.pack != null && page.pack !== 1)) return null;
  const sameUnit = (pageVals: number[], skuVals: number[]) => pageVals.some((p) => skuVals.some((s) => close(p, s)));
  const showsTotal = (pageVals: number[], skuVals: number[]) => pageVals.some((p) => skuVals.some((s) => close(p, s * skuPack)));
  const ozShared = sku.oz.length > 0 && page.oz.length > 0;
  const countShared = sku.counts.length > 0 && page.counts.length > 0;
  if (!ozShared && !countShared) return null;
  if (ozShared && (!sameUnit(page.oz, sku.oz) || showsTotal(page.oz, sku.oz))) return null;
  if (countShared && (!sameUnit(page.counts, sku.counts) || showsTotal(page.counts, sku.counts))) return null;
  return 1 / skuPack;
}
