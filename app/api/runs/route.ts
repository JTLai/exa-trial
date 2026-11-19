import { desc } from "drizzle-orm";
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { runs } from "@/lib/db/schema";
import { activeRun, createRun, executeRun } from "@/lib/pricing";
import { RETAILER_IDS } from "@/lib/retailers";
import { ensureSkus } from "@/lib/skus";

const startRunSchema = z.object({
  upcs: z.array(z.string().regex(/^\d{8,14}$/)).max(500).optional(),
  retailers: z.array(z.enum(RETAILER_IDS)).min(1).default([...RETAILER_IDS]),
  /** Exact SKU × retailer pairs (e.g. the eval golden set); overrides upcs × retailers. */
  cells: z.array(z.object({ upc: z.string().regex(/^\d{8,14}$/), retailer: z.enum(RETAILER_IDS) })).max(500).optional(),
});

export async function GET() {
  const latest = db.select().from(runs).orderBy(desc(runs.id)).limit(10).all();
  return NextResponse.json({ active: activeRun() ?? null, recent: latest });
}

export async function POST(request: Request) {
  const parsed = startRunSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  if (activeRun()) {
    return NextResponse.json({ error: "A price refresh is already running." }, { status: 409 });
  }
  ensureSkus();
  const { run, tasks } = createRun(parsed.data.upcs, parsed.data.retailers, parsed.data.cells);
  if (tasks.length === 0) {
    return NextResponse.json({ error: "No matching SKUs." }, { status: 400 });
  }
  // Lookups take minutes; run them after responding and let the UI poll progress.
  after(() => executeRun(run.id, tasks));
  return NextResponse.json(run, { status: 202 });
}
