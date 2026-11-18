// UPC / GTIN helpers. Retailers publish the same code in different shapes:
// 12-digit UPC-A, 14-digit GTIN with leading zeros, or (Kroger) 13 digits with
// the check digit dropped. Compare on the significant digits.

const digits = (value: string) => value.replace(/\D/g, "");

/** Strip leading zeros so 00310119537251 and 310119537251 compare equal. */
export function normalizeGtin(value: string): string {
  return digits(value).replace(/^0+/, "");
}

/** Kroger's 13-digit product code: UPC without its check digit, zero-padded. */
export function krogerProductCode(upc: string): string {
  const d = digits(upc).padStart(12, "0");
  return d.slice(0, -1).padStart(13, "0");
}

/** True when a retailer-reported GTIN refers to the given UPC. */
export function gtinMatches(upc: string, candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const a = normalizeGtin(upc);
  const b = normalizeGtin(candidate);
  if (!a || !b) return false;
  // Exact, or the candidate is the UPC with its check digit dropped (Kroger).
  return a === b || normalizeGtin(krogerProductCode(upc)) === b;
}

/** True when a URL embeds the UPC (e.g. Kroger product pages). */
export function urlContainsUpc(upc: string, url: string): boolean {
  return url.includes(krogerProductCode(upc)) || url.includes(digits(upc));
}
