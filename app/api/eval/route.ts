import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { observations, skus } from "@/lib/db/schema";
import { runEval } from "@/lib/eval";
import { latestByKey } from "@/lib/insights";
import { activeRun } from "@/lib/pricing";
import { ensureSkus } from "@/lib/skus";

export async function GET() {
  ensureSkus();
  const skuList = db.select().from(skus).all();
  const obs = db.select().from(observations).orderBy(desc(observations.observedAt), desc(observations.id)).all();
  const result = runEval(skuList, latestByKey(obs));
  const goldAgeDays = (Date.now() - new Date(result.set.verifiedAt).getTime()) / 86_400_000;
  return NextResponse.json({ ...result, goldAgeDays, activeRun: activeRun() ?? null });
}
