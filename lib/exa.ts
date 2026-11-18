import { z } from "zod";

// Thin, typed wrapper over the three Exa endpoints this app uses. Server-only:
// the API key never reaches the client.
const EXA_BASE = "https://api.exa.ai";

const productEntitySchema = z.object({
  type: z.literal("product"),
  properties: z
    .object({
      name: z.string().nullish(),
      identifiers: z.object({ gtin: z.string().nullish() }).nullish(),
      offer: z
        .object({
          price: z.object({ amount: z.number(), currency: z.string().nullish() }).nullish(),
          availability: z.string().nullish(),
          seller: z.object({ name: z.string().nullish() }).nullish(),
        })
        .nullish(),
    })
    .passthrough(),
});

const resultSchema = z.object({
  url: z.string(),
  title: z.string().nullish(),
  text: z.string().nullish(),
  publishedDate: z.string().nullish(),
  entities: z.array(z.unknown()).nullish(),
});

const costSchema = z.object({ total: z.number() }).nullish();

export type ExaResult = {
  url: string;
  title: string;
  text: string;
  /** Structured product data Exa extracted from the page, when available. */
  product: {
    name: string | null;
    gtin: string | null;
    price: number | null;
    availability: string | null;
    seller: string | null;
  } | null;
};

export type ExaResponse = { results: ExaResult[]; costUsd: number };

function toResult(raw: z.infer<typeof resultSchema>): ExaResult {
  const entity = (raw.entities ?? [])
    .map((e) => productEntitySchema.safeParse(e))
    .find((p) => p.success)?.data;
  const p = entity?.properties;
  return {
    url: raw.url,
    title: raw.title ?? "",
    text: raw.text ?? "",
    product: p
      ? {
          name: p.name ?? null,
          gtin: p.identifiers?.gtin ?? null,
          price: p.offer?.price?.amount ?? null,
          availability: p.offer?.availability ?? null,
          seller: p.offer?.seller?.name ?? null,
        }
      : null,
  };
}

async function exaPost(path: string, body: unknown, attempt = 0): Promise<unknown> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) throw new Error("EXA_API_KEY is not set");
  const res = await fetch(`${EXA_BASE}${path}`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500));
    return exaPost(path, body, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Exa ${path} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

/** Max age of cached page content before Exa re-crawls it live. Prices move, so keep this short. */
const maxAgeHours = Number(process.env.EXA_MAX_AGE_HOURS ?? 24);

export async function searchDomain(query: string, domain: string, numResults = 10): Promise<ExaResponse> {
  const raw = z
    .object({ results: z.array(resultSchema), costDollars: costSchema })
    .parse(
      await exaPost("/search", {
        query,
        type: "auto",
        numResults,
        includeDomains: [domain],
        contents: { text: { maxCharacters: 4000 }, maxAgeHours },
      }),
    );
  return { results: raw.results.map(toResult), costUsd: raw.costDollars?.total ?? 0 };
}

export async function getContents(urls: string[]): Promise<ExaResponse> {
  const raw = z
    .object({
      results: z.array(resultSchema),
      statuses: z.array(z.object({ id: z.string(), status: z.string() })).nullish(),
      costDollars: costSchema,
    })
    .parse(
      await exaPost("/contents", {
        urls,
        text: { maxCharacters: 4000 },
        maxAgeHours,
      }),
    );
  return { results: raw.results.map(toResult), costUsd: raw.costDollars?.total ?? 0 };
}

const deepOutputSchema = z.object({
  content: z.object({
    found: z.boolean(),
    priceUsd: z.number().nullish(),
    productTitle: z.string().nullish(),
    sourceUrl: z.string().nullish(),
  }),
  grounding: z
    .array(
      z.object({
        field: z.string(),
        citations: z.array(z.object({ url: z.string(), title: z.string().nullish() })),
        confidence: z.string().nullish(),
      }),
    )
    .nullish(),
});

export type DeepPriceResult = z.infer<typeof deepOutputSchema>["content"] & {
  citations: string[];
  confidence: string | null;
  costUsd: number;
};

/**
 * Fallback for retailers whose product pages don't expose a price to crawlers
 * (Target renders prices client-side). Exa's deep search reads across the web
 * — including retailer-affiliated feeds — and returns a grounded, structured answer.
 */
export async function deepSearchPrice(
  retailer: { name: string; domain: string },
  title: string,
  upc: string,
): Promise<DeepPriceResult> {
  const raw = z
    .object({ output: deepOutputSchema.nullish(), costDollars: costSchema })
    .parse(
      await exaPost("/search", {
        query: `${title} ${retailer.name} price`,
        type: "deep",
        numResults: 8,
        // The retailer's own pages carry no price for crawlers, so make deep search read sources that do
        // (e.g. Shipt / Instacart storefronts for that retailer, shopping aggregators, UPC databases).
        excludeDomains: [retailer.domain],
        outputSchema: {
          type: "object",
          description: `The current price ${retailer.name} charges for this exact product (UPC ${upc}), e.g. from ${retailer.name} listings on Shipt, Instacart or shopping aggregators. Set found=false if no ${retailer.name} price for this exact product and size is shown.`,
          properties: {
            found: { type: "boolean" },
            priceUsd: { type: "number", description: `${retailer.name} price in USD for one unit` },
            productTitle: { type: "string" },
            sourceUrl: { type: "string" },
          },
          required: ["found"],
        },
      }),
    );
  const priceGrounding = raw.output?.grounding?.find((g) => g.field === "priceUsd");
  return {
    found: raw.output?.content.found ?? false,
    priceUsd: raw.output?.content.priceUsd ?? null,
    productTitle: raw.output?.content.productTitle ?? null,
    sourceUrl: raw.output?.content.sourceUrl ?? null,
    citations: priceGrounding?.citations.map((c) => c.url) ?? [],
    confidence: priceGrounding?.confidence ?? null,
    costUsd: raw.costDollars?.total ?? 0,
  };
}
