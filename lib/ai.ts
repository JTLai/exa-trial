import { openai } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { z } from "zod";

// All LLM calls go through this module so swapping models or providers is a
// one-line change. The OpenAI provider reads OPENAI_API_KEY from the env.
export const model = openai(process.env.AI_MODEL ?? "gpt-5.1");

export const priceExtractionSchema = z.object({
  matchedIndex: z
    .number()
    .int()
    .nullable()
    .describe("Index of the candidate page that sells the target SKU, or null if none does"),
  matchType: z
    .enum(["exact", "different_size", "not_found"])
    .describe(
      "exact = same product, size and pack count; different_size = same product line but a different size/count/pack; not_found = no candidate sells it",
    ),
  price: z
    .number()
    .positive()
    .nullable()
    .describe("Current one-time purchase price in USD for one unit, as shown on the page. Not subscribe & save, not per-oz."),
  regularPrice: z
    .number()
    .positive()
    .nullable()
    .describe("Regular / strike-through price if the page shows the item on sale, else null"),
  promo: z.string().nullable().describe("Short promo text if any (e.g. 'Rollback', 'BOGO 50%'), else null"),
  availability: z.enum(["in_stock", "out_of_stock", "unknown"]),
  confidence: z.enum(["high", "medium", "low"]),
  notes: z.string().describe("One short sentence explaining the match and any caveats"),
});

export type PriceExtraction = z.infer<typeof priceExtractionSchema>;

export type PriceCandidate = {
  url: string;
  title: string;
  text: string;
  gtinMatch: boolean;
  structured: { gtin: string | null; price: number | null; availability: string | null; seller: string | null } | null;
};

export async function extractPrice(input: {
  retailerName: string;
  upc: string;
  title: string;
  candidates: PriceCandidate[];
}): Promise<PriceExtraction> {
  const pages = input.candidates
    .map(
      (c, i) => `<candidate index="${i}">
url: ${c.url}
page title: ${c.title}
upc_verified: ${c.gtinMatch ? "YES - the page's GTIN/URL matches the target UPC" : "no"}
structured data: ${c.structured ? JSON.stringify(c.structured) : "none"}
page text:
${c.text.slice(0, 3500)}
</candidate>`,
    )
    .join("\n\n");

  const { output } = await generateText({
    model,
    output: Output.object({ schema: priceExtractionSchema }),
    providerOptions: { openai: { reasoningEffort: "low" } },
    prompt: `You are a retail pricing analyst. Find the current ${input.retailerName} price for this exact SKU.

SKU to find:
- UPC: ${input.upc}
- Title: ${input.title}

Rules:
- A candidate with upc_verified=YES is the right product even if its title wording differs; prefer it.
- When several candidates match, prefer the listing sold by ${input.retailerName} itself over third-party marketplace sellers.
- Otherwise match on brand, product line, size (fl oz / mL / ct) and pack count (e.g. "2 x" twin packs). If only a different size or pack is listed, use matchType "different_size".
- Ignore search/category/review/Q&A pages, third-party marketplace bundles of multiple units, and "pack of N" listings unless the SKU is that pack.
- Price is the price a shopper pays now for a one-time purchase. Ignore per-unit prices ("$x/fl oz"), subscribe & save, and prices of other products on the page.
- If page text and structured data disagree, prefer the price shown in the page text and lower your confidence.
- Never guess a price that isn't on the page. If the page doesn't show one, return price null.

${pages}`,
  });
  return output;
}

/** Guard against hallucination: the extracted price must appear on the page or in its structured data. */
export function priceAppearsOnPage(price: number, candidate: Pick<PriceCandidate, "text" | "structured">): boolean {
  if (candidate.structured?.price === price) return true;
  const [dollars, cents] = price.toFixed(2).split(".");
  // Matches "$22.99", "22.99", and Amazon-style split rendering "$22 99" / "$ 22. 99".
  const pattern = new RegExp(`(^|[^\\d])${dollars}\\s?[.\\s]\\s?${cents}(?!\\d)`);
  return pattern.test(candidate.text);
}
