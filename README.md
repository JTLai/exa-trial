# Retail Price Tracker

Tracks online prices for a fixed assortment of grocery SKUs across five retailers — Walmart, Target, Amazon, Walgreens, Kroger — using [Exa](https://exa.ai) search + contents APIs, with OpenAI for price extraction. Built for comparing Exa-based retrieval against browser-automation scrapers.

**Stack:** Next.js (App Router) · TypeScript · Tailwind CSS · shadcn/ui · Vercel AI SDK (OpenAI) · Zod · SQLite (better-sqlite3) · Drizzle ORM · npm

## What it does

- **Price matrix (`/`)** — one row per SKU, one column per retailer. Shows price, promo, availability, and match quality (exact UPC vs. different pack size, with pack-ratio normalization). Per-retailer price index vs. the cross-retailer median. Expand a row for observation history; export to CSV.
- **Refresh runs** — a run looks up every SKU × retailer in the background (~20 min, roughly $5 of Exa + OpenAI usage for the full matrix). Prices fill in live via polling.
- **Eval (`/eval`)** — scores the latest Exa-based observation per cell against a hand-verified golden set (`data/golden-set.json`) on price accuracy and freshness.
- **Browser-Use (`/browser-use`)** — re-tries the golden-set items Exa got wrong with two browser-automation tools (Browserless Smart Scrape, Firecrawl Interact) and scores them against the same golden prices.

## Quick start

```bash
npm install
cp .env.example .env.local   # then fill in your keys
npm run db:push              # creates local.db with the schema
npm run dev                  # http://localhost:3000
```

The SKU list in `data/skus.json` is seeded into SQLite on first load.

## Setup

### 1. Prerequisites

- **Node.js 24 LTS** recommended (22.12+ minimum; check with `node --version`). An `.nvmrc` is included, so `nvm use` / `fnm use` picks the right version.
- **npm 10+** (ships with Node)

SQLite is embedded via `better-sqlite3` (prebuilt binaries) — no Docker, no external database.

### 2. Configure API keys

```bash
cp .env.example .env.local
```

| Variable | Required | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | yes | LLM price extraction from retrieved page text |
| `EXA_API_KEY` | yes | Domain search, contents, and deep-search fallback |
| `BROWSERLESS_API_KEY` | Browser-Use tab | Browserless Smart Scrape |
| `FIRECRAWL_API_KEY` | Browser-Use tab | Firecrawl Interact |

Optional tuning variables:

- `AI_MODEL` — OpenAI model ID (default `gpt-5.1`)
- `DATABASE_PATH` — SQLite file location (default `local.db`)
- `EXA_MAX_AGE_HOURS` — max age of Exa page contents (default `24`)
- `PRICE_CONCURRENCY`, `BROWSERLESS_CONCURRENCY`, `FIRECRAWL_CONCURRENCY` — lookup parallelism
- `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET` + `KROGER_LOCATION_ID` or `KROGER_ZIP` — when set, Kroger prices come from Kroger's Products API for one pinned store instead of Exa (Kroger has no national price, and Exa's crawler lands on a store we can't choose)

`.env.local` is gitignored; keys are only read on the server.

### 3. Initialize SQLite

```bash
npm run db:push
```

Creates `local.db` (gitignored) and syncs it to `lib/db/schema.ts`. Re-run after schema changes — push is fine, this is a prototype. `npm run db:studio` opens a browser UI to inspect the data.

## Validation and build

```bash
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit
npm run test        # Vitest
npm run build       # production build
```

## Project layout

```
app/
  page.tsx                  # price matrix UI
  eval/page.tsx             # Eval tab (Exa vs. golden set)
  browser-use/page.tsx      # Browser-Use tab (Browserless/Firecrawl vs. golden set)
  api/prices/route.ts       # matrix data + CSV export
  api/runs/route.ts         # start/poll refresh runs
  api/history/route.ts      # observation history for one UPC
  api/eval/route.ts         # eval scoring
  api/browser-use/route.ts  # browser-tool retries
lib/
  ai.ts                     # model setup + LLM calls (server-side only)
  exa.ts                    # Exa API wrapper (search, contents, deep search)
  pricing.ts                # per SKU × retailer lookup pipeline + background runs
  retailers.ts              # retailer config + price basis
  eval.ts                   # golden-set scoring
  browser-use.ts            # Browserless/Firecrawl retries of Exa misses
  insights.ts               # price index vs. median, CSV export
  kroger.ts                 # Kroger Products API (optional, one pinned store)
  upc.ts, size.ts           # UPC/GTIN matching, pack-size normalization
  db/schema.ts              # skus, runs, observations, browser_checks
data/
  skus.json                 # tracked assortment (seeded on first load)
  golden-set.json           # hand-verified eval set
tests/                      # Vitest
scripts/target-browserless.mts  # Target scrape experiment (npm run target:browserless)
```

## Notes

- **Price basis.** Every observation records `priceBasis`: `online` (national ship-to-home) or `kroger:<storeId>` (Kroger has no national price). Only same-basis prices are compared — Kroger-via-Exa (`kroger:exa-default`) doesn't count against Kroger-via-API and vice versa.
- **Target** hides prices from crawlers and bot-blocks headless browsers, so Target prices come from Exa deep search and are flagged `third_party`.
- **Costs.** A full refresh is ~$5 of Exa usage plus OpenAI tokens; the UI confirms before starting one.
