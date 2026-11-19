# AI Prototype Starter

A minimal, reliable starter for building small AI-powered web apps fast — designed for time-boxed settings like a two-hour product or coding interview.

**Stack:** Next.js (App Router) · TypeScript · Tailwind CSS · shadcn/ui · Vercel AI SDK (OpenAI) · Zod · SQLite (better-sqlite3) · Drizzle ORM · npm

**Sample feature:** a Text Analyzer. Paste text → a server-side OpenAI call returns a structured `{ summary, sentiment, topics }` object (validated with Zod) → the result is stored in SQLite and rendered in the UI with loading and error states. It exists to demonstrate the full loop and is intentionally easy to delete.

## Quick start

```bash
npm install
cp .env.example .env.local   # then paste your OpenAI API key
npm run db:push              # creates local.db with the schema
npm run dev                  # http://localhost:3000
```

## Setup on a new machine

### 1. Prerequisites

- **Node.js 24 LTS** recommended (22.12+ minimum; check with `node --version`). An `.nvmrc` is included, so `nvm use` / `fnm use` picks the right version.
- **npm 10+** (ships with Node)
- An **OpenAI API key** — create one at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)

Nothing else. SQLite is embedded via `better-sqlite3`, which ships prebuilt binaries for macOS, Linux, and Windows inside the package — no separate database install, no Docker, no compile step.

### 2. Install dependencies

```bash
npm install
```

The lockfile (`package-lock.json`) is committed, so installs are reproducible.

> Only `esbuild` and `unrs-resolver` need install scripts; they're pre-approved in `package.json` (`allowScripts`). If npm warns about `fsevents`, you can ignore it — it ships a prebuilt binary.

### 3. Configure the API key

```bash
cp .env.example .env.local
```

Edit `.env.local` and set `OPENAI_API_KEY`. Optional variables:

- `AI_MODEL` — OpenAI model ID (default `gpt-5.1`)
- `DATABASE_PATH` — SQLite file location (default `local.db` in the project root)
- `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET` — free credentials from developer.kroger.com. When set, Kroger prices come from Kroger's Products API for one pinned store instead of from Exa (Kroger has no national price, and Exa's crawler lands on a store we can't choose).
- `KROGER_LOCATION_ID` or `KROGER_ZIP` — the Kroger reference store (by ID, or the nearest Kroger to a zip). Required with the credentials above.

`.env.local` is gitignored; the key is only ever read on the server.

### 4. Initialize SQLite

```bash
npm run db:push
```

This creates `local.db` (gitignored) and syncs it to the schema in `lib/db/schema.ts`. Re-run it any time you change the schema. `npm run db:studio` opens a browser UI to inspect the data.

### 5. Start the dev server

```bash
npm run dev
```

Open http://localhost:3000, paste some text, and click **Analyze** to verify the full loop (UI → API route → OpenAI → Zod validation → SQLite → UI).

### 6. Validation and production build

```bash
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit
npm run test        # Vitest (schema + DB round-trip tests, no API key needed)
npm run build       # production build
npm run start       # serve the production build
```

## Project layout

```
app/
  page.tsx                  # sample UI (form, loading, error, results)
  layout.tsx                # root layout
  api/analyses/route.ts     # sample API route: GET list, POST analyze+store
lib/
  ai.ts                     # model setup + analyzeText() — ALL LLM calls live here
  db/
    schema.ts               # Drizzle table definitions
    index.ts                # SQLite connection + Drizzle client
components/ui/              # shadcn/ui components (add more: npx shadcn add <name>)
tests/                      # Vitest tests
drizzle.config.ts           # Drizzle Kit config (db:push / db:studio)
.env.example                # environment template
AGENTS.md / CLAUDE.md       # guidance for AI coding agents
```

| Concern  | File |
|----------|------|
| Frontend | `app/page.tsx` |
| AI calls | `lib/ai.ts` |
| Zod schemas | `lib/ai.ts` (LLM output), `app/api/analyses/route.ts` (request body) |
| API | `app/api/analyses/route.ts` |
| Database | `lib/db/schema.ts`, `lib/db/index.ts` |

## Replacing the sample feature during an interview

The Text Analyzer is a template for the pattern *submit → LLM → validate → store → display*. To build your own feature:

1. **Schema** — replace the `analyses` table in `lib/db/schema.ts` with your table(s), then `npm run db:push`. (If the old table shape conflicts, just delete `local.db` and push again — it's throwaway data.)
2. **AI** — in `lib/ai.ts`, replace `analysisSchema` and `analyzeText()` with your Zod schema and a `generateText` call with `output: Output.object({ schema })` (or `streamText` for streaming, or plain `generateText` for free-form text). Keep all LLM calls in this file.
3. **API** — rename/replace `app/api/analyses/route.ts`. The existing route shows the shape: validate the request body with Zod → call the AI helper → write with Drizzle → return JSON with proper status codes.
4. **UI** — rewrite `app/page.tsx`. Reuse the existing loading/error/list patterns and the shadcn components in `components/ui/`.
5. **Tests** — update `tests/` to cover your new Zod schema and table.

Delete freely — nothing outside those files depends on the sample.

## Troubleshooting

- **`Could not load past analyses` in the UI / `no such table: analyses`** — you haven't run `npm run db:push` yet.
- **500 "Analysis failed" on submit** — usually a missing/invalid `OPENAI_API_KEY` in `.env.local`. Check the terminal running `npm run dev` for the underlying error. Restart the dev server after editing env files.
- **`better-sqlite3` errors on install or import** (e.g. `Could not locate the bindings file`) — the native module didn't build. Run `npm rebuild better-sqlite3`; make sure install scripts weren't blocked (see step 2).
- **Node version errors or `EBADENGINE` warnings** — switch to Node 24 LTS (`nvm use` reads `.nvmrc`). Node 22.12+ also works.
- **Schema change not reflected** — run `npm run db:push` again; for destructive changes on throwaway data, delete `local.db*` and push.
- **Port 3000 in use** — `npm run dev -- -p 3001`.

## Deliberate non-goals

No auth, no Docker, no Postgres, no agent frameworks, no workflow orchestration, no tracing platforms. Add them only if your project actually needs them.
