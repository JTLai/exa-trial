import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import { browserChecks, BROWSER_TOOLS, type BrowserCheck, type BrowserTool, type Observation } from "./db/schema";
import { scoreItem, type EvalRow, type GoldenItem, type Outcome } from "./eval";
import { RETAILERS } from "./retailers";

// Browser-Use tab: re-tries the golden-set items Exa got wrong with two browser-automation
// products (Browserless Smart Scrape, Firecrawl Interact), each using its own AI extraction,
// and scores them against the same golden prices as the Eval tab.

const CORRECT: Outcome[] = ["exact", "correct_absent"];
/** Free tiers: Browserless allows one session at a time, Firecrawl two concurrent jobs (scrape + interact = one check). */
const CONCURRENCY: Record<BrowserTool, number> = {
  browserless: Number(process.env.BROWSERLESS_CONCURRENCY ?? 1),
  firecrawl: Number(process.env.FIRECRAWL_CONCURRENCY ?? 1),
};
const STALE_MS = 10 * 60_000;

/** Eval rows where what the tracker shows isn't the golden answer. */
export const exaMisses = (rows: EvalRow[]) => rows.filter((r) => !CORRECT.includes(r.outcome));

export type ToolRead = {
  status: "priced" | "no_price" | "error";
  price: number | null;
  productTitle: string | null;
  availability: "in_stock" | "out_of_stock" | "unknown";
  notes: string | null;
  detail: string | null;
};

const readSchema = z.object({
  price: z.number().positive().nullable().catch(null),
  productTitle: z.string().nullable().catch(null),
  inStock: z.boolean().nullable().catch(null),
  notes: z.string().nullable().catch(null),
});

const JSON_SCHEMA = {
  type: "object",
  properties: {
    price: { type: ["number", "null"], description: "Current one-time purchase price in USD of the matching listing, or null" },
    productTitle: { type: ["string", "null"] },
    inStock: { type: ["boolean", "null"] },
    notes: { type: "string" },
  },
  required: ["price", "productTitle", "inStock", "notes"],
};

export function extractionPrompt(retailer: string, title: string, upc: string) {
  return `Find the current ${retailer} online price for this product: "${title}" (UPC ${upc}).
If this is a search or results page, use only a result that is this exact product (same brand, line and size); if there is none, price is null.
Return the one-time purchase price shown for the listing (not subscribe & save, not per-unit, not a different product or a marketplace bundle). If the listing is a different pack size than the product above, still return the listing's price and say so in notes. Never guess a price that isn't on the page.`;
}

function toRead(raw: unknown, detail: string): ToolRead {
  const r = readSchema.safeParse(raw);
  if (!r.success) return { status: "error", price: null, productTitle: null, availability: "unknown", notes: "Unparseable extraction", detail };
  const { price, productTitle, inStock, notes } = r.data;
  return {
    status: price != null ? "priced" : "no_price",
    price,
    productTitle,
    availability: inStock == null ? "unknown" : inStock ? "in_stock" : "out_of_stock",
    notes,
    detail,
  };
}

/** Pulls the first JSON object out of an agent's free-text answer, falling back to the first "$x.xx". */
export function parseAgentOutput(text: string): unknown {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      // fall through
    }
  }
  const price = text.replace(/,/g, "").match(/\$\s*(\d+(?:\.\d{1,2})?)/)?.[1];
  return { price: price ? Number(price) : null, productTitle: null, inStock: null, notes: text.slice(0, 300) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POSTs JSON, backing off on 429 (both free tiers cap concurrency and requests per minute). */
async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const json = await res.json().catch(() => null);
    if (res.status === 429 && attempt < 6) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 10_000 * attempt);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)?.slice(0, 200) ?? ""}`);
    return json;
  }
}

/** Browserless Smart Scrape: escalates fetch → proxy → stealth browser → captcha, then AI-extracts JSON. */
export async function browserlessRead(url: string, prompt: string): Promise<ToolRead> {
  const key = process.env.BROWSERLESS_API_KEY;
  if (!key) throw new Error("BROWSERLESS_API_KEY is not set");
  const endpoint = process.env.BROWSERLESS_HTTP_ENDPOINT ?? "https://production-sfo.browserless.io";
  const body = await postJson(
    `${endpoint}/smart-scrape?timeout=120000`,
    { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    // onlyMainContent strips the buy box on retailer pages, so keep the whole page.
    { url, formats: ["json"], jsonOptions: { prompt, schema: JSON_SCHEMA }, onlyMainContent: false, waitFor: 3000 },
    150_000,
  );
  const detail = `${body.strategy ?? "?"} · HTTP ${body.statusCode ?? "?"}${body.attempted?.length ? ` · tried ${body.attempted.join(" → ")}` : ""}`;
  if (!body.ok) throw new Error(`${body.message ?? "Smart Scrape failed"} (${detail})`);
  if (!body.json) throw new Error(`${body.warning ?? "No extraction returned"} (${detail})`);
  return toRead(body.json, detail);
}

/** Firecrawl: scrape the page, then hand the live browser session to the Interact agent with the prompt. */
export async function firecrawlRead(url: string, prompt: string): Promise<ToolRead> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error("FIRECRAWL_API_KEY is not set");
  const base = "https://api.firecrawl.dev/v2/scrape";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  const scrape = await postJson(base, headers, { url, formats: ["markdown"], onlyMainContent: false }, 90_000);
  const meta = scrape?.data?.metadata ?? {};
  const scrapeId: string | undefined = meta.scrapeId;
  if (!scrapeId) throw new Error(`Scrape returned no scrapeId: ${scrape?.error ?? "unknown error"}`);
  try {
    const run = await postJson(
      `${base}/${scrapeId}/interact`,
      headers,
      {
        prompt: `${prompt}\nReply with JSON only: {"price": number|null, "productTitle": string|null, "inStock": boolean|null, "notes": string}`,
        timeout: 120,
      },
      150_000,
    );
    const detail = `scrape HTTP ${meta.statusCode ?? "?"}${meta.creditsUsed != null ? ` · ${meta.creditsUsed} scrape credits` : ""}`;
    if (!run.success || !run.output) {
      const why = run.error || run.stderr || (run.killed ? "Agent timed out" : "Interact returned no answer");
      throw new Error(`${why} (${detail}, exit ${run.exitCode ?? "?"})`);
    }
    return toRead(parseAgentOutput(String(run.output)), detail);
  } finally {
    // Interact sessions bill while open.
    await fetch(`${base}/${scrapeId}/interact`, { method: "DELETE", headers }).catch(() => {});
  }
}

const READERS: Record<BrowserTool, (url: string, prompt: string) => Promise<ToolRead>> = {
  browserless: browserlessRead,
  firecrawl: firecrawlRead,
};

/** The tool reads the listing as shown; normalize to the SKU's pack the same way the golden set did. */
export function normalizeToSku(item: GoldenItem, price: number): { price: number; normalized: boolean } {
  const { listedPrice, packRatio } = item.expected;
  if (listedPrice != null && packRatio && Math.abs(price - listedPrice) / listedPrice <= 0.05) {
    return { price: Math.round((price / packRatio) * 100) / 100, normalized: true };
  }
  return { price, normalized: false };
}

export type ToolScore = { check: BrowserCheck; outcome: Outcome | "error" | "running"; skuPrice: number | null; normalized: boolean; errorPct: number | null };

export function scoreCheck(item: GoldenItem, check: BrowserCheck): ToolScore {
  if (check.status === "running" || check.status === "error") {
    return { check, outcome: check.status, skuPrice: null, normalized: false, errorPct: null };
  }
  const n = check.price != null ? normalizeToSku(item, check.price) : null;
  // A cloud browser lands on its own Kroger store, so its Kroger prices aren't the golden store's.
  const priceBasis = item.retailer === "kroger" ? `kroger:${check.tool}-default` : "online";
  const obs = {
    retailer: item.retailer,
    status: check.status,
    price: n?.price ?? null,
    availability: check.availability,
    priceBasis,
    source: "retailer_page",
    url: check.url,
    observedAt: check.finishedAt ?? check.startedAt,
  } as Observation;
  const s = scoreItem(item, obs, new Date());
  return { check, outcome: s.outcome, skuPrice: n?.price ?? null, normalized: n?.normalized ?? false, errorPct: s.errorPct };
}

// ---------------------------------------------------------------------------
// Runs: one row per (item × tool), inserted as "running" and filled in when the tool answers.

export function markStale() {
  db.update(browserChecks)
    .set({ status: "error", notes: "Interrupted (server restarted?)", finishedAt: new Date() })
    .where(and(eq(browserChecks.status, "running"), lt(browserChecks.startedAt, new Date(Date.now() - STALE_MS))))
    .run();
}

export function startChecks(cases: { item: GoldenItem; title: string }[], tools: BrowserTool[] = [...BROWSER_TOOLS]) {
  const jobs = tools.flatMap((tool) =>
    cases.map(({ item, title }) => {
      const row = db
        .insert(browserChecks)
        .values({ upc: item.upc, retailer: item.retailer, tool, status: "running", url: item.url })
        .returning()
        .get();
      return { id: row.id, tool, url: item.url, prompt: extractionPrompt(RETAILERS[item.retailer].name, title, item.upc) };
    }),
  );
  return { count: jobs.length, run: () => Promise.all(tools.map((t) => runQueue(jobs.filter((j) => j.tool === t)))) };
}

async function runQueue(jobs: { id: number; tool: BrowserTool; url: string; prompt: string }[]) {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const t0 = Date.now();
      // Queued checks wait their turn; the clock (and staleness) starts when the tool is called.
      db.update(browserChecks).set({ startedAt: new Date(t0) }).where(eq(browserChecks.id, job.id)).run();
      let read: ToolRead;
      try {
        read = await READERS[job.tool](job.url, job.prompt);
      } catch (error) {
        console.error(`${job.tool} failed for ${job.url}:`, error);
        const msg = error instanceof Error ? (error.name === "TimeoutError" ? "Timed out" : error.message) : "Unknown error";
        read = { status: "error", price: null, productTitle: null, availability: "unknown", notes: (msg || "Unknown error").slice(0, 400), detail: null };
      }
      db.update(browserChecks)
        .set({ ...read, durationMs: Date.now() - t0, finishedAt: new Date() })
        .where(eq(browserChecks.id, job.id))
        .run();
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs[0] ? CONCURRENCY[jobs[0].tool] : 0, jobs.length) }, worker));
}
