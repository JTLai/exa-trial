import { desc, eq } from "drizzle-orm";
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { exaMisses, markStale, scoreCheck, startChecks, type ToolScore } from "@/lib/browser-use";
import { db } from "@/lib/db";
import { browserChecks, BROWSER_TOOLS, observations, skus, type BrowserTool } from "@/lib/db/schema";
import { runEval } from "@/lib/eval";
import { latestByKey } from "@/lib/insights";
import { RETAILER_IDS } from "@/lib/retailers";
import { ensureSkus } from "@/lib/skus";

function misses() {
  ensureSkus();
  const skuList = db.select().from(skus).all();
  const obs = db.select().from(observations).orderBy(desc(observations.observedAt), desc(observations.id)).all();
  return exaMisses(runEval(skuList, latestByKey(obs)).rows);
}

export async function GET() {
  markStale();
  const checks = db.select().from(browserChecks).orderBy(desc(browserChecks.startedAt), desc(browserChecks.id)).all();
  const latest = new Map<string, (typeof checks)[number]>();
  for (const c of checks) {
    const k = `${c.upc}|${c.retailer}|${c.tool}`;
    if (!latest.has(k)) latest.set(k, c);
  }
  const rows = misses().map((r) => {
    const tools = Object.fromEntries(
      BROWSER_TOOLS.map((t) => {
        const c = latest.get(`${r.item.upc}|${r.item.retailer}|${t}`);
        return [t, c ? scoreCheck(r.item, c) : null];
      }),
    ) as Record<BrowserTool, ToolScore | null>;
    return { ...r, tools };
  });
  const running = db.select({ id: browserChecks.id }).from(browserChecks).where(eq(browserChecks.status, "running")).all().length;
  return NextResponse.json({ rows, running });
}

const startSchema = z.object({
  tools: z.array(z.enum(BROWSER_TOOLS)).min(1).default([...BROWSER_TOOLS]),
  /** Only these cases; defaults to every Exa miss. */
  cells: z.array(z.object({ upc: z.string(), retailer: z.enum(RETAILER_IDS) })).optional(),
});

export async function POST(request: Request) {
  const parsed = startSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  markStale();
  if (db.select().from(browserChecks).where(eq(browserChecks.status, "running")).get()) {
    return NextResponse.json({ error: "A browser run is already in progress." }, { status: 409 });
  }
  const { cells, tools } = parsed.data;
  const cases = misses()
    .filter((r) => !cells?.length || cells.some((c) => c.upc === r.item.upc && c.retailer === r.item.retailer))
    .map((r) => ({ item: r.item, title: r.title }));
  if (!cases.length) return NextResponse.json({ error: "No Exa misses to check." }, { status: 400 });
  const { count, run } = startChecks(cases, tools);
  // Each check takes 20–90s; run after responding and let the UI poll.
  after(run);
  return NextResponse.json({ started: count }, { status: 202 });
}
