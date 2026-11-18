import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { observations, skus } from "@/lib/db/schema";
import { buildRows, latestByKey, summarizeRetailers, toCsv } from "@/lib/insights";
import { activeRun } from "@/lib/pricing";
import { ensureSkus } from "@/lib/skus";

export async function GET(request: Request) {
  ensureSkus();
  const skuList = db.select().from(skus).orderBy(skus.brand, skus.title).all();
  const obs = db.select().from(observations).orderBy(desc(observations.observedAt), desc(observations.id)).all();
  const rows = buildRows(skuList, latestByKey(obs));

  if (new URL(request.url).searchParams.get("format") === "csv") {
    return new Response(toCsv(rows), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="retail-prices-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }
  return NextResponse.json({ rows, retailers: summarizeRetailers(rows), activeRun: activeRun() ?? null });
}
