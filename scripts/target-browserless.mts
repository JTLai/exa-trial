/**
 * Experiment: load a real Target product page in a Browserless.io cloud browser and try to read the price.
 *
 * Usage:
 *   npm run target:browserless -- <target product URL | UPC | search text>
 *   npm run target:browserless                      # defaults to the first SKU in data/skus.json
 *   npm run target:browserless -- "https://www.target.com/p/opcon-a-bausch-38-lomb-allergy-relief-eye-drops-0-5oz/-/A-11053291"
 *
 * Needs BROWSERLESS_API_KEY in .env.local. BROWSERLESS_ENDPOINT overrides the region
 * (default wss://production-sfo.browserless.io).
 *
 * Per AGENTS.md this is a plain hosted browser: no stealth endpoint and no CAPTCHA solving. If Target
 * bot-blocks the session, the script reports that rather than trying to get around it.
 */
import { readFileSync } from "node:fs";
import { chromium, type Page, type Response } from "playwright-core";

type PriceHit = { source: string; price: number; detail?: string };

const API_KEY = process.env.BROWSERLESS_API_KEY;
if (!API_KEY) {
  console.error("Missing BROWSERLESS_API_KEY (add it to .env.local).");
  process.exit(1);
}
const ENDPOINT = process.env.BROWSERLESS_ENDPOINT ?? "wss://production-sfo.browserless.io";

function defaultQuery(): string {
  const skus = JSON.parse(readFileSync(new URL("../data/skus.json", import.meta.url), "utf8")) as { upc: string }[];
  return skus[0].upc;
}

/** Walk Target's redsky JSON for price fields (`current_retail`, `formatted_current_price`). */
function findPrices(node: unknown, path: string, out: PriceHit[]): void {
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "current_retail" && typeof value === "number") {
      out.push({ source: "redsky", price: value, detail: path });
    } else if (key === "formatted_current_price" && typeof value === "string") {
      const n = parsePrice(value);
      if (n !== null) out.push({ source: "redsky", price: n, detail: `${path} "${value}"` });
    } else {
      findPrices(value, `${path}.${key}`, out);
    }
  }
}

function parsePrice(text: string): number | null {
  const m = text.replace(/,/g, "").match(/\$\s*(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

/** Signals that Target served a block/challenge page instead of the product. */
async function blockSignal(page: Page, status: number | undefined): Promise<string | null> {
  if (status && [403, 429].includes(status)) return `HTTP ${status}`;
  const title = (await page.title()).toLowerCase();
  const body = ((await page.locator("body").innerText().catch(() => "")) || "").toLowerCase();
  for (const needle of ["access denied", "captcha", "are you a robot", "unusual activity", "request blocked", "currently unavailable"]) {
    if (title.includes(needle) || body.slice(0, 3000).includes(needle)) return `page mentions "${needle}"`;
  }
  return null;
}

async function main() {
  const input = process.argv[2] ?? defaultQuery();
  console.log(`Connecting to Browserless (${ENDPOINT})`);
  const browser = await chromium.connectOverCDP(`${ENDPOINT}/stealth?token=${encodeURIComponent(API_KEY!)}&solveCaptchas=true&replay=true`, {
    timeout: 60_000,
  });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  const apiHits: PriceHit[] = [];
  const apiErrors: string[] = []; // e.g. 435 = Target's bot block on its redsky price API
  page.on("response", async (res: Response) => {
    if (!res.url().includes("redsky.target.com")) return;
    if (!res.ok()) {
      apiErrors.push(`${res.status()} ${new URL(res.url()).pathname.split("/").pop()}`);
      return;
    }
    try {
      findPrices(await res.json(), new URL(res.url()).pathname, apiHits);
    } catch {
      // non-JSON response
    }
  });

  try {
    let productUrl = input;
    if (!/^https?:\/\//.test(input)) {
      const searchUrl = `https://www.target.com/s?searchTerm=${encodeURIComponent(input)}`;
      console.log(`Searching: ${searchUrl}`);
      const res = await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const blocked = await blockSignal(page, res?.status());
      if (blocked) throw new Error(`Blocked on search page (${blocked})`);
      const link = page.locator('a[href*="/p/"][href*="/-/A-"]').first();
      await link.waitFor({ timeout: 20_000 }).catch(() => {});
      const href = await link.getAttribute("href").catch(() => null);
      if (!href) {
        const snippet = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 400);
        throw new Error(`No product results on search page. Title: "${await page.title()}". Body: ${snippet}`);
      }
      productUrl = new URL(href, "https://www.target.com").toString();
    }

    console.log(`Product: ${productUrl}`);
    apiHits.length = 0; // only keep prices fetched for the product page itself
    apiErrors.length = 0;
    const res = await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const priceEl = page.locator('[data-test="product-price"]').first();
    await priceEl.waitFor({ timeout: 20_000 }).catch(() => {});
    // Checked after the wait: Target renders its "unavailable" block page client-side with a 200,
    // or renders the page shell but rejects the redsky price API calls (HTTP 435).
    const blocked =
      (await blockSignal(page, res?.status())) ??
      (apiErrors.length && !apiHits.length ? `redsky API rejected: ${[...new Set(apiErrors)].join(", ")}` : null);
    const domText = await priceEl.innerText().catch(() => null);
    const title = await page
      .locator('h1[data-test="product-title"]')
      .first()
      .innerText()
      .catch(() => null);

    const hits: PriceHit[] = [];
    if (domText) {
      const n = parsePrice(domText);
      if (n !== null) hits.push({ source: "dom", price: n, detail: domText.trim() });
    }
    hits.push(...apiHits);
    const pageText = hits.length
      ? undefined
      : (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 500);

    console.log(
      JSON.stringify(
        {
          input,
          url: page.url(),
          httpStatus: res?.status() ?? null,
          blocked,
          title,
          price: hits[0]?.price ?? null,
          hits,
          pageText,
        },
        null,
        2,
      ),
    );
    if (!hits.length) process.exitCode = 2;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
