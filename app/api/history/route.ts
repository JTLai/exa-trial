import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { observations, skus } from "@/lib/db/schema";
import { enforceExactSku } from "@/lib/insights";

export async function GET(request: Request) {
  const upc = new URL(request.url).searchParams.get("upc");
  if (!upc) return NextResponse.json({ error: "upc is required" }, { status: 400 });
  const sku = db.select().from(skus).where(eq(skus.upc, upc)).get();
  const rows = db
    .select()
    .from(observations)
    .where(and(eq(observations.upc, upc)))
    .orderBy(desc(observations.observedAt), desc(observations.id))
    .limit(200)
    .all();
  return NextResponse.json(sku ? rows.map((o) => enforceExactSku(o, sku)) : rows);
}
