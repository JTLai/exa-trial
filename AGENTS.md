<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# AI Prototype Starter

A minimal Next.js starter for building small AI-powered apps quickly (e.g. during a two-hour interview). Optimize for speed of iteration and reliability, not architecture.

## Principles

- **Keep it simple.** No new abstractions, layers, or dependencies unless the task truly needs them. Prefer editing the existing files over creating parallel structures.
- **Keep it reliable.** Everything runs locally: SQLite file database, no Docker, no external services beyond the OpenAI API. Don't introduce infrastructure.
- **Server-side LLM calls only.** All AI calls go through `lib/ai.ts`; the API key never reaches the client.
- **Validate LLM output with Zod.** Use `generateText` with `output: Output.object({ schema })` (see `lib/ai.ts`) so responses are typed and validated. `generateObject` is deprecated in AI SDK 7 — don't use it.

## Where things live

- `lib/ai.ts` — model setup + all LLM calls (Vercel AI SDK, OpenAI provider)
- `lib/db/schema.ts` — Drizzle table definitions (single source of truth for DB shape)
- `lib/db/index.ts` — SQLite connection + Drizzle client
- `lib/exa.ts` — Exa API wrapper (domain search, contents, deep-search fallback)
- `lib/pricing.ts` — per SKU × retailer lookup pipeline + background runs
- `lib/retailers.ts`, `lib/upc.ts` — retailer config, UPC/GTIN matching
- `lib/insights.ts` — price index vs. cross-retailer median, CSV export
- `data/skus.json` — tracked assortment (from the client's spreadsheet), seeded into SQLite on first load
- `app/api/{prices,runs,history}/route.ts` — API routes
- `app/page.tsx` — price matrix UI
- `components/ui/` — shadcn/ui primitives (generated; add more with `npx shadcn add <name>`)

## Workflow

- After changing `lib/db/schema.ts`, run `npm run db:push` (no migration files — push is fine for prototypes).
- Before declaring work done, run: `npm run lint && npm run typecheck && npm run test && npm run build`.
- Target hides prices from crawlers and bot-blocks headless browsers, so Target prices come from Exa deep search and are flagged third-party. Don't add CAPTCHA solving or stealth browsing.

## Git management
- Do NOT create any commits automatically. Focus on making just the necessary code change and testing when applicable.